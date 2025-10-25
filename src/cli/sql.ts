#!/usr/bin/env bun
/**
 * @file SQL モードの CLI エントリーポイント。PostgreSQL と連携した SELECT クエリ編集を
 * OpenAI Responses API のエージェントと SQL 専用ツールで実現する。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { computeContext } from "../pipeline/process/conversation-context.js";
import { prepareImageData } from "../pipeline/process/image-attachments.js";
import { buildRequest, performCompact } from "../pipeline/process/responses.js";
import { createOpenAIClient } from "../pipeline/process/openai-client.js";
import {
  READ_FILE_TOOL,
  SQL_DRY_RUN_TOOL,
  SQL_FETCH_COLUMN_SCHEMA_TOOL,
  SQL_FETCH_ENUM_SCHEMA_TOOL,
  SQL_FETCH_INDEX_SCHEMA_TOOL,
  SQL_FETCH_TABLE_SCHEMA_TOOL,
  SQL_FORMAT_TOOL,
  WRITE_FILE_TOOL,
  setSqlEnvironment,
} from "../pipeline/process/tools/index.js";
import {
  finalizeResult,
  generateDefaultOutputPath,
  resolveResultOutput,
} from "../pipeline/finalize/index.js";
import { bootstrapCli } from "../pipeline/input/cli-bootstrap.js";
import { createCliHistoryEntryFilter } from "../pipeline/input/history-filter.js";
import { determineInput } from "../pipeline/input/cli-input.js";
import type { CliDefaults, CliOptions, OpenAIInputMessage } from "../types.js";
import type { HistoryEntry } from "../pipeline/history/store.js";
import { runAgentConversation } from "../pipeline/process/agent-conversation.js";
import { buildCommonCommand, parseCommonOptions } from "./common/common-cli.js";

const LOG_LABEL = "[gpt-5-cli-sql]";

export type SqlEngine = "postgresql" | "mysql";

/** DSNから抽出した接続メタデータを保持するための型。 */
interface SqlConnectionMetadata {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
}

/** 実行時に使用するDSNとそのハッシュ、接続メタデータをまとめたスナップショット。 */
/** 実行時に使用するDSNとそのハッシュ、接続メタデータをまとめたスナップショット。 */
interface SqlDsnSnapshot {
  dsn: string;
  hash: string;
  engine: SqlEngine;
  connection: SqlConnectionMetadata;
}

/** SQL ファイルの存在確認やパス情報を保持するための型。 */
interface SqlContextInfo {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
}

/** SQLモードの解析済みCLIオプションを表す型。 */
export interface SqlCliOptions extends CliOptions {
  dsn?: string;
  engine?: SqlEngine;
  artifactPath: string;
}

const POSTGRES_SQL_TOOL_REGISTRATIONS = [
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  SQL_FETCH_TABLE_SCHEMA_TOOL,
  SQL_FETCH_COLUMN_SCHEMA_TOOL,
  SQL_FETCH_ENUM_SCHEMA_TOOL,
  SQL_FETCH_INDEX_SCHEMA_TOOL,
  SQL_DRY_RUN_TOOL,
  SQL_FORMAT_TOOL,
] as const;

// NOTE: MySQL 用ツール実装は今後追加予定。現段階では PostgreSQL 向けツールを暫定で再利用する。
const MYSQL_SQL_TOOL_REGISTRATIONS = POSTGRES_SQL_TOOL_REGISTRATIONS;

const SQL_TOOL_REGISTRY: Record<SqlEngine, typeof POSTGRES_SQL_TOOL_REGISTRATIONS> = {
  postgresql: POSTGRES_SQL_TOOL_REGISTRATIONS,
  mysql: MYSQL_SQL_TOOL_REGISTRATIONS,
};

const connectionSchema = z
  .object({
    host: z.string().optional(),
    port: z.number().optional(),
    database: z.string().optional(),
    user: z.string().optional(),
  })
  .optional();

