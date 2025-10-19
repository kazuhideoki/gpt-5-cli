import { describe, expect, it } from "bun:test";
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
  type ToolRegistration,
  type ToolResult,
} from "./index.js";

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

describe("createToolRuntime", () => {
  it("最小構成は read_file のみを公開する", () => {
    const { tools } = createToolRuntime(MINIMAL_TOOLSET);
    expect(tools.map((tool) => tool.name)).toEqual(["read_file"]);
  });

  it("ワークスペース操作向け拡張セットを構築できる", () => {
    const { tools } = createToolRuntime(D2_TOOLSET);
    expect(tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "write_file",
      "d2_check",
      "d2_fmt",
    ]);
  });

  it("Mermaid 向けツールセットを構築できる", () => {
    const { tools } = createToolRuntime(MERMAID_TOOLSET);
    expect(tools.map((tool) => tool.name)).toEqual(["read_file", "write_file", "mermaid_check"]);
  });

  it("SQL 向け拡張セットを構築できる", () => {
    const { tools } = createToolRuntime(SQL_TOOLSET);
    expect(tools.map((tool) => tool.name)).toEqual([
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

  it("未知のツール名は失敗レスポンスを返す", async () => {
    const { execute } = createToolRuntime(D2_TOOLSET);
    const call: ResponseFunctionToolCall = {
      type: "function_call",
      id: "call-unknown",
      call_id: "call-unknown",
      name: "unknown_tool",
      arguments: "{}",
    };
    const result = JSON.parse(
      await execute(call, {
        cwd: process.cwd(),
        log: () => {},
      }),
    ) as ToolResult;
    expect(result.success).toBe(false);
    expect(result.message).toContain("Unknown tool");
  });
});

describe("buildAgentsToolList", () => {
  const createExecutionContext = () => ({
    cwd: process.cwd(),
    log: () => {},
  });

  it("エージェント向けにツールを組み立てる", () => {
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

  it("実行時エラーを捕捉し、失敗レスポンスを返すハンドラを構築する", () => {
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
