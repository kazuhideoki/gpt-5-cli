import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import mysql from "mysql2/promise";
import type { ResponseFunctionToolCall } from "openai/resources/responses/responses";

import {
  D2_CHECK_TOOL,
  D2_FMT_TOOL,
  MERMAID_CHECK_TOOL,
  READ_FILE_TOOL,
  SQL_DRY_RUN_TOOL,
  SQL_FETCH_COLUMN_SCHEMA_TOOL,
  SQL_FETCH_ENUM_SCHEMA_TOOL,
  SQL_FETCH_INDEX_SCHEMA_TOOL,
  SQL_FETCH_TABLE_SCHEMA_TOOL,
  SQL_FORMAT_TOOL,
  WRITE_FILE_TOOL,
  buildAgentsToolList,
  buildCliToolList,
  createToolRuntime,
  resolveMermaidCommand,
  resolveWorkspacePath,
  setSqlEnvironment,
  type ToolRegistration,
  type ToolResult,
} from "./index.js";

function createCall(name: string, args: Record<string, unknown>): ResponseFunctionToolCall {
  return {
    type: "function_call",
    id: `call-${name}`,
    call_id: `call-${name}`,
    name,
    arguments: JSON.stringify(args),
  };
}

const MINIMAL_TOOLSET = [READ_FILE_TOOL] as const;
const D2_TOOLSET = [READ_FILE_TOOL, WRITE_FILE_TOOL, D2_CHECK_TOOL, D2_FMT_TOOL] as const;
const MERMAID_TOOLSET = [READ_FILE_TOOL, WRITE_FILE_TOOL, MERMAID_CHECK_TOOL] as const;
const SQL_TOOLSET = [
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  SQL_FETCH_TABLE_SCHEMA_TOOL,
  SQL_FETCH_COLUMN_SCHEMA_TOOL,
  SQL_FETCH_ENUM_SCHEMA_TOOL,
  SQL_FETCH_INDEX_SCHEMA_TOOL,
  SQL_DRY_RUN_TOOL,
  SQL_FORMAT_TOOL,
] as const;

const { tools: MINIMAL_FUNCTION_TOOLS } = createToolRuntime(MINIMAL_TOOLSET);
const { tools: D2_FUNCTION_TOOLS, execute: executeD2ToolCall } = createToolRuntime(D2_TOOLSET);
const { tools: MERMAID_FUNCTION_TOOLS } = createToolRuntime(MERMAID_TOOLSET);
const { tools: SQL_FUNCTION_TOOLS, execute: executeSqlToolCall } = createToolRuntime(SQL_TOOLSET);

const ORIGINAL_SQRUFF_BIN = process.env.SQRUFF_BIN;
const ORIGINAL_MYSQL_CREATE_CONNECTION = mysql.createConnection;

afterEach(() => {
  if (ORIGINAL_SQRUFF_BIN === undefined) {
    delete process.env.SQRUFF_BIN;
  } else {
    process.env.SQRUFF_BIN = ORIGINAL_SQRUFF_BIN;
  }

  mysql.createConnection = ORIGINAL_MYSQL_CREATE_CONNECTION;
  setSqlEnvironment(undefined);
});