const sqlCliHistoryContextStrictSchema = z.object({
  cli: z.literal("sql"),
  engine: z.enum(["postgresql", "mysql"]),
  dsn_hash: z.string().min(1),
  dsn: z.string().optional(),
  connection: connectionSchema,
  relative_path: z.string().optional(),
  copy: z.boolean().optional(),
  absolute_path: z.string().optional(),
});

const sqlCliHistoryContextSchema = sqlCliHistoryContextStrictSchema
  .or(z.object({}).passthrough())
  .or(z.null());

export type SqlCliHistoryContext = z.infer<typeof sqlCliHistoryContextStrictSchema>;
type SqlCliHistoryStoreContext = z.infer<typeof sqlCliHistoryContextSchema>;

function isSqlHistoryContext(
  value: SqlCliHistoryStoreContext | undefined,
): value is SqlCliHistoryContext {
  return (
    !!value &&
    typeof value === "object" &&
    "cli" in value &&
    (value as { cli?: unknown }).cli === "sql"
  );
}

/**
 * SQL CLI のヘルプを標準出力へ表示する。
 *
 * @param defaults 既定値。
 * @param options 解析済み CLI オプション。
 */
function createSqlProgram(defaults: CliDefaults) {
  return buildCommonCommand({
    defaults,
    mode: "sql",
    argument: { tokens: "[input...]", description: "ユーザー入力" },
    extraOptionRegistrars: [
      (program) => program.option("-P, --dsn <dsn>", "PostgreSQL などの接続文字列を直接指定します"),
    ],
  });
}

function outputHelp(defaults: CliDefaults, _options: SqlCliOptions): void {
  const program = createSqlProgram(defaults);
  program.outputHelp();
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
    responseOutputPath: z.string().min(1).optional(),
    responseOutputExplicit: z.boolean(),
    copyOutput: z.boolean(),
    copyExplicit: z.boolean(),
    operation: z.union([z.literal("ask"), z.literal("compact")]),
    compactIndex: z.number().optional(),
    dsn: z.string().min(1, "Error: --dsn は空にできません").optional(),
    artifactPath: z.string().min(1),
    args: z.array(z.string()),
    modelExplicit: z.boolean(),
    effortExplicit: z.boolean(),
    verbosityExplicit: z.boolean(),
    hasExplicitHistory: z.boolean(),
    helpRequested: z.boolean(),
    maxIterations: z.number().int().positive(),
    maxIterationsExplicit: z.boolean(),
    engine: z.enum(["postgresql", "mysql"]).optional(),
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

/**
 * SQL モード CLI の引数を解析し、正規化済みオプションを返す。
 *
 * @param argv process.argv から渡された引数（node, script を除外）。
 * @param defaults 環境から取得した既定値。
 * @returns SQL モード用 CLI オプション。
 */
export function parseArgs(argv: string[], defaults: CliDefaults): SqlCliOptions {
  const program = createSqlProgram(defaults);
  const { options: commonOptions } = parseCommonOptions(argv, defaults, program);
  const programOptions = program.opts<{ dsn?: string }>();
  let dsn: string | undefined;
  if (typeof programOptions.dsn === "string") {
    const trimmed = programOptions.dsn.trim();
    if (trimmed.length === 0) {
      throw new Error("Error: --dsn は空にできません");
    }
    dsn = trimmed;
  }
  const resolvedResponseOutputPath =
    commonOptions.responseOutputPath ??
    generateDefaultOutputPath({ mode: "sql", extension: "sql" }).relativePath;
  try {
    return cliOptionsSchema.parse({
      ...commonOptions,
      taskMode: "sql",
      responseOutputPath: resolvedResponseOutputPath,
      artifactPath: resolvedResponseOutputPath,
      dsn,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const firstIssue = error.issues[0];
      throw new Error(firstIssue?.message ?? error.message);
    }
    throw error;
  }
}

/** DSN をハッシュ化し、履歴に保存しやすい識別子へ変換する。 */
function hashDsn(dsn: string): string {
  const digest = createHash("sha256").update(dsn).digest("hex");
  return `sha256:${digest}`;
}

/** DSN から接続メタデータを抽出し、ホストやデータベースなどを返す。 */
export function inferSqlEngineFromDsn(dsn: string): SqlEngine {
  let protocol = "";
  try {
    const url = new URL(dsn);
    protocol = url.protocol.replace(/:$/u, "").toLowerCase();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`--dsn の値の解析に失敗しました: ${message}`);
  }

  switch (protocol) {
    case "postgres":
    case "postgresql":
    case "pgsql":
      return "postgresql";
    case "mysql":
    case "mariadb":
      return "mysql";
    default:
      throw new Error(
        `Error: --dsn のスキーム "${protocol || "(不明)"}" は未対応です (postgresql/mysql のみサポート)。`,
      );
  }
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
    throw new Error(`--dsn の値の解析に失敗しました: ${message}`);
  }
}

