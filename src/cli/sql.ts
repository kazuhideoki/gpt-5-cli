#!/usr/bin/env bun
/**
 * @file SQL モードの CLI エントリーポイント。PostgreSQL 接続を利用したスキーマ取得、
 * SELECT 文のドライラン検証、Sqruff による整形、LLM による修正ワークフローを提供する。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { Client } from "pg";
import type { QueryResultRow } from "pg";
import { loadEnvironment } from "../core/config.js";

export type Dialect = "postgres";

interface SchemaRow extends QueryResultRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

interface DryRunResult {
  plan: unknown;
}

interface ResponsesTextContent {
  type: "text";
  text: string;
}

interface ResponsesUserMessage {
  role: "user";
  content: ResponsesTextContent[];
}

interface ResponsesRequestBody {
  model: string;
  input: ResponsesUserMessage[];
}

interface ResponsesSuccessBody {
  output_text?: string;
}

interface ResponsesErrorBody {
  error?: {
    message?: string;
  };
}

/** 必須の環境変数を取得する。 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`環境変数 ${name} が未設定です`);
  }
  return value;
}

/** 与えられた SQL が SELECT 系のみで構成されているかを判定する。 */
export function isSelectOnly(sql: string): boolean {
  const noComments = sql
    .replace(/--.*$/gmu, "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .trim();
  return /^\s*(with\b[\s\S]*?\bselect\b|select\b)/iu.test(noComments);
}

/** 標準入力またはファイルから SQL テキストを読み込む。 */
async function readStdinOrFile(maybePath?: string): Promise<string> {
  if (maybePath) {
    await stat(maybePath);
    return readFile(maybePath, "utf8");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Sqruff を用いて SQL を整形する。 */
export async function formatWithSqruff(sql: string): Promise<string> {
  const bin = (process.env.SQRUFF_BIN ?? "sqruff").trim() || "sqruff";
  const dir = await mkdtemp(path.join(tmpdir(), "sqruff-"));
  const file = path.join(dir, "input.sql");
  await writeFile(file, sql, "utf8");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, ["fix", file], { stdio: "inherit" });
    child.once("error", (error) => {
      reject(error);
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`sqruff failed with exit code ${code ?? 0}`));
      }
    });
  });

  return readFile(file, "utf8");
}

/** PostgreSQL クライアントを生成する。 */
function createPgClient(): Client {
  const dsn = requireEnv("POSTGRES_DSN");
  return new Client({ connectionString: dsn });
}

/** PostgreSQL の information_schema からスキーマ情報を取得する。 */
async function fetchSchema(): Promise<SchemaRow[]> {
  const client = createPgClient();
  await client.connect();
  try {
    const result = await client.query<SchemaRow>(
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

/** PostgreSQL エラーオブジェクトからメッセージを抽出する。 */
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
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** SELECT 文を PREPARE/EXPLAIN で検証し、実行計画を取得する。 */
async function performDryRun(sql: string): Promise<DryRunResult> {
  const client = createPgClient();
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`PREPARE __sqlcheck__ AS ${sql}`);
    await client.query("DEALLOCATE __sqlcheck__");
    const explain = await client.query(`EXPLAIN (VERBOSE, COSTS OFF, FORMAT JSON) ${sql}`);
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

/** SELECT 文をドライランし、結果を JSON で出力する。 */
async function cmdDryRun(filePath?: string): Promise<void> {
  const sql = await readStdinOrFile(filePath);
  if (!isSelectOnly(sql)) {
    throw new Error("SQLモードは SELECT/WITH ... SELECT のみ対応です。");
  }
  const result = await performDryRun(sql);
  const output = { ok: true, plan: result.plan };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

/** Sqruff で整形した SQL を標準出力へ書き出す。 */
async function cmdFormat(filePath?: string): Promise<void> {
  const sql = await readStdinOrFile(filePath);
  const formatted = await formatWithSqruff(sql);
  process.stdout.write(formatted);
}

/** スキーマ情報を取得して JSON として出力する。 */
async function cmdSchema(): Promise<void> {
  const rows = await fetchSchema();
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}

/** DSN 文字列のハッシュを生成する。 */
function hashDsn(dsn: string): string {
  const digest = createHash("sha256").update(dsn).digest("hex");
  return `sha256:${digest}`;
}

interface RevisionParams {
  original: string;
  intent?: string;
  schemaRows: SchemaRow[];
  dsnHash: string;
  dryRunError?: string;
}

/** LLM に提示するプロンプト文字列を構築する。 */
function buildRevisionPrompt(params: RevisionParams): string {
  const schemaJson = JSON.stringify(params.schemaRows);
  const truncatedSchema = schemaJson.length > 48000 ? `${schemaJson.slice(0, 48000)}...` : schemaJson;
  const segments: string[] = [
    "次の条件で SELECT 文のみを1本だけ返してください。余計なCTEやコメントは不要です。",
    "- 方言: PostgreSQL",
    "- 構文/型エラーを避ける（必要なら明示キャスト）",
    "- 返答はSQLテキストのみ",
    "",
    `意図: ${params.intent ?? "(なし)"}`,
    `スキーマ(JSON 行数=${params.schemaRows.length} / dsn=${params.dsnHash}):`,
    truncatedSchema,
    "",
    "元SQL:",
    params.original,
  ];
  if (params.dryRunError) {
    segments.push("", "直前の dry-run エラー:", params.dryRunError);
  }
  return segments.join("\n");
}

/** LLM へ修正 SQL を要求する。 */
async function requestSqlRevision(params: RevisionParams): Promise<string> {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const body: ResponsesRequestBody = {
    model: "gpt-5-thinking",
    input: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildRevisionPrompt(params),
          },
        ],
      },
    ],
  };
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let data: ResponsesSuccessBody & ResponsesErrorBody;
  try {
    data = (await response.json()) as ResponsesSuccessBody & ResponsesErrorBody;
  } catch (error) {
    if (!response.ok) {
      throw new Error(`OpenAI API error: HTTP ${response.status}`);
    }
    throw new Error(`OpenAI API response parse error: ${toErrorMessage(error)}`);
  }
  if (!response.ok) {
    const message = data.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`OpenAI API error: ${message}`);
  }
  const text = typeof data.output_text === "string" ? data.output_text.trim() : "";
  if (text.length === 0) {
    throw new Error("OpenAI からの応答に SQL が含まれていません");
  }
  return text;
}

