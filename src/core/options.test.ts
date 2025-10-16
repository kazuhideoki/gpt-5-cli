import { describe, expect, test } from "bun:test";

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
  buildCliToolList,
} from "./tools.js";
import { expandLegacyShortFlags, parseHistoryFlag } from "./options.js";

describe("parseHistoryFlag", () => {
  test("未指定の場合は一覧フラグなしで返す", () => {
    expect(parseHistoryFlag(undefined)).toEqual({ listOnly: false });
  });

  test("true を渡すと一覧表示のみを示す", () => {
    expect(parseHistoryFlag(true)).toEqual({ listOnly: true });
  });

  test("数値文字列は履歴番号として扱う", () => {
    expect(parseHistoryFlag("12")).toEqual({ index: 12, listOnly: false });
  });

  test("不正な入力はエラーになる", () => {
    expect(() => parseHistoryFlag("abc" as unknown as string)).toThrow(
      "Error: 履歴番号は正の整数で指定してください",
    );
  });
});

describe("expandLegacyShortFlags", () => {
  test("連結された履歴フラグを展開する", () => {
    const expanded = expandLegacyShortFlags(["-m1e2v0"]);
    expect(expanded).toEqual(["-m", "1", "-e", "2", "-v", "0"]);
  });

  test("-- 以降は展開せずに維持する", () => {
    const expanded = expandLegacyShortFlags(["-m1", "--", "-abc"]);
    expect(expanded).toEqual(["-m", "1", "--", "-abc"]);
  });

  test("値を伴わない -m はエラーになる", () => {
    expect(() => expandLegacyShortFlags(["-m"])).toThrow(
      "Invalid option: -m には 0/1/2 を続けてください（例: -m1）",
    );
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

  test("コアツールとプレビュー検索を含む", () => {
    const tools = buildCliToolList(MINIMAL_TOOL_REGISTRATIONS);
    expect(tools).toEqual([
      MINIMAL_TOOL_REGISTRATIONS[0].definition,
      { type: "web_search_preview" as const },
    ]);
  });

  test("追加ツール登録を引数で拡張できる", () => {
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