/**
 * SQL モードで使用するファイルパスを検証し、コンテキスト情報を構築する。
 *
 * @param options CLI オプション。
 * @returns SQL ファイルの存在情報。
 */
export function ensureSqlContext(options: SqlCliOptions): SqlContextInfo {
  if (options.taskMode !== "sql") {
    throw new Error("Invariant violation: ensureSqlContext は sql モード専用です");
  }
  const cwd = process.cwd();
  const rawPath = options.artifactPath;
  const absolutePath = path.resolve(cwd, rawPath);
  const normalizedRoot = path.resolve(cwd);
  const relative = path.relative(normalizedRoot, absolutePath);
  const isInsideWorkspace =
    relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!isInsideWorkspace) {
    throw new Error(
      `Error: SQL出力の保存先はカレントディレクトリ配下に指定してください: ${rawPath}`,
    );
  }
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) {
    throw new Error(`Error: 指定した SQL ファイルパスはディレクトリです: ${rawPath}`);
  }
  const relativePath = path.relative(normalizedRoot, absolutePath) || path.basename(absolutePath);
  options.artifactPath = relativePath;
  options.responseOutputPath = relativePath;
  const exists = fs.existsSync(absolutePath);
  return { relativePath, absolutePath, exists };
}

/** DSN の正規化・ハッシュ化結果と接続メタデータをまとめたスナップショットを生成する。 */
function createSqlSnapshot(rawDsn: string): SqlDsnSnapshot {
  if (typeof rawDsn !== "string" || rawDsn.trim().length === 0) {
    throw new Error("Error: --dsn は必須です");
  }
  const trimmed = rawDsn.trim();
  const engine = inferSqlEngineFromDsn(trimmed);
  return {
    dsn: trimmed,
    hash: hashDsn(trimmed),
    engine,
    connection: extractConnectionMetadata(trimmed),
  };
}

