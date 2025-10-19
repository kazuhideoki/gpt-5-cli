import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryStore, formatTurnsForSummary } from "./history.js";
import type { HistoryEntry } from "./history.js";
import { z } from "zod";

type TestContext = {
  cli?: string;
  file_path?: string;
  output?: {
    file?: string;
    copy?: boolean;
  };
};

const testContextSchema = z.object({
  cli: z.string().optional(),
  file_path: z.string().optional(),
  output: z
    .object({
      file: z.string().optional(),
      copy: z.boolean().optional(),
    })
    .optional(),
});

let tempDir: string;
let historyPath: string;
let store: HistoryStore<TestContext>;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-cli-history-test-"));
  historyPath = path.join(tempDir, "history.json");
  store = new HistoryStore<TestContext>(historyPath, {
    contextSchema: testContextSchema,
  });
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

  it("loadEntries は不正な JSON でエラーを投げる", () => {
    store.ensureInitialized();
    fs.writeFileSync(historyPath, "{", "utf8");
    expect(() => store.loadEntries()).toThrow("[gpt-5-cli] failed to parse history index");
  });

  it("saveEntries/loadEntries がラウンドトリップする", () => {
    const entries: HistoryEntry<TestContext>[] = [
      { last_response_id: "1", title: "first" },
      { last_response_id: "2", title: "second" },
    ];
    store.saveEntries(entries);
    expect(store.loadEntries()).toEqual(entries);
  });

  it("context メタデータも保存・復元できる", () => {
    const entries: HistoryEntry<TestContext>[] = [
      {
        last_response_id: "d2-1",
        context: { cli: "d2", file_path: "/tmp/out.d2" },
      },
    ];
    store.saveEntries(entries);
    expect(store.loadEntries()).toEqual(entries);
  });

  it("selectByNumber は更新日時でソートする", () => {
    const entries: HistoryEntry<TestContext>[] = [
      { last_response_id: "a", updated_at: "2024-06-01T00:00:00Z" },
      { last_response_id: "b", updated_at: "2024-06-03T00:00:00Z" },
      { last_response_id: "c", updated_at: "2024-06-02T00:00:00Z" },
    ];
    store.saveEntries(entries);
    expect(store.selectByNumber(1).last_response_id).toBe("b");
    expect(store.selectByNumber(2).last_response_id).toBe("c");
    expect(() => store.selectByNumber(4)).toThrow("[gpt-5-cli] 無効な履歴番号です");
  });

  it("deleteByNumber は対象を削除する", () => {
    const entries: HistoryEntry<TestContext>[] = [
      {
        last_response_id: "a",
        updated_at: "2024-06-01T00:00:00Z",
        title: "old",
      },
      {
        last_response_id: "b",
        updated_at: "2024-06-03T00:00:00Z",
        title: "latest",
      },
      {
        last_response_id: "c",
        updated_at: "2024-06-02T00:00:00Z",
        title: "mid",
      },
    ];
    store.saveEntries(entries);
    const result = store.deleteByNumber(2);
    expect(result.removedId).toBe("c");
    expect(result.removedTitle).toBe("mid");
    const remaining = store.loadEntries().map((entry) => entry.last_response_id);
    expect(remaining).toEqual(["a", "b"]);
    expect(() => store.deleteByNumber(3)).toThrow("[gpt-5-cli] 無効な履歴番号です");
  });

  it("entryFilter で別 CLI の履歴を除外できる", () => {
    const scopedStore = new HistoryStore<TestContext>(historyPath, {
      contextSchema: testContextSchema,
      entryFilter: (entry) => {
        const cli = entry.context?.cli;
        if (typeof cli !== "string") {
          return true;
        }
        return cli === "ask";
      },
    });
    const entries: HistoryEntry<TestContext>[] = [
      {
        last_response_id: "ask-old",
        updated_at: "2024-06-01T00:00:00Z",
        context: { cli: "ask" },
      },
      {
        last_response_id: "d2-entry",
        updated_at: "2024-06-04T00:00:00Z",
        context: { cli: "d2" },
      },
      {
        last_response_id: "ask-latest",
        updated_at: "2024-06-05T00:00:00Z",
        context: { cli: "ask" },
      },
    ];
    scopedStore.saveEntries(entries);

    expect(scopedStore.selectByNumber(1).last_response_id).toBe("ask-latest");
    expect(scopedStore.selectByNumber(2).last_response_id).toBe("ask-old");
    expect(() => scopedStore.selectByNumber(3)).toThrow("[gpt-5-cli] 無効な履歴番号です");

    const result = scopedStore.deleteByNumber(2);
    expect(result.removedId).toBe("ask-old");
    const remainingIds = scopedStore.loadEntries().map((entry) => entry.last_response_id);
    expect(remainingIds).toEqual(["d2-entry", "ask-latest"]);
  });

  it("upsertConversation が新規エントリを追加する", () => {
    store.upsertConversation({
      metadata: {
        model: "gpt-5-nano",
        effort: "low",
        verbosity: "low",
      },
      context: {
        isNewConversation: true,
        titleToUse: "first",
      },
      responseId: "resp-1",
      userText: "hello",
      assistantText: "hi",
    });

    const entries = store.loadEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.last_response_id).toBe("resp-1");
    expect(entry.turns?.map((turn) => turn.text)).toEqual(["hello", "hi"]);
    expect(entry.resume?.previous_response_id).toBe("resp-1");
  });

  it("upsertConversation が既存エントリを更新し要約を維持する", () => {
    const existing: HistoryEntry<TestContext> = {
      title: "existing",
      last_response_id: "resp-prev",
      request_count: 2,
      turns: [
        { role: "user", text: "old" },
        { role: "assistant", text: "reply" },
      ],
      resume: { mode: "response_id", previous_response_id: "resp-prev" },
    };
    store.saveEntries([existing]);

    store.upsertConversation({
      metadata: {
        model: "gpt-5-mini",
        effort: "medium",
        verbosity: "high",
      },
      context: {
        isNewConversation: false,
        titleToUse: "existing",
        previousResponseId: "resp-prev",
        resumeSummaryText: "まとめ",
        previousContext: existing.context,
      },
      responseId: "resp-new",
      userText: "question",
      assistantText: "answer",
    });

    const [updated] = store.loadEntries();
    expect(updated.last_response_id).toBe("resp-new");
    expect(updated.request_count).toBe(3);
    expect(updated.turns?.slice(-2).map((turn) => turn.text)).toEqual(["question", "answer"]);
    expect(updated.resume?.previous_response_id).toBe("resp-new");
    expect(updated.resume?.summary?.text).toBe("まとめ");
  });

  it("upsertConversation は context を指定しない場合に previousContext を引き継ぐ", () => {
    const absPath = path.join(tempDir, "keep.d2");
    const existingContext: TestContext = { cli: "d2", file_path: absPath };
    const existing: HistoryEntry<TestContext> = {
      title: "diagram",
      last_response_id: "resp-prev",
      updated_at: "2024-06-01T00:00:00Z",
      context: existingContext,
      turns: [{ role: "user", text: "old" }],
    };
    store.saveEntries([existing]);

    store.upsertConversation({
      metadata: {
        model: "gpt-5-mini",
        effort: "medium",
        verbosity: "medium",
      },
      context: {
        isNewConversation: false,
        titleToUse: "diagram",
        previousResponseId: "resp-prev",
        previousContext: existingContext,
      },
      responseId: "resp-next",
      userText: "続き",
      assistantText: "了解",
    });

    const [updated] = store.loadEntries();
    expect(updated.context?.file_path).toBe(absPath);
    expect(updated.context).toEqual(existingContext);
  });

  it("upsertConversation は context を明示すると既存を置き換える", () => {
    const existing: HistoryEntry<TestContext> = {
      title: "diagram",
      last_response_id: "resp-prev",
      context: { cli: "ask" },
    };
    store.saveEntries([existing]);

    store.upsertConversation({
      metadata: {
        model: "gpt-5-mini",
        effort: "medium",
        verbosity: "medium",
      },
      context: {
        isNewConversation: false,
        titleToUse: "diagram",
        previousResponseId: "resp-prev",
        previousContext: existing.context,
      },
      responseId: "resp-next",
      userText: "更新",
      assistantText: "完了",
      contextData: { cli: "d2", file_path: "/tmp/new.d2" },
    });

    const [updated] = store.loadEntries();
    expect(updated.context?.cli).toBe("d2");
    expect(updated.context?.file_path).toBe("/tmp/new.d2");
  });

  it("upsertConversation が d2 タスクメタデータを保存する", () => {
    const absPath = path.join(tempDir, "diagram.d2");

    store.upsertConversation({
      metadata: {
        model: "gpt-5-nano",
        effort: "low",
        verbosity: "low",
      },
      context: {
        isNewConversation: true,
        titleToUse: "diagram",
      },
      responseId: "resp-d2",
      userText: "draw",
      assistantText: "done",
      contextData: { cli: "d2", file_path: absPath },
    });

    const entry = store.loadEntries()[0];
    expect(entry.context?.cli).toBe("d2");
    expect(entry.context?.file_path).toBe(absPath);
  });

  it("listHistory が出力情報を表示する", () => {
    const entry: HistoryEntry<TestContext> = {
      last_response_id: "resp-output",
      updated_at: "2024-06-05T00:00:00Z",
      title: "diagram",
      request_count: 1,
      context: {
        cli: "d2",
        output: {
          file: "diagram.d2",
          copy: true,
        },
      },
    };
    store.saveEntries([entry]);
    const logs: string[] = [];
    const original = console.log;
    console.log = (message?: unknown, ...rest: unknown[]) => {
      logs.push([message, ...rest].filter((value) => value !== undefined).join(" "));
    };
    try {
      store.listHistory();
    } finally {
      console.log = original;
    }
    expect(logs.some((line) => line.includes("output[file=diagram.d2, copy]"))).toBe(true);
  });

  it("showByNumber が出力情報を表示する", () => {
    const entry: HistoryEntry<TestContext> = {
      last_response_id: "resp-output",
      updated_at: "2024-06-05T00:00:00Z",
      title: "diagram",
      request_count: 1,
      turns: [
        { role: "user", text: "u" },
        { role: "assistant", text: "a" },
      ],
      context: {
        cli: "d2",
        output: {
          file: "diagram.d2",
          copy: false,
        },
      },
    };
    store.saveEntries([entry]);
    const logs: string[] = [];
    const original = console.log;
    console.log = (message?: unknown, ...rest: unknown[]) => {
      logs.push([message, ...rest].filter((value) => value !== undefined).join(" "));
    };
    try {
      store.showByNumber(1, false);
    } finally {
      console.log = original;
    }
    expect(logs.some((line) => line.includes("出力: file=diagram.d2"))).toBe(true);
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
