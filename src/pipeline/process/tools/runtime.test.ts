import { describe, expect, it } from "bun:test";

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
  type ToolRegistration,
  type ToolResult,
} from "./index.js";

const MINIMAL_TOOLSET = [READ_FILE_TOOL] as const;
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

  it("Function ツール定義のみを返す", () => {
    const tools = buildCliToolList(MINIMAL_TOOLSET);
    expect(tools).toEqual([MINIMAL_TOOLSET[0].definition]);
  });

  it("複数レジストレーションを順番通りに連結する", () => {
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
  });

  it("重複登録された Function 名を除外する", () => {
    const tools = buildCliToolList([...D2_TOOL_REGISTRATIONS, READ_FILE_TOOL, WRITE_FILE_TOOL]);
    const functionNames = tools.filter((tool) => tool.type === "function").map((tool) => tool.name);
    expect(functionNames).toEqual(["read_file", "write_file", "d2_check", "d2_fmt"]);
  });
});
