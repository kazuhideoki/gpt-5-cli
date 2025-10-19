import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "pg";
import mysql from "mysql2/promise";
import type { ResponseFunctionToolCall } from "openai/resources/responses/responses";

import {
  READ_FILE_TOOL,
  SQL_DRY_RUN_TOOL,
  SQL_FETCH_COLUMN_SCHEMA_TOOL,
  SQL_FETCH_ENUM_SCHEMA_TOOL,
  SQL_FETCH_INDEX_SCHEMA_TOOL,
  SQL_FETCH_TABLE_SCHEMA_TOOL,
  SQL_FORMAT_TOOL,
  createToolRuntime,
  setSqlEnvironment,
  type ToolResult,
} from "./index.js";

const SQL_TOOLSET = [
  READ_FILE_TOOL,
  SQL_FETCH_TABLE_SCHEMA_TOOL,
  SQL_FETCH_COLUMN_SCHEMA_TOOL,
  SQL_FETCH_ENUM_SCHEMA_TOOL,
  SQL_FETCH_INDEX_SCHEMA_TOOL,
  SQL_DRY_RUN_TOOL,
  SQL_FORMAT_TOOL,
] as const;

const { execute: executeSqlToolCall } = createToolRuntime(SQL_TOOLSET);

const ORIGINAL_MYSQL_CREATE_CONNECTION = mysql.createConnection;

afterEach(() => {
  mysql.createConnection = ORIGINAL_MYSQL_CREATE_CONNECTION;
  setSqlEnvironment(undefined);
});

function createCall(name: string, args: Record<string, unknown>): ResponseFunctionToolCall {
  return {
    type: "function_call",
    id: `call-${name}`,
    call_id: `call-${name}`,
    name,
    arguments: JSON.stringify(args),
  };
}

describe("SQL tools", () => {
  it("SQL 環境未設定時は失敗レスポンスを返す", async () => {
    const call = createCall("sql_fetch_table_schema", {});
    const result = JSON.parse(
      await executeSqlToolCall(call, {
        cwd: process.cwd(),
        log: () => {},
      }),
    ) as ToolResult;
    expect(result.success).toBe(false);
    expect(result.message).toContain("SQL environment is not configured");
  });

  it("SQL ドライランで PREPARE エラーを捕捉する", async () => {
    setSqlEnvironment({ dsn: "postgres://example.invalid/db", engine: "postgresql" });

    const originalConnect = Client.prototype.connect;
    const originalQuery = Client.prototype.query;
    const originalEnd = Client.prototype.end;

    Client.prototype.connect = async () => {};
    Client.prototype.query = async () => {
      throw Object.assign(new Error("prepare failed"), { detail: "extra detail" });
    };
    Client.prototype.end = async () => {};

    try {
      const call = createCall("sql_dry_run", { query: "SELECT 1" });
      const result = JSON.parse(
        await executeSqlToolCall(call, {
          cwd: process.cwd(),
          log: () => {},
        }),
      ) as ToolResult;
      expect(result.success).toBe(false);
      expect(result.message).toContain("prepare failed");
    } finally {
      Client.prototype.connect = originalConnect;
      Client.prototype.query = originalQuery;
      Client.prototype.end = originalEnd;
    }
  });
});
