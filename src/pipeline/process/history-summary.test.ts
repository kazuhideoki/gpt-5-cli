import { describe, expect, it } from "bun:test";
import { formatTurnsForSummary } from "./history-summary.js";

describe("formatTurnsForSummary", () => {
  it("ラベルを言語化して整形する", () => {
    const text = formatTurnsForSummary([
      { role: "user", text: "こんにちは" },
      { role: "assistant", text: "どうしましたか？" },
      { role: "system", kind: "summary", text: "要約です" },
      { role: "tool", text: "ignore" },
    ]);
    expect(text).toBe(
      "ユーザー:\nこんにちは\n\n---\n\nアシスタント:\nどうしましたか？\n\n---\n\nシステム要約:\n要約です\n\n---\n\ntool:\nignore",
    );
  });
});
