#!/usr/bin/env bun
/**
 * @file SQL モードの CLI エントリーポイント。PostgreSQL と連携した SELECT クエリ編集を
 * OpenAI Responses API のエージェントと SQL 専用ツールで実現する。
 */
import { createHash } from "node:crypto";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { z } from "zod";
import {
  buildRequest,
  computeContext,
  executeWithTools,
  extractResponseText,
  performCompact,
  prepareImageData,
} from "../session/chat-session.js";
import { createOpenAIClient } from "../core/openai.js";
import {
  READ_FILE_TOOL,
  SQL_DRY_RUN_TOOL,
  SQL_FETCH_SCHEMA_TOOL,
  SQL_FORMAT_TOOL,
  buildCliToolList,
  createToolRuntime,
} from "../core/tools.js";
import {
  expandLegacyShortFlags,
  parseEffortFlag,
  parseHistoryFlag,
  parseModelFlag,
  parseVerbosityFlag,
} from "../core/options.js";
import { bootstrapCli } from "./runtime/runner.js";
import { determineInput } from "./runtime/input.js";
import type { CliDefaults, CliOptions, OpenAIInputMessage } from "../core/types.js";

const LOG_LABEL = "[gpt-5-cli-sql]";
const SQL_TOOL_REGISTRATIONS = [
  READ_FILE_TOOL,
  SQL_FETCH_SCHEMA_TOOL,
  SQL_DRY_RUN_TOOL,
  SQL_FORMAT_TOOL,
] as const;
const SQL_TOOL_RUNTIME = createToolRuntime(SQL_TOOL_REGISTRATIONS);

interface SqlConnectionMetadata {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
}

interface SqlDsnSnapshot {
  dsn: string;
  hash: string;
  connection: SqlConnectionMetadata;
}

export interface SqlCliOptions extends CliOptions {
  sqlMaxIterations: number;
  sqlMaxIterationsExplicit: boolean;
}

const connectionSchema = z
  .object({
    host: z.string().optional(),
    port: z.number().optional(),
    database: z.string().optional(),
    user: z.string().optional(),
  })
  .optional();

const sqlContextSchema = z
  .object({
    type: z.literal("postgresql").optional(),
    dsn_hash: z.string().optional(),
    connection: connectionSchema,
  })
  .optional();

const sqlCliHistoryTaskSchema = z.object({
  mode: z.string().optional(),
  sql: sqlContextSchema,
});

export type SqlCliHistoryTask = z.infer<typeof sqlCliHistoryTaskSchema>;

interface SqlCliHistoryTaskOptions {
  taskMode: SqlCliOptions["taskMode"];
  taskModeExplicit: boolean;
  dsnHash: string;
  connection: SqlConnectionMetadata;
}

const cliOptionsSchema: z.ZodType<SqlCliOptions> = z
  .object({
    model: z.string(),
    effort: z.enum(["low", "medium", "high"]),
    verbosity: z.enum(["low", "medium", "high"]),
    continueConversation: z.boolean(),
    taskMode: z.literal("sql"),
    resumeIndex: z.number().optional(),
    resumeListOnly: z.boolean(),
    deleteIndex: z.number().optional(),
    showIndex: z.number().optional(),
    imagePath: z.string().optional(),
    debug: z.boolean(),
    operation: z.union([z.literal("ask"), z.literal("compact")]),
    compactIndex: z.number().optional(),
    args: z.array(z.string()),
    modelExplicit: z.boolean(),
    effortExplicit: z.boolean(),
    verbosityExplicit: z.boolean(),
    taskModeExplicit: z.boolean(),
    hasExplicitHistory: z.boolean(),
    helpRequested: z.boolean(),
    sqlMaxIterations: z.number().int().positive(),
    sqlMaxIterationsExplicit: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (
      value.operation === "compact" &&
      (value.continueConversation ||
        value.resumeListOnly ||
        typeof value.resumeIndex === "number" ||
        typeof value.deleteIndex === "number" ||
        typeof value.showIndex === "number" ||
        value.args.length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Error: --compact と他のフラグは併用できません",
        path: ["operation"],
      });
    }
  });