/** 履歴エントリに保存された DSN を抽出し、存在すれば正規化して返す。 */
function pickHistoryDsn(entry: HistoryEntry<SqlCliHistoryContext> | undefined): string | undefined {
  if (!entry) {
    return undefined;
  }
  const contextData = entry.context as SqlCliHistoryContext | undefined;
  const candidate = contextData?.dsn;
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

/** CLI指定値と履歴情報を突き合わせ、実行に使用する DSN を決定する。 */
function resolveSqlDsn(
  provided: string | undefined,
  contextEntry: HistoryEntry<SqlCliHistoryContext> | undefined,
  determineEntry: HistoryEntry<SqlCliHistoryContext> | undefined,
): string {
  if (typeof provided === "string" && provided.trim().length > 0) {
    return provided.trim();
  }
  const fromDetermine = pickHistoryDsn(determineEntry);
  if (fromDetermine) {
    return fromDetermine;
  }
  const fromContext = pickHistoryDsn(contextEntry);
  if (fromContext) {
    return fromContext;
  }
  throw new Error("Error: --dsn は必須です（履歴にも DSN が保存されていません）");
}

/**
 * SQL モードで追加システムメッセージを生成する際の入力情報。
 */
interface SqlInstructionParams {
  /** 接続先のメタデータ。 */
  connection: SqlConnectionMetadata;
  /** DSN をハッシュ化した値。 */
  dsnHash: string;
  /** エージェントの最大試行回数。 */
  maxIterations: number;
  /** 接続しているデータベースエンジン。 */
  engine: SqlEngine;
  /** レスポンス出力先のアーティファクトパス。 */
  artifactPath: string;
}

/**
 * SQL モードで追加するシステムメッセージを生成する。
 * @returns Responses API へ渡すシステムメッセージ配列。
 */
export function buildSqlInstructionMessages(params: SqlInstructionParams): OpenAIInputMessage[] {
  const connectionParts: string[] = [];
  if (params.connection.host) {
    connectionParts.push(`host=${params.connection.host}`);
  }
  if (typeof params.connection.port === "number") {
    connectionParts.push(`port=${params.connection.port}`);
  }
  if (params.connection.database) {
    connectionParts.push(`database=${params.connection.database}`);
  }
  if (params.connection.user) {
    connectionParts.push(`user=${params.connection.user}`);
  }
  const connectionLine = connectionParts.length > 0 ? connectionParts.join(", ") : "(接続情報なし)";
  const engineLabel = params.engine === "postgresql" ? "PostgreSQL" : "MySQL";
  const toolSummaryLines: string[] = [
    "利用可能なツール:",
    "- sql_fetch_table_schema: information_schema.tables からテーブル情報を取得する",
    "- sql_fetch_column_schema: information_schema.columns からカラム情報を取得する",
  ];
  if (params.engine === "postgresql") {
    toolSummaryLines.push(
      "- sql_fetch_enum_schema: PostgreSQL の enum 型と値を取得する",
      "- sql_fetch_index_schema: pg_indexes からインデックス定義を取得する",
    );
  } else {
    toolSummaryLines.push(
      "- sql_fetch_enum_schema: ENUM 型の定義と候補値を取得する",
      "- sql_fetch_index_schema: information_schema.statistics からインデックス定義を構築する",
    );
  }
  toolSummaryLines.push(
    "- sql_dry_run: SELECT 文を PREPARE/EXPLAIN で検証し、実行計画 (FORMAT JSON) を取得する",
    "- sql_format: sqruff fix で SQL を整形し、整形済みテキストを取得する",
    "- write_file: 整形済み SQL を対象ファイルへ上書き保存する",
    "- read_file: 既存の SQL ファイルを確認する",
  );
  const toolSummary = toolSummaryLines.join("\n");

  const workflow = [
    "作業手順:",
    "1. 必要に応じて sql_fetch_table_schema で対象テーブルを把握し、sql_fetch_column_schema・sql_fetch_enum_schema・sql_fetch_index_schema で必要な詳細を取得する",
    "2. 修正案の作成時は SELECT/WITH ... SELECT のみ扱う",
    "3. 提案 SQL が用意できたら必ず sql_format で整形し、その直後に sql_dry_run を実行して成功するまで繰り返す（成功する前にユーザーへ最終回答しない）",
    "4. 検証が完了した SQL は write_file で対象ファイルへ保存し、必要に応じて read_file で差分を確認する",
    "5. sql_dry_run が失敗した場合は原因を説明し、必要に応じて再度 1〜4 を実施する",
    "6. sql_dry_run が成功したら最終応答を行い、整形済み SQL を ```sql コードブロックで提示しつつ、dry run の結果や確認事項を日本語でまとめる",
  ].join("\n");

  const systemText = [
    `あなたは ${engineLabel} SELECT クエリの専門家です。`,
    "許可されたツール以外は利用せず、ローカルワークスペース外へアクセスしないでください。",
    `成果物ファイル: ${params.artifactPath} (ワークスペース相対パス)`,
    `接続情報: ${connectionLine} (dsn hash=${params.dsnHash})`,
    `イテレーション上限の目安: ${params.maxIterations} 回`,
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

interface SqlHistoryContextExtras {
  historyArtifactPath?: string;
  copyOutput?: boolean;
}

/** SQL履歴コンテキストを構築する際の引数一式。 */
interface SqlCliHistoryContextOptions {
  dsnHash: string;
  dsn: string;
  connection: SqlConnectionMetadata;
  engine: SqlEngine;
}

/** 履歴へ保存する SQL メタデータを組み立て、既存コンテキスト情報と統合する。 */
export function buildSqlHistoryContext(
  options: SqlCliHistoryContextOptions,
  previousContext?: SqlCliHistoryContext,
  extras: SqlHistoryContextExtras = {},
): SqlCliHistoryContext {
  if (!options.engine) {
    throw new Error("Error: SQL engine is required to build history context");
  }
  const normalizedConnection = Object.fromEntries(
    Object.entries(options.connection).filter(([, value]) => value !== undefined && value !== ""),
  );
  const nextContext: SqlCliHistoryContext = {
    cli: "sql",
    engine: options.engine,
    dsn_hash: options.dsnHash,
  };
  const resolvedDsn = options.dsn ?? previousContext?.dsn;
  if (resolvedDsn) {
    nextContext.dsn = resolvedDsn;
  }
  const connectionEntries = Object.keys(normalizedConnection);
  if (connectionEntries.length > 0) {
    nextContext.connection = normalizedConnection;
  } else if (previousContext?.connection) {
    nextContext.connection = previousContext.connection;
  }
  if (extras.historyArtifactPath !== undefined) {
    nextContext.relative_path = extras.historyArtifactPath;
  } else if (previousContext?.relative_path) {
    nextContext.relative_path = previousContext.relative_path;
  } else {
    delete nextContext.relative_path;
  }

  if (extras.copyOutput) {
    nextContext.copy = true;
  } else if (previousContext?.copy) {
    nextContext.copy = true;
  } else {
    delete nextContext.copy;
  }
  return nextContext;
}

/**
 * SQLモード CLI のエントリーポイント。環境初期化からAPI利用・履歴更新までを統括する。
 */
async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    const bootstrap = bootstrapCli<SqlCliOptions, SqlCliHistoryStoreContext>({
      argv,
      logLabel: LOG_LABEL,
      parseArgs,
      historyContextSchema: sqlCliHistoryContextSchema,
      historyEntryFilter: createCliHistoryEntryFilter("sql"),
      envFileSuffix: "sql",
    });

    if (bootstrap.status === "help") {
      return;
    }

    const { defaults, options, historyStore, systemPrompt } = bootstrap;
    const client = createOpenAIClient();

    setSqlEnvironment(undefined);

    if (options.operation === "compact") {
      await performCompact(options, defaults, historyStore, client, LOG_LABEL);
      return;
    }

    const determine = await determineInput(options, historyStore, defaults, {
      printHelp: outputHelp,
    });
    if (determine.kind === "exit") {
      process.exit(determine.code);
      return;
    }

    // TODO(pipeline/input): SQL モード固有の DSN / 出力初期化の一部を input 層へ昇格させるか検討する。
    const context = computeContext(
      options,
      historyStore,
      determine.inputText,
      determine.activeEntry,
      determine.previousResponseId,
      determine.previousTitle,
      {
        logLabel: LOG_LABEL,
        synchronizeWithHistory: ({ options: nextOptions, activeEntry }) => {
          nextOptions.taskMode = "sql";
          const historyContext = activeEntry.context as SqlCliHistoryContext | undefined;
          if (!nextOptions.responseOutputExplicit) {
            const historyFile = historyContext?.relative_path ?? historyContext?.absolute_path;
            if (historyFile) {
              nextOptions.responseOutputPath = historyFile;
              nextOptions.artifactPath = historyFile;
            }
          }
          if (!nextOptions.copyExplicit && typeof historyContext?.copy === "boolean") {
            nextOptions.copyOutput = historyContext.copy;
          }
        },
      },
    );

    const sqlContext = ensureSqlContext(options);
    const sqlOutputAbsolutePath = sqlContext.absolutePath;

    const determineActiveEntry = determine.activeEntry as
      | HistoryEntry<SqlCliHistoryContext>
      | undefined;
    const contextActiveEntry = context.activeEntry as
      | HistoryEntry<SqlCliHistoryContext>
      | undefined;
    const effectiveDsn = resolveSqlDsn(options.dsn, contextActiveEntry, determineActiveEntry);
    const sqlEnv = createSqlSnapshot(effectiveDsn);
    setSqlEnvironment({ dsn: sqlEnv.dsn, engine: sqlEnv.engine });
    options.dsn = sqlEnv.dsn;
    options.engine = sqlEnv.engine;
    const toolRegistrations = SQL_TOOL_REGISTRY[sqlEnv.engine];

    const imageDataUrl = prepareImageData(options.imagePath, LOG_LABEL);
    const request = buildRequest({
      options,
      context,
      inputText: determine.inputText,
      systemPrompt,
      imageDataUrl,
      defaults,
      logLabel: LOG_LABEL,
      additionalSystemMessages: buildSqlInstructionMessages({
        connection: sqlEnv.connection,
        dsnHash: sqlEnv.hash,
        maxIterations: options.maxIterations,
        engine: sqlEnv.engine,
        artifactPath: options.artifactPath,
      }),
    });

    const agentResult = await runAgentConversation({
      client,
      request,
      options,
      logLabel: LOG_LABEL,
      toolRegistrations,
      maxTurns: options.maxIterations,
    });
    const content = agentResult.assistantText;
    if (!content) {
      throw new Error("Error: Failed to parse response or empty content");
    }

    const outputResolution = resolveResultOutput({
      responseOutputExplicit: options.responseOutputExplicit,
      responseOutputPath: options.responseOutputPath,
      artifactPath: options.artifactPath,
    });

    const previousContextRaw = context.activeEntry?.context as
      | SqlCliHistoryStoreContext
      | undefined;
    const previousContext = isSqlHistoryContext(previousContextRaw)
      ? previousContextRaw
      : undefined;
    const historyContext = buildSqlHistoryContext(
      {
        dsnHash: sqlEnv.hash,
        dsn: sqlEnv.dsn,
        connection: sqlEnv.connection,
        engine: sqlEnv.engine,
      },
      previousContext,
      {
        historyArtifactPath: outputResolution.artifactReferencePath,
        copyOutput: options.copyOutput,
      },
    );

    const finalizeOutcome = await finalizeResult<SqlCliHistoryStoreContext>({
      content,
      userText: determine.inputText,
      textOutputPath: outputResolution.textOutputPath ?? undefined,
      copyOutput: options.copyOutput,
      copySourceFilePath: options.artifactPath,
      history: agentResult.responseId
        ? {
            responseId: agentResult.responseId,
            store: historyStore,
            conversation: context,
            metadata: {
              model: options.model,
              effort: options.effort,
              verbosity: options.verbosity,
            },
            previousContextRaw,
            contextData: historyContext,
          }
        : undefined,
    });

    if (fs.existsSync(sqlOutputAbsolutePath)) {
      console.log(`[gpt-5-cli-sql] artifact file: ${options.artifactPath}`);
    }

    process.stdout.write(`${finalizeOutcome.stdout}\n`);
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
  await main();
}