/** LLM を用いた SQL 修正ワークフローを実行する。 */
async function cmdRevise(filePath?: string, intent?: string): Promise<void> {
  const original = await readStdinOrFile(filePath);
  if (!isSelectOnly(original)) {
    throw new Error("SQLモードは SELECT/WITH ... SELECT のみ対応です。");
  }
  const schemaRows = await fetchSchema();
  const dsnHash = hashDsn(requireEnv("POSTGRES_DSN"));

  let dryRunError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidate = await requestSqlRevision({
      original,
      intent,
      schemaRows,
      dsnHash,
      dryRunError,
    });
    const formatted = await formatWithSqruff(candidate);
    try {
      await performDryRun(formatted);
      const output = formatted.endsWith("\n") ? formatted : `${formatted}\n`;
      process.stdout.write(output);
      return;
    } catch (error) {
      dryRunError = buildPgErrorMessage(error);
      if (attempt === 1) {
        throw new Error(`dry-run failed after revision attempts: ${dryRunError}`);
      }
    }
  }
}

/** 汎用的なエラーメッセージ整形。 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

/** コマンド実行時の共通エラーハンドリング。 */
async function runCommand(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = toErrorMessage(error);
    if (message.trim().length > 0) {
      console.error(message);
    }
    process.exit(1);
  }
}

/** SQL モード CLI 全体を実行する。 */
async function runSqlCli(): Promise<void> {
  loadEnvironment();
  const program = new Command();
  program
    .name("gpt-5-cli-sql")
    .description("SQL mode utilities for gpt-5-cli")
    .configureOutput({
      writeErr: (str) => {
        const trimmed = str.replace(/\s+$/u, "");
        if (trimmed.length > 0) {
          console.error(trimmed);
        }
      },
    })
    .showSuggestionAfterError(false)
    .exitOverride();

  program
    .command("schema")
    .description("print schema as JSON")
    .action(async () => {
      await runCommand(cmdSchema);
    });

  program
    .command("dry-run")
    .argument("[file]", "path to SQL file")
    .description("validate SELECT statements via PREPARE & EXPLAIN")
    .action(async (file?: string) => {
      await runCommand(() => cmdDryRun(file));
    });

  program
    .command("format")
    .argument("[file]", "path to SQL file")
    .description("format SQL using sqruff")
    .action(async (file?: string) => {
      await runCommand(() => cmdFormat(file));
    });

  program
    .command("revise")
    .argument("[file]", "path to SQL file")
    .argument("[intent]", "intent description")
    .description("revise SQL via LLM, format, and dry-run")
    .action(async (file?: string, intentArg?: string) => {
      await runCommand(() => cmdRevise(file, intentArg));
    });

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      const message = error.message.trim();
      if (message.length > 0) {
        console.error(message);
      }
      process.exit(error.exitCode);
      return;
    }
    throw error;
  }
}

if (import.meta.main) {
  await runSqlCli();
}
