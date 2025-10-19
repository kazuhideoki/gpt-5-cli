#!/usr/bin/env bun
/**
 * @file SQL モードの CLI エントリーポイント。PostgreSQL と連携した SELECT クエリ編集を
 * OpenAI Responses API のエージェントと SQL 専用ツールで実現する。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { z } from "zod";
import { computeContext } from "../session/conversation-context.js";
import { prepareImageData } from "../session/image-attachments.js";
import { buildRequest, performCompact } from "../session/responses-session.js";
import { createOpenAIClient } from "../session/openai-client.js";
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
} from "../core/tools.js";
import {
  expandLegacyShortFlags,
  parseEffortFlag,
  parseHistoryFlag,
  parseModelFlag,
  parseVerbosityFlag,
} from "../core/options.js";
import { deliverOutput, generateDefaultOutputPath } from "../core/output.js";
import { bootstrapCli } from "./runtime/runner.js";
import { determineInput } from "./runtime/input.js";
import type { CliDefaults, CliOptions, OpenAIInputMessage } from "../core/types.js";
import type { HistoryEntry } from "../core/history.js";
import { runAgentConversation } from "../session/agent-session.js";

const LOG_LABEL = "[gpt-5-cli-sql]";

export type SqlEngine = "postgresql" | "mysql";

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

/** SQLモードの解析済みCLIオプションを表す型。 */
export interface SqlCliOptions extends CliOptions {
  maxIterations: number;
  maxIterationsExplicit: boolean;
  dsn?: string;
  engine?: SqlEngine;
  sqlFilePath: string;
}

const connectionSchema = z
  .object({
    host: z.string().optional(),
    port: z.number().optional(),
    database: z.string().optional(),
    user: z.string().optional(),
  })
  .optional();

const sqlCliHistoryContextSchema = z.object({
  cli: z.literal("sql"),
  engine: z.enum(["postgresql", "mysql"]),
  dsn_hash: z.string().min(1),
  dsn: z.string().optional(),
  connection: connectionSchema,
  output: z
    .object({
      file: z.string(),
      copy: z.boolean().optional(),
    })
    .optional(),
});

export type SqlCliHistoryContext = z.infer<typeof sqlCliHistoryContextSchema>;

/** SQL履歴コンテキストを構築する際の引数一式。 */
interface SqlCliHistoryContextOptions {
  dsnHash: string;
  dsn: string;
  connection: SqlConnectionMetadata;
  engine: SqlEngine;
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
    outputPath: z.string().min(1).optional(),
    outputExplicit: z.boolean(),
    copyOutput: z.boolean(),
    copyExplicit: z.boolean(),
    operation: z.union([z.literal("ask"), z.literal("compact")]),
    compactIndex: z.number().optional(),
    dsn: z.string().min(1, "Error: --dsn は空にできません").optional(),
    sqlFilePath: z.string().min(1),
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

/** SQLモードのツール呼び出し上限を検証し、正の整数として解釈する。 */
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
    .option("-P, --dsn <dsn>", "PostgreSQL などの接続文字列を直接指定します")
    .option("-i, --image <path>", "画像ファイルを添付します")
    .option("-o, --output <path>", "結果を保存するファイルパスを指定します")
    .option("--copy", "結果をクリップボードにコピーします")
    .option(
      "-I, --sql-iterations <count>",
      "SQLモード時のツール呼び出し上限を指定します",
      parseSqlIterations,
      defaults.maxIterations,
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
    output?: string;
    copy?: boolean;
    sqlIterations?: number;
    compact?: number;
    dsn: string;
  }>();

  const args = program.args as string[];

  const model = opts.model ?? defaults.modelNano;
  const effort = opts.effort ?? defaults.effort;
  const verbosity = opts.verbosity ?? defaults.verbosity;
  const debug = Boolean(opts.debug);
  let dsn: string | undefined;
  if (typeof opts.dsn === "string") {
    const trimmed = opts.dsn.trim();
    if (trimmed.length === 0) {
      throw new Error("Error: --dsn は空にできません");
    }
    dsn = trimmed;
  }
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
  let outputPath = typeof opts.output === "string" ? opts.output.trim() : undefined;
  if (outputPath && outputPath.length === 0) {
    outputPath = undefined;
  }
  const copyOutput = Boolean(opts.copy);
  const maxIterations =
    typeof opts.sqlIterations === "number" ? opts.sqlIterations : defaults.maxIterations;
  if (!outputPath) {
    outputPath = generateDefaultOutputPath({ mode: "sql", extension: "sql" }).relativePath;
  }
  const sqlFilePath = outputPath;

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
  const outputExplicit = program.getOptionValueSource("output") === "cli";
  const copyExplicit = program.getOptionValueSource("copy") === "cli";
  const maxIterationsExplicit = program.getOptionValueSource("sqlIterations") === "cli";
  const helpRequested = Boolean(opts.help);

