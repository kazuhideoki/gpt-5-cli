/**
 * SQL 関連ツールをまとめたモジュール。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import mysql, { type Connection as MysqlConnection } from "mysql2/promise";

import type { ToolExecutionContext } from "./runtime.js";
import type { ToolRegistration, ToolResult } from "./runtime.js";
import { runCommand } from "./command.js";

type SqlEngineKind = "postgresql" | "mysql";

interface SqlEnvironment {
  dsn: string;
  engine: SqlEngineKind;
  /** sqruff バイナリへの解決結果。 */
  sqruffBin: string;
}

let activeSqlEnvironment: SqlEnvironment | undefined;

export function setSqlEnvironment(environment: SqlEnvironment | undefined): void {
  activeSqlEnvironment = environment;
}

interface SqlTableSchemaRow {
  table_schema: string;
  table_name: string;
  table_type: string;
  /** PostgreSQL の information_schema.tables では提供されるが、MySQL では列自体が存在しない。 */
  is_insertable_into?: string;
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

function requireSqlEnvironment(): SqlEnvironment {
  if (!activeSqlEnvironment) {
    throw new Error(
      "SQL environment is not configured. Pass --dsn to the CLI before invoking SQL tools.",
    );
  }
  return activeSqlEnvironment;
}

/**
 * 文字列配列を検証し、空文字や重複を除いた結果を返す。
 *
 * @param value ユーザー入力値。
 * @param fieldName エラー表示に用いるフィールド名。
 * @returns 正規化済み配列。未指定時は undefined。
 */
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

/**
 * `(schema_name, table_name)` オブジェクト配列を検証し、重複を排除した結果を返す。
 *
 * @param value ユーザー入力値。
 * @param fieldName エラー表示に用いるフィールド名。
 * @returns 正規化済みのテーブル識別子配列。未指定時は undefined。
 */
function normalizeTableIdentifiers(
  value: unknown,
  fieldName: string,
): SqlTableIdentifier[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `${fieldName} must be a non-empty array of { schema_name, table_name } objects.`,
    );
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

/**
 * PostgreSQL 由来のエラーから message/detail/hint を抽出して結合する。
 *
 * @param error 捕捉した例外。
 * @returns ユーザーへ表示するメッセージ。
 */
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

function buildMysqlErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const maybeError = error as { message?: unknown; sqlMessage?: unknown };
    if (typeof maybeError.sqlMessage === "string" && maybeError.sqlMessage.length > 0) {
      return maybeError.sqlMessage;
    }
    if (typeof maybeError.message === "string" && maybeError.message.length > 0) {
      return maybeError.message;
    }
  }
  if (error instanceof Error && typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

/**
 * 与えられた DSN から PostgreSQL クライアントを構築する。
 */
function createPgClient(dsn: string): Client {
  return new Client({ connectionString: dsn });
}

async function createMysqlConnection(dsn: string): Promise<MysqlConnection> {
  return mysql.createConnection(dsn);
}

/**
 * information_schema.tables を参照してテーブル定義を取得する。
 *
 * @param args スキーマ・テーブル名・テーブル種別フィルタ。
 * @returns テーブル情報の配列。
 */
async function fetchSqlTableSchema(
  args: SqlFetchTableSchemaArgs = {},
): Promise<SqlTableSchemaRow[]> {
  const env = requireSqlEnvironment();
  if (env.engine === "postgresql") {
    return fetchPgTableSchema(env.dsn, args);
  }
  return fetchMysqlTableSchema(env.dsn, args);
}

async function fetchPgTableSchema(
  dsn: string,
  args: SqlFetchTableSchemaArgs = {},
): Promise<SqlTableSchemaRow[]> {
  const client = createPgClient(dsn);
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

async function fetchMysqlTableSchema(
  dsn: string,
  args: SqlFetchTableSchemaArgs = {},
): Promise<SqlTableSchemaRow[]> {
  const connection = await createMysqlConnection(dsn);
  try {
    const filters = [
      "table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')",
    ];
    const params: unknown[] = [];

    const schemaNames = normalizeStringArray(args.schema_names, "schema_names");
    if (schemaNames) {
      params.push(schemaNames);
      filters.push(`table_schema IN (?)`);
    }

    const tableNames = normalizeStringArray(args.table_names, "table_names");
    if (tableNames) {
      params.push(tableNames);
      filters.push(`table_name IN (?)`);
    }

    const tableTypes = normalizeStringArray(args.table_types, "table_types")?.map((value) =>
      value.toUpperCase(),
    );
    if (tableTypes && tableTypes.length > 0) {
      params.push(tableTypes);
      filters.push(`UPPER(table_type) IN (?)`);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join("\n          AND ")}` : "";
    const [rows] = await connection.execute(
      `
        SELECT
          table_schema,
          table_name,
          table_type
        FROM information_schema.tables
        ${whereClause}
        ORDER BY table_schema, table_name
      `,
      params,
    );
    return rows as SqlTableSchemaRow[];
  } finally {
    await connection.end();
  }
}

/**
 * information_schema.columns を参照してカラム定義を取得する。
 *
 * @param args スキーマ・テーブル・カラム・複数テーブル指定によるフィルタ。
 * @returns カラム情報の配列。
 */
async function fetchSqlColumnSchema(
  args: SqlFetchColumnSchemaArgs = {},
): Promise<SqlColumnSchemaRow[]> {
  const env = requireSqlEnvironment();
  if (env.engine === "postgresql") {
    return fetchPgColumnSchema(env.dsn, args);
  }
  return fetchMysqlColumnSchema(env.dsn, args);
}

async function fetchPgColumnSchema(
  dsn: string,
  args: SqlFetchColumnSchemaArgs = {},
): Promise<SqlColumnSchemaRow[]> {
  const client = createPgClient(dsn);
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

async function fetchMysqlColumnSchema(
  dsn: string,
  args: SqlFetchColumnSchemaArgs = {},
): Promise<SqlColumnSchemaRow[]> {
  const connection = await createMysqlConnection(dsn);
  try {
    const filters = [
      "table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')",
    ];
    const params: unknown[] = [];

    const schemaNames = normalizeStringArray(args.schema_names, "schema_names");
    if (schemaNames) {
      params.push(schemaNames);
      filters.push(`table_schema IN (?)`);
    }

    const tableNames = normalizeStringArray(args.table_names, "table_names");
    if (tableNames) {
      params.push(tableNames);
      filters.push(`table_name IN (?)`);
    }

    const columnNames = normalizeStringArray(args.column_names, "column_names");
    if (columnNames) {
      params.push(columnNames);
      filters.push(`column_name IN (?)`);
    }

    const tableIdentifiers = normalizeTableIdentifiers(args.tables, "tables");
    if (tableIdentifiers) {
      const pairClauses: string[] = [];
      for (const identifier of tableIdentifiers) {
        params.push(identifier.schema_name);
        params.push(identifier.table_name);
        pairClauses.push(`(table_schema = ? AND table_name = ?)`);
      }
      if (pairClauses.length > 0) {
        filters.push(`(${pairClauses.join(" OR ")})`);
      }
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join("\n          AND ")}` : "";
    const [rows] = await connection.execute(
      `
        SELECT
          table_schema,
          table_name,
          column_name,
          data_type,
          is_nullable,
          column_default
        FROM information_schema.columns
        ${whereClause}
        ORDER BY table_schema, table_name, ordinal_position
      `,
      params,
    );
    return rows as SqlColumnSchemaRow[];
  } finally {
    await connection.end();
  }
}

/**
 * pg_type/pg_enum を参照して ENUM 値を取得する。
 *
 * @param args フィルタ条件。
 * @returns ENUM ラベル一覧。
 */
async function fetchSqlEnumValues(args: SqlFetchEnumSchemaArgs = {}): Promise<SqlEnumValueRow[]> {
  const env = requireSqlEnvironment();
  if (env.engine === "postgresql") {
    return fetchPgEnumValues(env.dsn, args);
  }
  return fetchMysqlEnumValues(env.dsn, args);
}

async function fetchPgEnumValues(
  dsn: string,
  args: SqlFetchEnumSchemaArgs = {},
): Promise<SqlEnumValueRow[]> {
  const client = createPgClient(dsn);
  await client.connect();
  try {
    const filters = ["nspname NOT IN ('pg_catalog', 'information_schema')"];
    const params: unknown[] = [];

    const schemaNames = normalizeStringArray(args.schema_names, "schema_names");
    if (schemaNames) {
      params.push(schemaNames);
      filters.push(`nspname = ANY($${params.length}::text[])`);
    }

    const enumNames = normalizeStringArray(args.enum_names, "enum_names");
    if (enumNames) {
      params.push(enumNames);
      filters.push(`typname = ANY($${params.length}::text[])`);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join("\n          AND ")}` : "";
    const result = await client.query<SqlEnumValueRow>(
      `
        SELECT
          nspname AS schema_name,
          typname AS enum_name,
          enumlabel AS enum_label,
          enumsortorder AS sort_order
        FROM pg_type
        JOIN pg_enum ON pg_enum.enumtypid = pg_type.oid
        JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
        ${whereClause}
        ORDER BY nspname, typname, enumsortorder
      `,
      params,
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

interface MysqlEnumRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  column_type?: string | null;
}

function parseMysqlEnumLabels(columnType: string): string[] {
  const normalized = columnType.trim();
  if (!normalized.startsWith("enum(") || !normalized.endsWith(")")) {
    return [];
  }
  const body = normalized.replace(/^enum\s*\(/iu, "").replace(/\)$/u, "");
  const labels: string[] = [];
  let current = "";
  let inQuote = false;
  for (let index = 0; index < body.length; index += 1) {
    const ch = body[index] as string;
    const next = body[index + 1] as string | undefined;
    if (!inQuote) {
      if (ch === "'") {
        inQuote = true;
        current = "";
      }
      continue;
    }

    if (ch === "'" && next === "'") {
      current += "'";
      index += 1;
      continue;
    }

    if (ch === "\\" && next) {
      current += next;
      index += 1;
      continue;
    }

    if (ch === "'") {
      labels.push(current);
      current = "";
      inQuote = false;
      continue;
    }

    current += ch;
  }
  if (inQuote) {
    labels.push(current);
  }
  return labels;
}

async function fetchMysqlEnumValues(
  dsn: string,
  args: SqlFetchEnumSchemaArgs = {},
): Promise<SqlEnumValueRow[]> {
  const connection = await createMysqlConnection(dsn);
  try {
    const filters = [
      "table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')",
      "data_type = 'enum'",
    ];
    const params: unknown[] = [];

    const schemaNames = normalizeStringArray(args.schema_names, "schema_names");
    if (schemaNames) {
      params.push(schemaNames);
      filters.push(`table_schema IN (?)`);
    }

    const enumNames = normalizeStringArray(args.enum_names, "enum_names");
    if (enumNames) {
      const columnOnlyNames = new Set<string>();
      const qualifiedConditions: string[] = [];
      const qualifiedValues: unknown[] = [];

      for (const name of enumNames) {
        const parts = name
          .split(".")
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        if (parts.length === 0) {
          continue;
        }
        const column = parts.pop() as string;
        if (parts.length === 0) {
          columnOnlyNames.add(column);
        }
        const table = parts.pop();
        const schema = parts.length > 0 ? parts.join(".") : undefined;

        if (table || schema) {
          const clauses: string[] = [];
          if (schema) {
            clauses.push("table_schema = ?");
            qualifiedValues.push(schema);
          }
          if (table) {
            clauses.push("table_name = ?");
            qualifiedValues.push(table);
          }
          clauses.push("column_name = ?");
          qualifiedValues.push(column);
          qualifiedConditions.push(`(${clauses.join(" AND ")})`);
        }
      }

      if (columnOnlyNames.size > 0) {
        params.push([...columnOnlyNames]);
        filters.push(`column_name IN (?)`);
      }

      if (qualifiedConditions.length > 0) {
        filters.push(`(${qualifiedConditions.join(" OR ")})`);
        params.push(...qualifiedValues);
      }
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join("\n          AND ")}` : "";
    const [rows] = await connection.execute(
      `
        SELECT
          table_schema,
          table_name,
          column_name,
          column_type
        FROM information_schema.columns
        ${whereClause}
        ORDER BY table_schema, table_name, column_name
      `,
      params,
    );
    const typedRows = rows as MysqlEnumRow[];

    const results: SqlEnumValueRow[] = [];
    for (const row of typedRows) {
      const labels = parseMysqlEnumLabels(row.column_type ?? "");
      labels.forEach((label, index) => {
        results.push({
          schema_name: row.table_schema,
          enum_name: `${row.table_name}.${row.column_name}`,
          enum_label: label,
          sort_order: index + 1,
        });
      });
    }
    return results;
  } finally {
    await connection.end();
  }
}

/**
 * pg_indexes / information_schema.statistics を参照してインデックス定義を取得する。
 *
 * @param args スキーマ・テーブル・インデックス名フィルタ。
 * @returns インデックス情報の配列。
 */
async function fetchSqlIndexSchema(
  args: SqlFetchIndexSchemaArgs = {},
): Promise<SqlIndexSchemaRow[]> {
  const env = requireSqlEnvironment();
  if (env.engine === "postgresql") {
    return fetchPgIndexSchema(env.dsn, args);
  }
  return fetchMysqlIndexSchema(env.dsn, args);
}

async function fetchPgIndexSchema(
  dsn: string,
  args: SqlFetchIndexSchemaArgs = {},
): Promise<SqlIndexSchemaRow[]> {
  const client = createPgClient(dsn);
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

async function fetchMysqlIndexSchema(
  dsn: string,
  args: SqlFetchIndexSchemaArgs = {},
): Promise<SqlIndexSchemaRow[]> {
  const connection = await createMysqlConnection(dsn);
  try {
    const filters = [
      "table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')",
    ];
    const params: unknown[] = [];

    const schemaNames = normalizeStringArray(args.schema_names, "schema_names");
    if (schemaNames) {
      params.push(schemaNames);
      filters.push(`table_schema IN (?)`);
    }

    const tableNames = normalizeStringArray(args.table_names, "table_names");
    if (tableNames) {
      params.push(tableNames);
      filters.push(`table_name IN (?)`);
    }

    const indexNames = normalizeStringArray(args.index_names, "index_names");
    if (indexNames) {
      params.push(indexNames);
      filters.push(`index_name IN (?)`);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join("\n          AND ")}` : "";
    const [rows] = await connection.execute(
      `
        SELECT
          table_schema,
          table_name,
          index_name,
          CONCAT(
            CASE WHEN index_name = 'PRIMARY' THEN 'PRIMARY KEY' ELSE
              CONCAT(CASE WHEN non_unique = 0 THEN 'UNIQUE INDEX ' ELSE 'INDEX ' END, index_name)
            END,
            ' (',
            GROUP_CONCAT(
              CONCAT(column_name, CASE collation WHEN 'A' THEN ' ASC' WHEN 'D' THEN ' DESC' ELSE '' END)
              ORDER BY seq_in_index SEPARATOR ', '
            ),
            ')'
          ) AS index_definition
        FROM information_schema.statistics
        ${whereClause}
        GROUP BY table_schema, table_name, index_name, non_unique
        ORDER BY table_schema, table_name, index_name
      `,
      params,
    );
    return rows as SqlIndexSchemaRow[];
  } finally {
    await connection.end();
  }
}

/**
 * PREPARE/EXPLAIN を用いて SELECT クエリを検証し、プラン情報を返す。
 *
 * @param query 検証対象の SQL。
 * @returns EXPLAIN JSON のプラン。
 */
async function performSqlDryRun(query: string): Promise<{ plan: unknown }> {
  const env = requireSqlEnvironment();
  if (env.engine === "postgresql") {
    return performPostgresDryRun(env.dsn, query);
  }
  return performMysqlDryRun(env.dsn, query);
}

async function performPostgresDryRun(dsn: string, query: string): Promise<{ plan: unknown }> {
  const client = createPgClient(dsn);
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

async function performMysqlDryRun(dsn: string, query: string): Promise<{ plan: unknown }> {
  const connection = await createMysqlConnection(dsn);
  try {
    const [rows] = await connection.query(`EXPLAIN FORMAT=JSON ${query}`);
    const planRow = Array.isArray(rows) ? rows[0] : undefined;
    let plan: unknown = planRow;
    if (planRow && typeof planRow === "object" && planRow !== null && "EXPLAIN" in planRow) {
      const explainValue = (planRow as Record<string, unknown>).EXPLAIN;
      plan = explainValue ?? planRow;
    }
    return { plan };
  } catch (error) {
    throw new Error(buildMysqlErrorMessage(error));
  } finally {
    await connection.end();
  }
}

/**
 * sqruff を利用してクエリを整形し、整形済み SQL を返す。
 *
 * @param query 整形対象の SQL。
 * @param cwd 実行時の作業ディレクトリ。
 * @returns 整形済み SQL テキスト。
 */
async function formatSqlWithSqruff(query: string, cwd: string): Promise<string> {
  const env = requireSqlEnvironment();
  const bin = env.sqruffBin;
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
