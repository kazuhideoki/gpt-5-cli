import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "pg";
import type {
  FunctionTool,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
} from "openai/resources/responses/responses";

/** ツール実行時に利用する作業ディレクトリとロガーを保持する。 */
interface ToolExecutionContext {
  cwd: string;
  log: (message: string) => void;
}

/**
 * ツール実行結果の基本形。CLI固有の拡張フィールドも許容する。
 */
export interface ToolResult {
  success: boolean;
  message?: string;
  [key: string]: unknown;
}

interface ReadFileResult extends ToolResult {
  path?: string;
  content?: string;
  encoding?: string;
}

interface WriteFileResult extends ToolResult {
  path?: string;
  bytes_written?: number;
}

interface CommandResult extends ToolResult {
  command: string;
  args: string[];
  exit_code: number;
  stdout: string;
  stderr: string;
}

type ToolHandler<
  TArgs = unknown,
  TResult extends ToolResult = ToolResult,
  TContext extends ToolExecutionContext = ToolExecutionContext,
> = (args: TArgs, context: TContext) => Promise<TResult>;

export interface ToolRegistration<
  TArgs = unknown,
  TResult extends ToolResult = ToolResult,
  TContext extends ToolExecutionContext = ToolExecutionContext,
> {
  definition: FunctionTool;
  handler: ToolHandler<TArgs, TResult, TContext>;
}

export interface ToolRuntime<TContext extends ToolExecutionContext = ToolExecutionContext> {
  tools: FunctionTool[];
  execute(call: ResponseFunctionToolCall, context: TContext): Promise<string>;
}

/**
 * ワークスペース内の安全なパスへ正規化し、外部アクセスを防ぐ。
 *
 * @param rawPath ユーザーから指定されたパス。
 * @param cwd ワークスペースのルート。
 * @returns 絶対パス。
 */
export function resolveWorkspacePath(rawPath: string, cwd: string): string {
  if (!rawPath || rawPath.trim().length === 0) {
    throw new Error("path must be a non-empty string");
  }
  const normalizedRoot = path.resolve(cwd);
  const candidate = path.resolve(normalizedRoot, rawPath);
  const relative = path.relative(normalizedRoot, candidate);
  const isInsideWorkspace =
    relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!isInsideWorkspace) {
    throw new Error(`Access to path outside workspace is not allowed: ${rawPath}`);
  }
  return candidate;
}

interface ReadFileArgs {
  path: string;
}

async function readFileTool(
  args: ReadFileArgs,
  context: ToolExecutionContext,
): Promise<ReadFileResult> {
  const { cwd } = context;
  const resolvedPath = resolveWorkspacePath(args.path, cwd);
  const buffer = await fs.readFile(resolvedPath, { encoding: "utf8" });
  return {
    success: true,
    path: path.relative(cwd, resolvedPath),
    content: buffer,
    encoding: "utf8",
  };
}

interface WriteFileArgs {
  path: string;
  content: string;
}

async function writeFileTool(
  args: WriteFileArgs,
  context: ToolExecutionContext,
): Promise<WriteFileResult> {
  const { cwd } = context;
  const resolvedPath = resolveWorkspacePath(args.path, cwd);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, args.content, { encoding: "utf8" });
  return {
    success: true,
    path: path.relative(cwd, resolvedPath),
    bytes_written: Buffer.byteLength(args.content, "utf8"),
  };
}