describe("tool registration lists", () => {
  it("最小構成は read_file のみを公開する", () => {
    const toolNames = MINIMAL_FUNCTION_TOOLS.map((tool) => tool.name);
    expect(toolNames).toEqual(["read_file"]);
  });

  it("最小構成には SQL 系ツールが含まれない", () => {
    const toolNames = MINIMAL_FUNCTION_TOOLS.map((tool) => tool.name);
    expect(toolNames).not.toContain("sql_fetch_table_schema");
    expect(toolNames).not.toContain("sql_fetch_column_schema");
    expect(toolNames).not.toContain("sql_fetch_enum_schema");
    expect(toolNames).not.toContain("sql_fetch_index_schema");
    expect(toolNames).not.toContain("sql_dry_run");
    expect(toolNames).not.toContain("sql_format");
  });

  it("SQL 向け拡張セットを構築できる", () => {
    const toolNames = SQL_FUNCTION_TOOLS.map((tool) => tool.name);
    expect(toolNames).toEqual([
      "read_file",
      "write_file",
      "sql_fetch_table_schema",
      "sql_fetch_column_schema",
      "sql_fetch_enum_schema",
      "sql_fetch_index_schema",
      "sql_dry_run",
      "sql_format",
    ]);
  });

  it("ワークスペース操作向け拡張セットを構築できる", () => {
    const toolNames = D2_FUNCTION_TOOLS.map((tool) => tool.name);
    expect(toolNames).toEqual(["read_file", "write_file", "d2_check", "d2_fmt"]);
  });

  it("Mermaid 向けツールセットを構築できる", () => {
    const toolNames = MERMAID_FUNCTION_TOOLS.map((tool) => tool.name);
    expect(toolNames).toEqual(["read_file", "write_file", "mermaid_check"]);
  });
});

describe("resolveWorkspacePath", () => {
  it("ワークスペース内のファイルを許可する", () => {
    const workspace = path.join(process.cwd(), "tmp-workspace");
    const resolved = resolveWorkspacePath("diagram.d2", workspace);
    expect(resolved).toBe(path.join(workspace, "diagram.d2"));
  });

  it("ルートディレクトリのワークスペースでもファイルを許可する", () => {
    const root = path.parse(process.cwd()).root;
    const resolved = resolveWorkspacePath("diagram.d2", root);
    expect(resolved).toBe(path.resolve(root, "diagram.d2"));
  });

  it("ワークスペース外の参照は拒否する", () => {
    const workspace = path.join(process.cwd(), "tmp-workspace");
    expect(() => resolveWorkspacePath("../outside.txt", workspace)).toThrow(
      "Access to path outside workspace is not allowed: ../outside.txt",
    );
  });
});

