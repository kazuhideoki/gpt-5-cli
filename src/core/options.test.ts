import { describe, expect, test } from "bun:test";

import { CORE_FUNCTION_TOOLS, buildCliToolList } from "./tools.js";
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
  test("コアツールとプレビュー検索を含む", () => {
    const tools = buildCliToolList();
    expect(tools).toEqual([...CORE_FUNCTION_TOOLS, { type: "web_search_preview" as const }]);
  });
});