async function runCommand(
  command: string,
  commandArgs: string[],
  cwd: string,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const proc = spawn(command, commandArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    proc.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    proc.on("error", (error) => {
      resolve({
        success: false,
        command,
        args: commandArgs,
        exit_code: -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: `${Buffer.concat(stderrChunks).toString("utf8")}${error.message}`,
        message: error.message,
      });
    });

    proc.on("close", (code) => {
      resolve({
        success: (code ?? 1) === 0,
        command,
        args: commandArgs,
        exit_code: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

interface SqlSchemaRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

function requireEnvValue(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Environment variable ${name} is required for SQL tools.`);
  }
  return value;
}

function ensureQueryString(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("query must be a non-empty string");
  }
  if (raw.trim().length === 0) {
    throw new Error("query must be a non-empty string");
  }
  return raw;
}

/**
 * 末尾の空白を除去した SELECT 文を返す。
 * semicolon を削除せずに残し、後続処理で安全性チェックを行う。
 */
function normalizeSelectQuery(sql: string): string {
  return sql.trim();
}

/**
 * SQL テキストに複数ステートメントが含まれていないかを検査する。
 * 文字列・識別子・コメントを考慮し、末尾以外の内容を伴う `;` を検出する。
 */
function hasDanglingStatementTerminator(sql: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;
  let singleUsesBackslash = false;

  for (let index = 0; index < sql.length; index += 1) {
    const ch = sql[index] as string;
    const next = sql[index + 1] as string | undefined;

    if (inLineComment) {
      if (ch === "\n" || ch === "\r") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }

    if (inSingle) {
      if (singleUsesBackslash && ch === "\\") {
        index += 1;
        continue;
      }
      if (ch === "'" && next === "'") {
        index += 1;
        continue;
      }
      if (ch === "'") {
        inSingle = false;
        singleUsesBackslash = false;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"' && next === '"') {
        index += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "-" && next === "-") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      const prevChar = index > 0 ? sql[index - 1] : "";
      singleUsesBackslash = prevChar === "E" || prevChar === "e";
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      continue;
    }

    if (ch === "$") {
      const match = sql.slice(index).match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        dollarTag = match[0];
        index += match[0].length - 1;
        continue;
      }
    }

    if (ch === ";") {
      let lookahead = index + 1;
      while (lookahead < sql.length) {
        const lookChar = sql[lookahead] as string;
        const lookNext = sql[lookahead + 1] as string | undefined;
        if (/\s/u.test(lookChar)) {
          lookahead += 1;
          continue;
        }
        if (lookChar === "-" && lookNext === "-") {
          lookahead += 2;
          while (lookahead < sql.length) {
            const commentChar = sql[lookahead] as string;
            if (commentChar === "\n" || commentChar === "\r") {
              break;
            }
            lookahead += 1;
          }
          continue;
        }
        if (lookChar === "/" && lookNext === "*") {
          lookahead += 2;
          while (lookahead < sql.length) {
            if (sql[lookahead] === "*" && sql[lookahead + 1] === "/") {
              lookahead += 2;
              break;
            }
            lookahead += 1;
          }
          continue;
        }
        return true;
      }
      return false;
    }
  }

  return false;
}

function isSelectOnlyQuery(sql: string): boolean {
  const noComments = sql
    .replace(/--.*$/gmu, "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .trim();
  return /^\s*(with\b[\s\S]*?\bselect\b|select\b)/iu.test(noComments);
}

function buildPgErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const maybeError = error as { message?: unknown; detail?: unknown; hint?: unknown };
    const parts: string[] = [];
    if (typeof maybeError.message === "string") {
      parts.push(maybeError.message);
    }
    if (typeof maybeError.detail === "string") {
      parts.push(maybeError.detail);
    }
    if (typeof maybeError.hint === "string") {
      parts.push(`hint: ${maybeError.hint}`);
    }
    if (parts.length > 0) {
      return parts.join(" ");
    }
  }
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function createPgClient(): Client {
  const dsn = requireEnvValue("POSTGRES_DSN");
  return new Client({ connectionString: dsn });
}

async function fetchSqlSchemaRows(): Promise<SqlSchemaRow[]> {
  const client = createPgClient();
  await client.connect();
  try {
    const result = await client.query<SqlSchemaRow>(
      `
        SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name, ordinal_position
      `,
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function performSqlDryRun(query: string): Promise<{ plan: unknown }> {
  const client = createPgClient();
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`PREPARE __sqlcheck__ AS ${query}`);
    await client.query("DEALLOCATE __sqlcheck__");
    const explain = await client.query(`EXPLAIN (VERBOSE, COSTS OFF, FORMAT JSON) ${query}`);
    await client.query("ROLLBACK");
    const plan = explain.rows?.[0]?.["QUERY PLAN"];
    return { plan };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failures
    }
    throw new Error(buildPgErrorMessage(error));
  } finally {
    await client.end();
  }
}

async function formatSqlWithSqruff(query: string, cwd: string): Promise<string> {
  const bin = (process.env.SQRUFF_BIN ?? "sqruff").trim() || "sqruff";
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-5-sql-fmt-"));
  const inputFile = path.join(tempDir, "input.sql");
  await fs.writeFile(inputFile, query, "utf8");

  try {
    const result = await runCommand(bin, ["fix", inputFile], cwd);
    if (!result.success) {
      const stderr = result.stderr.trim();
      const stdout = result.stdout.trim();
      const fallback = `sqruff failed with exit code ${result.exit_code}`;
      throw new Error(stderr || stdout || fallback);
    }
    return await fs.readFile(inputFile, "utf8");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

interface SqlDryRunArgs {
  query: string;
}

interface SqlDryRunResult extends ToolResult {
  plan?: unknown;
}

interface SqlFormatArgs {
  query: string;
}

interface SqlFormatResult extends ToolResult {
  formatted_sql?: string;
}

async function sqlFetchSchemaTool(
  _args: Record<string, never>,
  _context: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    const rows = await fetchSqlSchemaRows();
    return {
      success: true,
      rows,
      row_count: rows.length,
    } satisfies ToolResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message } satisfies ToolResult;
  }
}

/**
 * SQL ドライランツール。SELECT 文のみを許容し、PREPARE/EXPLAIN で構文と型を検証する。
 */
async function sqlDryRunTool(
  args: SqlDryRunArgs,
  _context: ToolExecutionContext,
): Promise<SqlDryRunResult> {
  try {
    const rawQuery = ensureQueryString(args?.query);
    const query = normalizeSelectQuery(rawQuery);
    if (hasDanglingStatementTerminator(query)) {
      return {
        success: false,
        message:
          "sql_dry_run は 1 つの SELECT 文のみサポートします (追加のステートメントは無効です)。",
      } satisfies SqlDryRunResult;
    }
    if (!isSelectOnlyQuery(query)) {
      return {
        success: false,
        message: "sql_dry_run tool only supports SELECT statements.",
      } satisfies SqlDryRunResult;
    }
    const { plan } = await performSqlDryRun(query);
    return {
      success: true,
      plan,
    } satisfies SqlDryRunResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message } satisfies SqlDryRunResult;
  }
}

/**
 * sqruff を利用して SQL を整形し、結果テキストを返す。
 */
async function sqlFormatTool(
  args: SqlFormatArgs,
  context: ToolExecutionContext,
): Promise<SqlFormatResult> {
  try {
    const query = normalizeSelectQuery(ensureQueryString(args?.query));
    if (hasDanglingStatementTerminator(query)) {
      return {
        success: false,
        message: "sql_format は 1 つの SELECT 文のみを対象にしてください。",
      } satisfies SqlFormatResult;
    }
    const formatted = await formatSqlWithSqruff(query, context.cwd);
    return {
      success: true,
      formatted_sql: formatted,
    } satisfies SqlFormatResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message } satisfies SqlFormatResult;
  }
}

interface D2Args {
  file_path: string;
}

interface MermaidArgs {
  file_path: string;
}

async function d2CheckTool(args: D2Args, context: ToolExecutionContext): Promise<CommandResult> {
  const { cwd } = context;
  const resolvedPath = resolveWorkspacePath(args.file_path, cwd);
  return runCommand("d2", [resolvedPath], cwd);
}

async function d2FmtTool(args: D2Args, context: ToolExecutionContext): Promise<CommandResult> {
  const { cwd } = context;
  const resolvedPath = resolveWorkspacePath(args.file_path, cwd);
  return runCommand("d2", ["fmt", resolvedPath], cwd);
}

export const READ_FILE_TOOL: ToolRegistration<ReadFileArgs, ReadFileResult> = {
  definition: {
    type: "function",
    strict: true,
    name: "read_file",
    description: "Read a UTF-8 text file from the local workspace.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  handler: readFileTool,
};

export const WRITE_FILE_TOOL: ToolRegistration<WriteFileArgs, WriteFileResult> = {
  definition: {
    type: "function",
    strict: true,
    name: "write_file",
    description:
      "Overwrite a text file in the local workspace using UTF-8. Creates the file if it does not exist.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Target file path relative to the workspace root.",
        },
        content: {
          type: "string",
          description: "Text content to write into the file.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  handler: writeFileTool,
};

export const D2_CHECK_TOOL: ToolRegistration<D2Args, CommandResult> = {
  definition: {
    type: "function",
    strict: true,
    name: "d2_check",
    description: "Run `d2` to validate a diagram file without modifying it.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the D2 file relative to the workspace root.",
        },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  handler: d2CheckTool,
};

export const D2_FMT_TOOL: ToolRegistration<D2Args, CommandResult> = {
  definition: {
    type: "function",
    strict: true,
    name: "d2_fmt",
    description: "Run `d2 fmt` to format a diagram file in-place.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the D2 file relative to the workspace root.",
        },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  handler: d2FmtTool,
};

async function mermaidCheckTool(
  args: MermaidArgs,
  context: ToolExecutionContext,
): Promise<CommandResult> {
  const { cwd } = context;
  const resolvedPath = resolveWorkspacePath(args.file_path, cwd);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-5-mermaid-check-"));
  const outputPath = path.join(tempDir, "mermaid-output.svg");
  const binName = process.platform === "win32" ? "mmdc.cmd" : "mmdc";
  const cliPath = path.join(cwd, "node_modules", ".bin", binName);
  try {
    return await runCommand(cliPath, ["-i", resolvedPath, "-o", outputPath, "--quiet"], cwd);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export const MERMAID_CHECK_TOOL: ToolRegistration<MermaidArgs, CommandResult> = {
  definition: {
    type: "function",
    strict: true,
    name: "mermaid_check",
    description: "Run mermaid-cli to validate a Mermaid diagram file.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the Mermaid file relative to the workspace root.",
        },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  handler: mermaidCheckTool,
};

export const SQL_FETCH_SCHEMA_TOOL: ToolRegistration<Record<string, never>, ToolResult> = {
  definition: {
    type: "function",
    strict: true,
    name: "sql_fetch_schema",
    description: "Load table and column metadata from PostgreSQL using information_schema.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  handler: sqlFetchSchemaTool,
};

export const SQL_DRY_RUN_TOOL: ToolRegistration<SqlDryRunArgs, SqlDryRunResult> = {
  definition: {
    type: "function",
    strict: true,
    name: "sql_dry_run",
    description: "Validate a SELECT statement via PostgreSQL PREPARE and EXPLAIN (FORMAT JSON).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "SQL text to validate. Only SELECT/WITH ... SELECT is supported.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  handler: sqlDryRunTool,
};

export const SQL_FORMAT_TOOL: ToolRegistration<SqlFormatArgs, SqlFormatResult> = {
  definition: {
    type: "function",
    strict: true,
    name: "sql_format",
    description: "Format SQL using sqruff in fix mode and return the formatted text.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "SQL text to format.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  handler: sqlFormatTool,
};

/**
 * 任意のツール定義集合から実行ランタイムを構築する。
 *
 * @param registrations ツール定義とハンドラの配列。
 * @returns ツール一覧と実行メソッド。
 */
export function createToolRuntime<TContext extends ToolExecutionContext = ToolExecutionContext>(
  registrations: Iterable<ToolRegistration<any, any, TContext>>,
): ToolRuntime<TContext> {
  const entries = Array.from(registrations);
  const handlerMap = new Map<string, ToolHandler<any, ToolResult, TContext>>();
  for (const entry of entries) {
    if (handlerMap.has(entry.definition.name)) {
      throw new Error(`Duplicate tool name detected: ${entry.definition.name}`);
    }
    handlerMap.set(entry.definition.name, entry.handler);
  }

  async function execute(call: ResponseFunctionToolCall, context: TContext): Promise<string> {
    const { log } = context;
    const toolName = call.name;
    let parsedArgs: any = {};
    if (call.arguments) {
      try {
        parsedArgs = JSON.parse(call.arguments);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const payload = {
          success: false,
          message: `Failed to parse arguments for ${toolName}: ${message}`,
        } satisfies ToolResult;
        return JSON.stringify(payload);
      }
    }

    log(`[tool] ${toolName} invoked`);
    const handler = handlerMap.get(toolName);
    if (!handler) {
      const payload = { success: false, message: `Unknown tool: ${toolName}` } satisfies ToolResult;
      return JSON.stringify(payload);
    }

    try {
      const result = await handler(parsedArgs, context);
      return JSON.stringify(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const payload = { success: false, message } satisfies ToolResult;
      return JSON.stringify(payload);
    }
  }

  return {
    tools: entries.map((entry) => entry.definition),
    execute,
  };
}

export function buildCliToolList(
  registrations: Iterable<ToolRegistration<any, any>>,
): ResponseCreateParamsNonStreaming["tools"] {
  const functionTools: ResponseCreateParamsNonStreaming["tools"] = [];
  const seen = new Set<string>();

  for (const registration of registrations) {
    const { definition } = registration;
    if (definition.type !== "function") {
      continue;
    }
    if (seen.has(definition.name)) {
      continue;
    }
    functionTools.push(definition);
    seen.add(definition.name);
  }

  return [...functionTools, { type: "web_search_preview" as const }];
}