function parseSqlIterations(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidArgumentError("Error: --sql-iterations の値は正の整数で指定してください");
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed <= 0) {
    throw new InvalidArgumentError("Error: --sql-iterations の値は 1 以上で指定してください");
  }
  return parsed;
}

/**
 * SQL モード CLI の引数を解析し、正規化済みオプションを返す。
 *
 * @param argv process.argv から渡された引数（node, script を除外）。
 * @param defaults 環境から取得した既定値。
 * @returns SQL モード用 CLI オプション。
 */
export function parseArgs(argv: string[], defaults: CliDefaults): SqlCliOptions {
  const program = new Command();

  program
    .exitOverride()
    .allowUnknownOption(false)
    .showSuggestionAfterError(false)
    .configureOutput({
      writeErr: (str) => {
        const trimmed = str.replace(/\s+$/u, "");
        if (trimmed.length > 0) {
          console.error(trimmed);
        }
      },
    });

  program.helpOption(false);
  program
    .option("-?, --help", "ヘルプを表示します")
    .option(
      "-m, --model <index>",
      "モデルを選択 (0/1/2)",
      (value) => parseModelFlag(value, defaults),
      defaults.modelNano,
    )
    .option("-e, --effort <index>", "effort を選択 (0/1/2)", parseEffortFlag, defaults.effort)
    .option(
      "-v, --verbosity <index>",
      "verbosity を選択 (0/1/2)",
      parseVerbosityFlag,
      defaults.verbosity,
    )
    .option("-c, --continue-conversation", "直前の会話から継続します")
    .option("-r, --resume [index]", "指定した番号の履歴から継続します")
    .option("-d, --delete [index]", "指定した番号の履歴を削除します")
    .option("-s, --show [index]", "指定した番号の履歴を表示します")
    .option("--debug", "デバッグログを有効化します")
    .option("-i, --image <path>", "画像ファイルを添付します")
    .option(
      "-I, --sql-iterations <count>",
      "SQLモード時のツール呼び出し上限を指定します",
      parseSqlIterations,
      defaults.sqlMaxIterations,
    )
    .option("--compact <index>", "指定した履歴を要約します", (value: string) => {
      if (!/^\d+$/u.test(value)) {
        throw new InvalidArgumentError("Error: --compact の履歴番号は正の整数で指定してください");
      }
      return Number.parseInt(value, 10);
    });

  program.argument("[input...]", "ユーザー入力");

  const normalizedArgv = expandLegacyShortFlags(argv);

  try {
    program.parse(normalizedArgv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new Error(error.message);
    }
    throw error;
  }

  const opts = program.opts<{
    help?: boolean;
    model?: string;
    effort?: SqlCliOptions["effort"];
    verbosity?: SqlCliOptions["verbosity"];
    continueConversation?: boolean;
    resume?: string | boolean;
    delete?: string | boolean;
    show?: string | boolean;
    debug?: boolean;
    image?: string;
    sqlIterations?: number;
    compact?: number;
  }>();

  const args = program.args as string[];

  const model = opts.model ?? defaults.modelNano;
  const effort = opts.effort ?? defaults.effort;
  const verbosity = opts.verbosity ?? defaults.verbosity;
  const debug = Boolean(opts.debug);
  let continueConversation = Boolean(opts.continueConversation);
  let resumeIndex: number | undefined;
  let resumeListOnly = false;
  let deleteIndex: number | undefined;
  let showIndex: number | undefined;
  let hasExplicitHistory = false;
  const imagePath = opts.image;
  let operation: "ask" | "compact" = "ask";
  let compactIndex: number | undefined;
  const taskMode: SqlCliOptions["taskMode"] = "sql";
  const sqlMaxIterations =
    typeof opts.sqlIterations === "number" ? opts.sqlIterations : defaults.sqlMaxIterations;

  const parsedResume = parseHistoryFlag(opts.resume);
  if (parsedResume.listOnly) {
    resumeListOnly = true;
  }
  if (typeof parsedResume.index === "number") {
    resumeIndex = parsedResume.index;
    continueConversation = true;
    hasExplicitHistory = true;
  }

  const parsedDelete = parseHistoryFlag(opts.delete);
  if (parsedDelete.listOnly) {
    resumeListOnly = true;
  }
  if (typeof parsedDelete.index === "number") {
    deleteIndex = parsedDelete.index;
  }

  const parsedShow = parseHistoryFlag(opts.show);
  if (parsedShow.listOnly) {
    resumeListOnly = true;
  }
  if (typeof parsedShow.index === "number") {
    showIndex = parsedShow.index;
  }

  if (typeof opts.compact === "number") {
    operation = "compact";
    compactIndex = opts.compact;
  }

  const modelExplicit = program.getOptionValueSource("model") === "cli";
  const effortExplicit = program.getOptionValueSource("effort") === "cli";
  const verbosityExplicit = program.getOptionValueSource("verbosity") === "cli";
  const sqlMaxIterationsExplicit = program.getOptionValueSource("sqlIterations") === "cli";
  const taskModeExplicit = false;
  const helpRequested = Boolean(opts.help);

  try {
    return cliOptionsSchema.parse({
      model,
      effort,
      verbosity,
      continueConversation,
      taskMode,
      resumeIndex,
      resumeListOnly,
      deleteIndex,
      showIndex,
      imagePath,
      debug,
      operation,
      compactIndex,
      args,
      modelExplicit,
      effortExplicit,
      verbosityExplicit,
      taskModeExplicit,
      hasExplicitHistory,
      helpRequested,
      sqlMaxIterations,
      sqlMaxIterationsExplicit,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const firstIssue = error.issues[0];
      throw new Error(firstIssue?.message ?? error.message);
    }
    throw error;
  }
}

/**
 * SQL CLI のヘルプを標準出力へ表示する。
 *
 * @param defaults 既定値。
 * @param options 解析済み CLI オプション。
 */
function printHelp(defaults: CliDefaults, options: SqlCliOptions): void {
  console.log("Usage:");
  console.log("  gpt-5-cli-sql [flag] <input>");
  console.log("  gpt-5-cli-sql --compact <num>");
  console.log("");
  console.log("flag（種類+数字／連結可／ハイフン必須）:");
  console.log(
    `  -m0/-m1/-m2 : model => nano/mini/main (${defaults.modelNano}/${defaults.modelMini}/${defaults.modelMain})`,
  );
  console.log(`  -e0/-e1/-e2 : effort => low/medium/high (既定: ${options.effort})`);
  console.log(`  -v0/-v1/-v2 : verbosity => low/medium/high (既定: ${options.verbosity})`);
  console.log("  -c          : continue（直前の会話から継続）");
  console.log("  -r{num}     : 対応する履歴で対話を再開（例: -r2）");
  console.log("  -d{num}     : 対応する履歴を削除（例: -d2）");
  console.log("  -s{num}     : 対応する履歴の対話内容を表示（例: -s1）");
  console.log("  --debug     : デバッグログを有効化");
  console.log("  -I <count>  : SQLモード時のツール呼び出し上限 (--sql-iterations)");
  console.log("  -i <path>   : 入力に画像を添付");
  console.log("");
  console.log("環境変数(.env):");
  console.log(
    "  POSTGRES_DSN            : PostgreSQL 接続文字列 (例: postgres://user:pass@host:5432/db)",
  );
  console.log("  SQRUFF_BIN              : sqruff 実行ファイルのパス (既定: sqruff)");
  console.log("  GPT_5_CLI_SQL_MAX_ITERATIONS : エージェントのツール呼び出し上限 (正の整数)");
  console.log(
    "  GPT_5_CLI_HISTORY_INDEX_FILE, GPT_5_CLI_PROMPTS_DIR : 共通設定 (default/d2 と同じ)",
  );
  console.log("");
  console.log("例:");
  console.log("  gpt-5-cli-sql 既存レポートの集計クエリを高速化したい");
  console.log("  gpt-5-cli-sql -r2 テーブル定義を一覧して -> 履歴 2 を継続");
  console.log("  gpt-5-cli-sql --compact 3 -> 履歴 3 を要約");
}

function hashDsn(dsn: string): string {
  const digest = createHash("sha256").update(dsn).digest("hex");
  return `sha256:${digest}`;
}

function extractConnectionMetadata(dsn: string): SqlConnectionMetadata {
  try {
    const url = new URL(dsn);
    const database = url.pathname.replace(/^\//u, "");
    const port = url.port ? Number.parseInt(url.port, 10) : undefined;
    return {
      host: url.hostname || undefined,
      port: Number.isNaN(port) ? undefined : port,
      database: database.length > 0 ? database : undefined,
      user: url.username || undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`POSTGRES_DSN の解析に失敗しました: ${message}`);
  }
}

function ensureSqlEnvironment(): SqlDsnSnapshot {
  const dsn = process.env.POSTGRES_DSN;
  if (typeof dsn !== "string" || dsn.trim().length === 0) {
    throw new Error("POSTGRES_DSN が未設定です");
  }
  const trimmed = dsn.trim();
  return {
    dsn: trimmed,
    hash: hashDsn(trimmed),
    connection: extractConnectionMetadata(trimmed),
  };
}

function formatConnectionDisplay(connection: SqlConnectionMetadata): string {
  const parts: string[] = [];
  if (connection.host) {
    parts.push(`host=${connection.host}`);
  }
  if (typeof connection.port === "number") {
    parts.push(`port=${connection.port}`);
  }
  if (connection.database) {
    parts.push(`database=${connection.database}`);
  }
  if (connection.user) {
    parts.push(`user=${connection.user}`);
  }
  return parts.length > 0 ? parts.join(", ") : "(接続情報なし)";
}

interface SqlInstructionParams {
  connection: SqlConnectionMetadata;
  dsnHash: string;
  maxIterations: number;
}

/**
 * SQL モードで追加するシステムメッセージを生成する。
 *
 * @param params 接続メタデータと設定値。
 * @returns Responses API へ渡すシステムメッセージ配列。
 */
export function buildSqlInstructionMessages(params: SqlInstructionParams): OpenAIInputMessage[] {
  const connectionLine = formatConnectionDisplay(params.connection);
  const toolSummary = [
    "利用可能なツール:",
    "- sql_fetch_schema: information_schema からテーブル/カラム情報を取得し JSON を返す",
    "- sql_dry_run: SELECT 文を PREPARE/EXPLAIN で検証し、実行計画 (FORMAT JSON) を取得する",
    "- sql_format: sqruff fix で SQL を整形し、整形済みテキストを取得する",
  ].join("\n");

  const workflow = [
    "作業手順:",
    "1. 必要に応じて sql_fetch_schema でスキーマを把握する",
    "2. 修正案の作成時は SELECT/WITH ... SELECT のみ扱う",
    "3. 提案 SQL が用意できたら必ず sql_format で整形し、その直後に sql_dry_run を実行して成功するまで繰り返す（成功する前にユーザーへ最終回答しない）",
    "4. sql_dry_run が失敗した場合は原因を説明し、必要に応じて再度 1〜3 を実施する",
    "5. sql_dry_run が成功したら最終応答を行い、整形済み SQL を ```sql コードブロックで提示しつつ、dry run の結果や確認事項を日本語でまとめる",
  ].join("\n");

  const systemText = [
    "あなたは PostgreSQL SELECT クエリの専門家です。",
    "許可されたツール以外は利用せず、ローカルワークスペース外へアクセスしないでください。",
    `接続情報: ${connectionLine} (dsn hash=${params.dsnHash})`,
    `ツール呼び出し上限の目安: ${params.maxIterations} 回`,
    toolSummary,
    workflow,
  ].join("\n\n");

  return [
    {
      role: "system",
      content: [{ type: "input_text", text: systemText }],
    },
  ];
}

/**
 * 履歴へ保存する SQL メタデータを組み立てる。
 *
 * @param options 現在の CLI オプションと接続スナップショット。
 * @param previousTask 既存の履歴タスク情報。
 * @returns 更新後の履歴タスク。
 */
export function buildSqlCliHistoryTask(
  options: SqlCliHistoryTaskOptions,
  previousTask?: SqlCliHistoryTask,
): SqlCliHistoryTask | undefined {
  if (options.taskMode === "sql") {
    const task: SqlCliHistoryTask = { mode: "sql" };
    const normalizedConnection = Object.fromEntries(
      Object.entries(options.connection).filter(([, value]) => value !== undefined && value !== ""),
    );
    const sqlMeta = {
      type: "postgresql" as const,
      dsn_hash: options.dsnHash,
      connection: Object.keys(normalizedConnection).length > 0 ? normalizedConnection : undefined,
    };

    if (previousTask?.sql) {
      task.sql = {
        ...previousTask.sql,
        ...sqlMeta,
      };
    } else {
      task.sql = sqlMeta;
    }

    return task;
  }

  if (options.taskModeExplicit) {
    return { mode: options.taskMode };
  }

  return previousTask;
}

/**
 * SQL モード CLI 全体を実行する。
 */
async function runSqlCli(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    const bootstrap = bootstrapCli({
      argv,
      logLabel: LOG_LABEL,
      parseArgs,
      printHelp,
      historyTaskSchema: sqlCliHistoryTaskSchema,
      envFileSuffix: "sql",
    });

    if (bootstrap.status === "help") {
      return;
    }

    const { defaults, options, historyStore, systemPrompt } = bootstrap;
    const client = createOpenAIClient();

    if (options.operation === "compact") {
      await performCompact(options, defaults, historyStore, client, LOG_LABEL);
      return;
    }

    const determine = await determineInput(options, historyStore, defaults, { printHelp });
    if (determine.kind === "exit") {
      process.exit(determine.code);
      return;
    }

    const context = computeContext(
      options,
      historyStore,
      determine.inputText,
      determine.activeEntry,
      determine.previousResponseId,
      determine.previousTitle,
      {
        logLabel: LOG_LABEL,
        synchronizeWithHistory: ({ options: nextOptions, activeEntry, logWarning }) => {
          if (!nextOptions.taskModeExplicit) {
            const historyMode = activeEntry.task?.mode;
            if (historyMode && historyMode !== "sql") {
              logWarning("warn: 選択した履歴は sql モードではありません (新規開始)");
            }
            nextOptions.taskMode = "sql";
          }
        },
      },
    );

    const sqlEnv = ensureSqlEnvironment();

    const imageInfo = prepareImageData(options.imagePath, LOG_LABEL);
    const request = buildRequest({
      options,
      context,
      inputText: determine.inputText,
      systemPrompt,
      imageDataUrl: imageInfo.dataUrl,
      defaults,
      logLabel: LOG_LABEL,
      additionalSystemMessages: buildSqlInstructionMessages({
        connection: sqlEnv.connection,
        dsnHash: sqlEnv.hash,
        maxIterations: options.sqlMaxIterations,
      }),
      tools: buildCliToolList(SQL_TOOL_REGISTRATIONS),
    });

    const response = await executeWithTools(client, request, options, LOG_LABEL, SQL_TOOL_RUNTIME);
    const content = extractResponseText(response);
    if (!content) {
      throw new Error("Error: Failed to parse response or empty content");
    }

    if (response.id) {
      const previousTask = context.activeEntry?.task as SqlCliHistoryTask | undefined;
      const historyTask = buildSqlCliHistoryTask(
        {
          taskMode: options.taskMode,
          taskModeExplicit: options.taskModeExplicit,
          dsnHash: sqlEnv.hash,
          connection: sqlEnv.connection,
        },
        previousTask,
      );
      historyStore.upsertConversation({
        metadata: {
          model: options.model,
          effort: options.effort,
          verbosity: options.verbosity,
        },
        context: {
          isNewConversation: context.isNewConversation,
          titleToUse: context.titleToUse,
          previousResponseId: context.previousResponseId,
          activeLastResponseId: context.activeLastResponseId,
          resumeSummaryText: context.resumeSummaryText,
          resumeSummaryCreatedAt: context.resumeSummaryCreatedAt,
          previousTask,
        },
        responseId: response.id,
        userText: determine.inputText,
        assistantText: content,
        task: historyTask,
      });
    }

    process.stdout.write(`${content}\n`);
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }
    process.exit(1);
  }
}

if (import.meta.main) {
  await runSqlCli();
}