describe("executeFunctionToolCall", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-cli-tools-"));
    setSqlEnvironment({ dsn: "postgres://example.invalid/db", engine: "postgresql" });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("ファイルの書き込みと読み取りを往復できる", async () => {
    const writeCall = createCall("write_file", {
      path: "diagram.d2",
      content: "a -> b",
    });
    const writeResult = JSON.parse(
      await executeD2ToolCall(writeCall, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(writeResult.success).toBe(true);
    expect(writeResult.path).toBe("diagram.d2");

    const readCall = createCall("read_file", { path: "diagram.d2" });
    const readResult = JSON.parse(
      await executeD2ToolCall(readCall, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(readResult.success).toBe(true);
    expect(readResult.content).toBe("a -> b");
  });

  it("ワークスペース外のパスは拒否される", async () => {
    const readCall = createCall("read_file", { path: "../secret.txt" });
    const result = JSON.parse(
      await executeD2ToolCall(readCall, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("outside workspace");
  });

  it("未知のツール名は失敗を返す", async () => {
    const call: ResponseFunctionToolCall = {
      type: "function_call",
      id: "call-unknown",
      call_id: "call-unknown",
      name: "unknown_tool",
      arguments: "{}",
    };
    const result = JSON.parse(
      await executeD2ToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("Unknown tool");
  });
});

describe("buildAgentsToolList", () => {
  const createExecutionContext = () => ({
    cwd: process.cwd(),
    log: () => {},
  });

  it("エージェント向けにツールを組み立てる", async () => {
    const registration: ToolRegistration<{ path: string }, ToolResult> = {
      definition: READ_FILE_TOOL.definition,
      handler: READ_FILE_TOOL.handler,
    };
    const [agentTool] = buildAgentsToolList([registration], { createExecutionContext });
    expect(agentTool.name).toBe("read_file");
    expect(typeof agentTool.invoke).toBe("function");
    expect(typeof agentTool.needsApproval).toBe("function");
    expect(typeof agentTool.isEnabled).toBe("function");
  });

  it("実行時エラーを捕捉し、失敗レスポンスを返す", async () => {
    const registration: ToolRegistration = {
      definition: {
        ...READ_FILE_TOOL.definition,
        name: "error_tool",
      },
      handler: async () => {
        throw new Error("boom");
      },
    };
    const [agentTool] = buildAgentsToolList([registration], { createExecutionContext });
    expect(agentTool.name).toBe("error_tool");
    expect(typeof agentTool.invoke).toBe("function");
  });
});

describe("resolveMermaidCommand", () => {
  it("Mermaid CLI を見つけられない場合は PATH にフォールバックする", async () => {
    const resolved = await resolveMermaidCommand();
    expect(resolved.command.length).toBeGreaterThan(0);
  });
});

describe("buildCliToolList", () => {
  const MINIMAL_TOOL_REGISTRATIONS = [READ_FILE_TOOL] as const;

  const D2_TOOL_REGISTRATIONS = [
    READ_FILE_TOOL,
    WRITE_FILE_TOOL,
    D2_CHECK_TOOL,
    D2_FMT_TOOL,
  ] as const;

  const MERMAID_TOOL_REGISTRATIONS = [READ_FILE_TOOL, WRITE_FILE_TOOL, MERMAID_CHECK_TOOL] as const;

  const SQL_TOOL_REGISTRATIONS = [
    READ_FILE_TOOL,
    SQL_FETCH_TABLE_SCHEMA_TOOL,
    SQL_FETCH_COLUMN_SCHEMA_TOOL,
    SQL_FETCH_ENUM_SCHEMA_TOOL,
    SQL_FETCH_INDEX_SCHEMA_TOOL,
    SQL_DRY_RUN_TOOL,
    SQL_FORMAT_TOOL,
  ] as const;

  it("コアツールとプレビュー検索を含む", () => {
    const tools = buildCliToolList(MINIMAL_TOOL_REGISTRATIONS);
    expect(tools).toEqual([
      MINIMAL_TOOL_REGISTRATIONS[0].definition,
      { type: "web_search_preview" as const },
    ]);
  });

  it("追加ツール登録を引数で拡張できる", () => {
    const tools = buildCliToolList([
      ...D2_TOOL_REGISTRATIONS,
      ...MERMAID_TOOL_REGISTRATIONS,
      ...SQL_TOOL_REGISTRATIONS,
    ]);
    const functionNames = tools.filter((tool) => tool.type === "function").map((tool) => tool.name);
    expect(functionNames).toEqual([
      "read_file",
      "write_file",
      "d2_check",
      "d2_fmt",
      "mermaid_check",
      "sql_fetch_table_schema",
      "sql_fetch_column_schema",
      "sql_fetch_enum_schema",
      "sql_fetch_index_schema",
      "sql_dry_run",
      "sql_format",
    ]);
    expect(tools.at(-1)).toEqual({ type: "web_search_preview" as const });
  });
});

describe("SQL tools", () => {
  let originalPgClientConnect: typeof Client.prototype.connect;
  let originalPgClientQuery: typeof Client.prototype.query;
  let originalPgClientEnd: typeof Client.prototype.end;

  beforeEach(() => {
    originalPgClientConnect = Client.prototype.connect;
    originalPgClientQuery = Client.prototype.query;
    originalPgClientEnd = Client.prototype.end;
  });

  afterEach(() => {
    Client.prototype.connect = originalPgClientConnect;
    Client.prototype.query = originalPgClientQuery;
    Client.prototype.end = originalPgClientEnd;
  });

  it("SQL 環境未設定時は例外を投げる", async () => {
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
    Client.prototype.connect = async () => {};
    Client.prototype.query = async () => {
      throw Object.assign(new Error("prepare failed"), { detail: "extra detail" });
    };
    Client.prototype.end = async () => {};

    const call = createCall("sql_dry_run", { query: "SELECT 1" });
    const result = JSON.parse(
      await executeSqlToolCall(call, {
        cwd: process.cwd(),
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("prepare failed");
  });
});
