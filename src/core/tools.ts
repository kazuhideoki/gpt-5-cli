import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tool as defineAgentTool } from "@openai/agents";
import type { Tool as AgentsSdkTool } from "@openai/agents";
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

interface SqlTableSchemaRow {
  table_schema: string;
  table_name: string;
  table_type: string;
  is_insertable_into: string;
}

interface SqlColumnSchemaRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

interface SqlEnumValueRow {
  schema_name: string;
  enum_name: string;
  enum_label: string;
  sort_order: number;
}

interface SqlIndexSchemaRow {
  table_schema: string;
  table_name: string;
  index_name: string;
  index_definition: string;
}

interface SqlFetchTableSchemaArgs {
  schema_names?: string[];
  table_names?: string[];
  table_types?: string[];
}

interface SqlFetchColumnSchemaArgs {
  schema_names?: string[];
  table_names?: string[];
  column_names?: string[];
  tables?: SqlTableIdentifier[];
}

interface SqlTableIdentifier {
  schema_name: string;
  table_name: string;
}

interface SqlFetchEnumSchemaArgs {
  schema_names?: string[];
  enum_names?: string[];
}

interface SqlFetchIndexSchemaArgs {
  schema_names?: string[];
  table_names?: string[];
  index_names?: string[];
}

function requireEnvValue(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Environment variable ${name} is required for SQL tools.`);
  }
  return value;
}

function normalizeStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of non-empty strings.`);
  }
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${fieldName} must be an array of non-empty strings.`);
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      throw new Error(`${fieldName} must not contain empty strings.`);
    }
    if (!normalized.includes(trimmed)) {
      normalized.push(trimmed);
    }
  }
  if (normalized.length === 0) {
    throw new Error(`${fieldName} must not be an empty array.`);
  }
  return normalized;
}

function normalizeTableIdentifiers(
  value: unknown,
  fieldName: string,
): SqlTableIdentifier[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty array of { schema_name, table_name } objects.`);
  }
  const normalized: SqlTableIdentifier[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`${fieldName} must contain objects with schema_name and table_name.`);
    }
    const schemaRaw = (entry as Record<string, unknown>).schema_name;
    const tableRaw = (entry as Record<string, unknown>).table_name;
    if (typeof schemaRaw !== "string" || typeof tableRaw !== "string") {
      throw new Error(`${fieldName} entries require non-empty schema_name and table_name strings.`);
    }
    const schema = schemaRaw.trim();
    const table = tableRaw.trim();
    if (!schema || !table) {
      throw new Error(`${fieldName} entries require non-empty schema_name and table_name strings.`);
    }
    const exists = normalized.some(
      (item) => item.schema_name === schema && item.table_name === table,
    );
    if (!exists) {
      normalized.push({ schema_name: schema, table_name: table });
    }
  }
  if (normalized.length === 0) {
    throw new Error(`${fieldName} must be a non-empty array of unique table identifiers.`);
  }
  return normalized;
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

