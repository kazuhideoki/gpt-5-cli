import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "pg";

import {
  SQL_DRY_RUN_TOOL,
  SQL_FETCH_TABLE_SCHEMA_TOOL,
  setSqlEnvironment,
  type ToolExecutionContext,
  type ToolResult,
} from "./index.js";

const ORIGINAL_PG_CONNECT = Client.prototype.connect;
const ORIGINAL_PG_QUERY = Client.prototype.query;
const ORIGINAL_PG_END = Client.prototype.end;

afterEach(() => {
  setSqlEnvironment(undefined);
  Client.prototype.connect = ORIGINAL_PG_CONNECT;
  Client.prototype.query = ORIGINAL_PG_QUERY;
  Client.prototype.end = ORIGINAL_PG_END;
});

describe("SQL tools", () => {
  it("SQL 環境未設定時は失敗レスポンスを返す", async () => {
    const context: ToolExecutionContext = { cwd: process.cwd(), log: () => {} };
    const result = (await SQL_FETCH_TABLE_SCHEMA_TOOL.handler({}, context)) as ToolResult;
    expect(result.success).toBe(false);
    expect(result.message).toContain("SQL environment is not configured");
  });

  it("SQL ドライランで PREPARE エラーを捕捉する", async () => {
    setSqlEnvironment({ dsn: "postgres://example.invalid/db", engine: "postgresql" });

    Client.prototype.connect = async () => {};
    Client.prototype.query = async () => {
      throw Object.assign(new Error("prepare failed"), { detail: "extra detail" });
    };
    Client.prototype.end = async () => {};

    const context: ToolExecutionContext = { cwd: process.cwd(), log: () => {} };
    const result = (await SQL_DRY_RUN_TOOL.handler({ query: "SELECT 1" }, context)) as ToolResult;
    expect(result.success).toBe(false);
    expect(result.message).toContain("prepare failed");
  });
});