  try {
    return cliOptionsSchema.parse({
      model,
      effort,
      verbosity,
      continueConversation,
      outputPath,
      outputExplicit,
      copyOutput,
      copyExplicit,
      taskMode,
      resumeIndex,
      resumeListOnly,
      deleteIndex,
      showIndex,
      imagePath,
      debug,
      sqlFilePath,
      dsn,
      operation,
      compactIndex,
      args,
      modelExplicit,
      effortExplicit,
      verbosityExplicit,
      hasExplicitHistory,
      helpRequested,
      maxIterations,
      maxIterationsExplicit,
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
  console.log("  -P <dsn>    : PostgreSQL などの接続文字列 (--dsn)");
  console.log("  -I <count>  : SQLモード時のツール呼び出し上限 (--sql-iterations)");
  console.log("  -o, --output <path> : 結果を指定ファイルに保存");
  console.log("  --copy      : 結果をクリップボードにコピー");
  console.log("  -i <path>   : 入力に画像を添付");
  console.log("");
  console.log("環境変数(.env):");
  console.log("  SQRUFF_BIN              : sqruff 実行ファイルのパス (既定: sqruff)");
  console.log(
    `  GPT_5_CLI_MAX_ITERATIONS : エージェントのツール呼び出し上限 (正の整数、既定: ${defaults.maxIterations})`,
  );
  console.log(
    "  GPT_5_CLI_HISTORY_INDEX_FILE, GPT_5_CLI_PROMPTS_DIR : 共通設定 (default/d2 と同じ)",
  );
  console.log("");
  console.log("例:");
  console.log("  gpt-5-cli-sql 既存レポートの集計クエリを高速化したい");
  console.log("  gpt-5-cli-sql -r2 テーブル定義を一覧して -> 履歴 2 を継続");
  console.log("  gpt-5-cli-sql --compact 3 -> 履歴 3 を要約");
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

function ensureSqlOutputPath(options: SqlCliOptions): string {
  const cwd = process.cwd();
  const rawPath = options.sqlFilePath;
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
    throw new Error(`Error: 指定した出力パスはディレクトリです: ${rawPath}`);
  }
  const relativePath = path.relative(normalizedRoot, absolutePath) || path.basename(absolutePath);
  options.sqlFilePath = relativePath;
  options.outputPath = relativePath;
  return absolutePath;
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

/** SQLシステムメッセージ生成時に必要なパラメータ群。 */
interface SqlInstructionParams {
  connection: SqlConnectionMetadata;
  dsnHash: string;
  maxIterations: number;
  engine: SqlEngine;
  filePath: string;
}

/**
 * SQL モードで追加するシステムメッセージを生成する。
 *
 * @param params 接続メタデータと設定値。
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
    `成果物ファイル: ${params.filePath} (ワークスペース相対パス)`,
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

/** 履歴へ保存する SQL メタデータを組み立て、既存コンテキスト情報と統合する。 */
export function buildSqlCliHistoryContext(
  options: SqlCliHistoryContextOptions,
  previousContext?: SqlCliHistoryContext,
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
  if (previousContext?.output) {
    nextContext.output = { ...previousContext.output };
  }
  return nextContext;
}

/**
 * SQLモード CLI のエントリーポイント。環境初期化からAPI利用・履歴更新までを統括する。
 */
async function runSqlCli(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    const bootstrap = bootstrapCli({
      argv,
      logLabel: LOG_LABEL,
      parseArgs,
      historyContextSchema: sqlCliHistoryContextSchema,
      envFileSuffix: "sql",
    });

    if (bootstrap.status === "help") {
      printHelp(bootstrap.defaults, bootstrap.options);
      return;
    }

    const { defaults, options, historyStore, systemPrompt } = bootstrap;
    const client = createOpenAIClient();

    setSqlEnvironment(undefined);

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
        synchronizeWithHistory: ({ options: nextOptions, activeEntry }) => {
          nextOptions.taskMode = "sql";
          const historyContext = activeEntry.context as SqlCliHistoryContext | undefined;
          if (!nextOptions.outputExplicit && historyContext?.output?.file) {
            nextOptions.outputPath = historyContext.output.file;
            nextOptions.sqlFilePath = historyContext.output.file;
          }
          if (!nextOptions.copyExplicit && typeof historyContext?.output?.copy === "boolean") {
            nextOptions.copyOutput = historyContext.output.copy;
          }
        },
      },
    );

    const sqlOutputAbsolutePath = ensureSqlOutputPath(options);

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
        filePath: options.sqlFilePath,
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

    const summaryOutputPath =
      options.outputExplicit && options.outputPath && options.outputPath !== options.sqlFilePath
        ? options.outputPath
        : undefined;

    await deliverOutput({
      content,
      filePath: summaryOutputPath,
      copy: options.copyOutput,
      copySource: {
        type: "file",
        filePath: options.sqlFilePath,
      },
    });

    if (agentResult.responseId) {
      const previousContext = context.activeEntry?.context as SqlCliHistoryContext | undefined;
      const historyContext = buildSqlCliHistoryContext(
        {
          dsnHash: sqlEnv.hash,
          dsn: sqlEnv.dsn,
          connection: sqlEnv.connection,
          engine: sqlEnv.engine,
        },
        previousContext,
      );
      const historyOutputFile = summaryOutputPath ?? options.sqlFilePath;
      historyContext.output = {
        file: historyOutputFile,
        copy: options.copyOutput ? true : undefined,
      };
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
          previousContext,
        },
        responseId: agentResult.responseId,
        userText: determine.inputText,
        assistantText: content,
        contextData: historyContext,
      });
    }

    if (fs.existsSync(sqlOutputAbsolutePath)) {
      console.log(`[gpt-5-cli-sql] output file: ${options.sqlFilePath}`);
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