async function fetchSqlTableSchema(
  args: SqlFetchTableSchemaArgs = {},
): Promise<SqlTableSchemaRow[]> {
  const client = createPgClient();
  await client.connect();
  try {
    const filters = ["table_schema NOT IN ('pg_catalog', 'information_schema')"];
    const params: unknown[] = [];

    const schemaNames = normalizeStringArray(args.schema_names, "schema_names");
    if (schemaNames) {
      params.push(schemaNames);
      filters.push(`table_schema = ANY($${params.length}::text[])`);
    }

    const tableNames = normalizeStringArray(args.table_names, "table_names");
    if (tableNames) {
      params.push(tableNames);
      filters.push(`table_name = ANY($${params.length}::text[])`);
    }

    const tableTypes = normalizeStringArray(args.table_types, "table_types")?.map((value) =>
      value.toUpperCase(),
    );
    if (tableTypes && tableTypes.length > 0) {
      params.push(tableTypes);
      filters.push(`table_type = ANY($${params.length}::text[])`);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join("\n          AND ")}` : "";
    const result = await client.query<SqlTableSchemaRow>(
      `
        SELECT table_schema, table_name, table_type, is_insertable_into
        FROM information_schema.tables
        ${whereClause}
        ORDER BY table_schema, table_name
      `,
      params,
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function fetchSqlColumnSchema(
  args: SqlFetchColumnSchemaArgs = {},
): Promise<SqlColumnSchemaRow[]> {
  const client = createPgClient();
  await client.connect();
  try {
    const filters = ["table_schema NOT IN ('pg_catalog', 'information_schema')"];
    const params: unknown[] = [];

    const schemaNames = normalizeStringArray(args.schema_names, "schema_names");
    if (schemaNames) {
      params.push(schemaNames);
      filters.push(`table_schema = ANY($${params.length}::text[])`);
    }

    const tableNames = normalizeStringArray(args.table_names, "table_names");
    if (tableNames) {
      params.push(tableNames);
      filters.push(`table_name = ANY($${params.length}::text[])`);
    }

    const columnNames = normalizeStringArray(args.column_names, "column_names");
    if (columnNames) {
      params.push(columnNames);
      filters.push(`column_name = ANY($${params.length}::text[])`);
    }

    const tableIdentifiers = normalizeTableIdentifiers(args.tables, "tables");
    if (tableIdentifiers) {
      const pairClauses: string[] = [];
      for (const identifier of tableIdentifiers) {
        params.push(identifier.schema_name);
        const schemaIndex = params.length;
        params.push(identifier.table_name);
        const tableIndex = params.length;
        pairClauses.push(`(table_schema = $${schemaIndex} AND table_name = $${tableIndex})`);
      }
      if (pairClauses.length > 0) {
        filters.push(`(${pairClauses.join(" OR ")})`);
      }
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join("\n          AND ")}` : "";
    const result = await client.query<SqlColumnSchemaRow>(
      `
        SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        ${whereClause}
        ORDER BY table_schema, table_name, ordinal_position
      `,
      params,
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function fetchSqlEnumValues(args: SqlFetchEnumSchemaArgs = {}): Promise<SqlEnumValueRow[]> {
  const client = createPgClient();
  await client.connect();
  try {
    const filters = ["n.nspname NOT IN ('pg_catalog', 'information_schema')", "t.typtype = 'e'"];
    const params: unknown[] = [];

    const schemaNames = normalizeStringArray(args.schema_names, "schema_names");
    if (schemaNames) {
      params.push(schemaNames);
      filters.push(`n.nspname = ANY($${params.length}::text[])`);
    }

    const enumNames = normalizeStringArray(args.enum_names, "enum_names");
    if (enumNames) {
      params.push(enumNames);
      filters.push(`t.typname = ANY($${params.length}::text[])`);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join("\n          AND ")}` : "";
    const result = await client.query<SqlEnumValueRow>(
      `
        SELECT
          n.nspname AS schema_name,
          t.typname AS enum_name,
          e.enumlabel AS enum_label,
          e.enumsortorder AS sort_order
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        ${whereClause}
        ORDER BY n.nspname, t.typname, e.enumsortorder
      `,
      params,
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function fetchSqlIndexSchema(
  args: SqlFetchIndexSchemaArgs = {},
): Promise<SqlIndexSchemaRow[]> {
  const client = createPgClient();
  await client.connect();
  try {
    const filters = ["schemaname NOT IN ('pg_catalog', 'information_schema')"];
    const params: unknown[] = [];

    const schemaNames = normalizeStringArray(args.schema_names, "schema_names");
    if (schemaNames) {
      params.push(schemaNames);
      filters.push(`schemaname = ANY($${params.length}::text[])`);
    }

    const tableNames = normalizeStringArray(args.table_names, "table_names");
    if (tableNames) {
      params.push(tableNames);
      filters.push(`tablename = ANY($${params.length}::text[])`);
    }

    const indexNames = normalizeStringArray(args.index_names, "index_names");
    if (indexNames) {
      params.push(indexNames);
      filters.push(`indexname = ANY($${params.length}::text[])`);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join("\n          AND ")}` : "";
    const result = await client.query<SqlIndexSchemaRow>(
      `
        SELECT
          schemaname AS table_schema,
          tablename AS table_name,
          indexname AS index_name,
          indexdef AS index_definition
        FROM pg_indexes
        ${whereClause}
        ORDER BY schemaname, tablename, indexname
      `,
      params,
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

async function sqlFetchTableSchemaTool(
  args: SqlFetchTableSchemaArgs = {},
  _context: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    const rows = await fetchSqlTableSchema(args);
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

async function sqlFetchColumnSchemaTool(
  args: SqlFetchColumnSchemaArgs = {},
  _context: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    const rows = await fetchSqlColumnSchema(args);
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

async function sqlFetchEnumSchemaTool(
  args: SqlFetchEnumSchemaArgs = {},
  _context: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    const rows = await fetchSqlEnumValues(args);
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

async function sqlFetchIndexSchemaTool(
  args: SqlFetchIndexSchemaArgs = {},
  _context: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    const rows = await fetchSqlIndexSchema(args);
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

const MERMAID_BIN_NAME = process.platform === "win32" ? "mmdc.cmd" : "mmdc";

export interface ResolvedMermaidCommand {
  command: string;
  args: string[];
}

interface MermaidPackageJsonShape {
  bin?: string | Record<string, string>;
}

export async function resolveMermaidCommand(): Promise<ResolvedMermaidCommand> {
  const requireFromHere = createRequire(import.meta.url);

  try {
    const packageJsonPath = requireFromHere.resolve("@mermaid-js/mermaid-cli/package.json");
    const packageDirectory = path.dirname(packageJsonPath);
    const packageJsonContent = await fs.readFile(packageJsonPath, { encoding: "utf8" });
    const packageJson = JSON.parse(packageJsonContent) as MermaidPackageJsonShape;
    const binField = packageJson.bin;

    let scriptRelative: string | undefined;

    if (typeof binField === "string") {
      scriptRelative = binField;
    } else if (binField && typeof binField === "object") {
      const record = binField as Record<string, unknown>;
      const prioritizedKeys = ["mmdc", "mermaid"];
      for (const key of prioritizedKeys) {
        const candidate = record[key];
        if (typeof candidate === "string" && candidate.length > 0) {
          scriptRelative = candidate;
          break;
        }
      }
      if (!scriptRelative) {
        const fallback = Object.values(record).find(
          (entry): entry is string => typeof entry === "string" && entry.length > 0,
        );
        scriptRelative = fallback;
      }
    }

    if (typeof scriptRelative === "string" && scriptRelative.length > 0) {
      const scriptAbsolute = path.resolve(packageDirectory, scriptRelative);
      await fs.access(scriptAbsolute);
      return { command: process.execPath, args: [scriptAbsolute] };
    }
  } catch {
    // ignore and fall through to PATH lookup
  }

  return { command: MERMAID_BIN_NAME, args: [] };
}

async function mermaidCheckTool(
  args: MermaidArgs,
  context: ToolExecutionContext,
): Promise<CommandResult> {
  const { cwd } = context;
  const resolvedPath = resolveWorkspacePath(args.file_path, cwd);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-5-mermaid-check-"));
  const outputPath = path.join(tempDir, "mermaid-output.svg");
  const { command, args: commandArgs } = await resolveMermaidCommand();
  const argsWithTargets = [...commandArgs, "-i", resolvedPath, "-o", outputPath, "--quiet"];
  try {
    return await runCommand(command, argsWithTargets, cwd);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export const MERMAID_CHECK_TOOL: ToolRegistration<MermaidArgs, CommandResult> = {
  definition: {
    type: "function",
    strict: true,
    name: "mermaid_check",
    description:
      "Run mermaid-cli to validate a Mermaid diagram file. When using Markdown, wrap the diagram in a ```mermaid``` block.",
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

export const SQL_FETCH_TABLE_SCHEMA_TOOL: ToolRegistration<SqlFetchTableSchemaArgs, ToolResult> = {
  definition: {
    type: "function",
    strict: false,
    name: "sql_fetch_table_schema",
    description: "Retrieve table metadata from PostgreSQL information_schema.tables.",
    parameters: {
      type: "object",
      properties: {
        schema_names: {
          type: "array",
          description: "Filter by schema names (exact match).",
          items: { type: "string" },
        },
        table_names: {
          type: "array",
          description: "Filter by table names (exact match).",
          items: { type: "string" },
        },
        table_types: {
          type: "array",
          description: "Filter by table_type (BASE TABLE, VIEW, MATERIALIZED VIEW, etc.).",
          items: { type: "string" },
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  handler: sqlFetchTableSchemaTool,
};

export const SQL_FETCH_COLUMN_SCHEMA_TOOL: ToolRegistration<SqlFetchColumnSchemaArgs, ToolResult> =
  {
    definition: {
      type: "function",
      strict: false,
      name: "sql_fetch_column_schema",
      description: "Retrieve column metadata from PostgreSQL information_schema.columns.",
      parameters: {
        type: "object",
        properties: {
          schema_names: {
            type: "array",
            description: "Filter by schema names (exact match).",
            items: { type: "string" },
          },
          table_names: {
            type: "array",
            description: "Filter by table names (exact match).",
            items: { type: "string" },
          },
        column_names: {
          type: "array",
          description: "Filter by column names (exact match).",
          items: { type: "string" },
        },
        tables: {
          type: "array",
          description: "Filter by (schema_name, table_name) pairs.",
          items: {
            type: "object",
            properties: {
              schema_name: { type: "string" },
              table_name: { type: "string" },
            },
            required: ["schema_name", "table_name"],
            additionalProperties: false,
          },
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  handler: sqlFetchColumnSchemaTool,
};

export const SQL_FETCH_ENUM_SCHEMA_TOOL: ToolRegistration<SqlFetchEnumSchemaArgs, ToolResult> = {
  definition: {
    type: "function",
    strict: false,
    name: "sql_fetch_enum_schema",
    description: "Retrieve enum labels defined in PostgreSQL (pg_type/pg_enum).",
    parameters: {
      type: "object",
      properties: {
        schema_names: {
          type: "array",
          description: "Filter by schema names (exact match).",
          items: { type: "string" },
        },
        enum_names: {
          type: "array",
          description: "Filter by enum type names (exact match).",
          items: { type: "string" },
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  handler: sqlFetchEnumSchemaTool,
};

export const SQL_FETCH_INDEX_SCHEMA_TOOL: ToolRegistration<SqlFetchIndexSchemaArgs, ToolResult> = {
  definition: {
    type: "function",
    strict: false,
    name: "sql_fetch_index_schema",
    description: "Retrieve index metadata from PostgreSQL pg_indexes.",
    parameters: {
      type: "object",
      properties: {
        schema_names: {
          type: "array",
          description: "Filter by schema names (exact match).",
          items: { type: "string" },
        },
        table_names: {
          type: "array",
          description: "Filter by table names (exact match).",
          items: { type: "string" },
        },
        index_names: {
          type: "array",
          description: "Filter by index names (exact match).",
          items: { type: "string" },
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  handler: sqlFetchIndexSchemaTool,
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

export interface BuildAgentsToolListOptions {
  createExecutionContext?: () => ToolExecutionContext;
  debugLog?: (message: string) => void;
  logLabel?: string;
}

/**
 * Agents SDK で利用可能なツール配列を構築する。
 *
 * @param registrations CLI 向けに登録済みのツール定義。
 * @param options 実行時ログやデバッグ出力の設定。
 * @returns Agents SDK で利用可能なツール配列。
 */
export function buildAgentsToolList(
  registrations: Iterable<ToolRegistration<any, any>>,
  options: BuildAgentsToolListOptions = {},
): AgentsSdkTool[] {
  const entries = Array.from(registrations).filter(
    (registration) => registration.definition.type === "function",
  );
  const logPrefix = options.logLabel ? `${options.logLabel} ` : "";
  const defaultExecutionContext =
    options.createExecutionContext ??
    (() => ({
      cwd: process.cwd(),
      log: (message: string) => {
        console.log(`${logPrefix}${message}`);
      },
    }));

  const formatJsonSnippet = (value: unknown, limit = 600): string => {
    try {
      const pretty = JSON.stringify(value, null, 2);
      if (pretty.length <= limit) {
        return pretty;
      }
      return `${pretty.slice(0, limit)}…(+${pretty.length - limit} chars)`;
    } catch {
      const serialized = String(value ?? "");
      if (serialized.length <= limit) {
        return serialized;
      }
      return `${serialized.slice(0, limit)}…(+${serialized.length - limit} chars)`;
    }
  };

  const formatPlainSnippet = (raw: string, limit = 600): string => {
    const text = raw.trim();
    if (text.length <= limit) {
      return text;
    }
    return `${text.slice(0, limit)}…(+${text.length - limit} chars)`;
  };

  type AgentExecutionDetails = { toolCall?: { call_id?: string; id?: string } };

  return entries.map((registration) => {
    const { definition, handler } = registration;
    return defineAgentTool({
      name: definition.name,
      description: definition.description ?? "",
      parameters: definition.parameters as any,
      strict: definition.strict ?? false,
      execute: async (
        input: unknown,
        _runContext: unknown,
        details?: AgentExecutionDetails,
      ): Promise<string> => {
        const context = defaultExecutionContext();
        const callId = details?.toolCall?.call_id ?? details?.toolCall?.id ?? "";
        const label = callId ? `${definition.name} (${callId})` : definition.name;
        context.log(`tool handling ${label}`);
        if (options.debugLog) {
          options.debugLog(`tool_call ${label} arguments:\n${formatJsonSnippet(input ?? {})}`);
        }

        let result: ToolResult | string;
        try {
          const args = (input ?? {}) as Record<string, unknown>;
          result = await handler(args, context);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          context.log(`tool error ${label}: ${message}`);
          if (options.debugLog) {
            options.debugLog(`tool_call ${label} failed: ${message}`);
          }
          return JSON.stringify({ success: false, message });
        }

        const serialized = typeof result === "string" ? result : JSON.stringify(result);
        if (options.debugLog) {
          options.debugLog(`tool_call ${label} output:\n${formatPlainSnippet(serialized)}`);
        }
        return serialized;
      },
    });
  });
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
