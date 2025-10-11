import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryStore, formatTurnsForSummary } from "./history.js";
import type { HistoryEntry } from "./types.js";

let tempDir: string;
let historyPath: string;
let store: HistoryStore;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-cli-history-test-"));
  historyPath = path.join(tempDir, "history.json");
  store = new HistoryStore(historyPath);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("HistoryStore", () => {
  it("ensureInitialized がファイルを用意する", () => {
    store.ensureInitialized();
    expect(fs.existsSync(historyPath)).toBe(true);
    expect(fs.readFileSync(historyPath, "utf8")).toBe("[]\n");
  });

  it("loadEntries は不正な JSON を無視する", () => {
    store.ensureInitialized();
    fs.writeFileSync(historyPath, "{", "utf8");
    expect(store.loadEntries()).toEqual([]);
  });

  it("saveEntries/loadEntries がラウンドトリップする", () => {
    const entries: HistoryEntry[] = [
      { last_response_id: "1", title: "first" },
      { last_response_id: "2", title: "second" },
    ];
    store.saveEntries(entries);
    expect(store.loadEntries()).toEqual(entries);
  });

  it("selectByNumber は更新日時でソートする", () => {
    const entries: HistoryEntry[] = [
      { last_response_id: "a", updated_at: "2024-06-01T00:00:00Z" },
      { last_response_id: "b", updated_at: "2024-06-03T00:00:00Z" },
      { last_response_id: "c", updated_at: "2024-06-02T00:00:00Z" },
    ];
    store.saveEntries(entries);
    expect(store.selectByNumber(1).last_response_id).toBe("b");
    expect(store.selectByNumber(2).last_response_id).toBe("c");
    expect(() => store.selectByNumber(4)).toThrow("[openai_api] 無効な履歴番号です");
  });

  it("deleteByNumber は対象を削除する", () => {
    const entries: HistoryEntry[] = [
      { last_response_id: "a", updated_at: "2024-06-01T00:00:00Z", title: "old" },
      { last_response_id: "b", updated_at: "2024-06-03T00:00:00Z", title: "latest" },
      { last_response_id: "c", updated_at: "2024-06-02T00:00:00Z", title: "mid" },
    ];
    store.saveEntries(entries);
    const result = store.deleteByNumber(2);
    expect(result.removedId).toBe("c");
    expect(result.removedTitle).toBe("mid");
    const remaining = store.loadEntries().map((entry) => entry.last_response_id);
    expect(remaining).toEqual(["a", "b"]);
    expect(() => store.deleteByNumber(3)).toThrow("[openai_api] 無効な履歴番号です");
  });
});

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
