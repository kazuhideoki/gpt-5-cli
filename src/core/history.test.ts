import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryStore, formatTurnsForSummary } from "./history.js";
import type { HistoryEntry } from "./history.js";
import { z } from "zod";

type TestTask = {
  mode?: string;
  d2?: {
    file_path?: string;
  };
};

const testTaskSchema = z.object({
  mode: z.string().optional(),
  d2: z
    .object({
      file_path: z.string().optional(),
    })
    .optional(),
});

let tempDir: string;
let historyPath: string;
let store: HistoryStore<TestTask>;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-cli-history-test-"));
  historyPath = path.join(tempDir, "history.json");
  store = new HistoryStore<TestTask>(historyPath, {
    taskSchema: testTaskSchema,
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
    const entries: HistoryEntry<TestTask>[] = [
      { last_response_id: "1", title: "first" },
      { last_response_id: "2", title: "second" },
    ];
    store.saveEntries(entries);
    expect(store.loadEntries()).toEqual(entries);
  });

  it("task メタデータも保存・復元できる", () => {
    const entries: HistoryEntry<TestTask>[] = [
      {
        last_response_id: "d2-1",
        task: { mode: "d2", d2: { file_path: "/tmp/out.d2" } },
      },
    ];
    store.saveEntries(entries);
    expect(store.loadEntries()).toEqual(entries);
  });

  it("selectByNumber は更新日時でソートする", () => {
    const entries: HistoryEntry<TestTask>[] = [
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
    const entries: HistoryEntry<TestTask>[] = [
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
    const existing: HistoryEntry<TestTask> = {
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
        previousTask: existing.task,
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

  it("upsertConversation は task を指定しない場合に previousTask を引き継ぐ", () => {
    const absPath = path.join(tempDir, "keep.d2");
    const existingTask: TestTask = { mode: "d2", d2: { file_path: absPath } };
    const existing: HistoryEntry<TestTask> = {
      title: "diagram",
      last_response_id: "resp-prev",
      updated_at: "2024-06-01T00:00:00Z",
      task: existingTask,
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
        previousTask: existingTask,
      },
      responseId: "resp-next",
      userText: "続き",
      assistantText: "了解",
    });

    const [updated] = store.loadEntries();
    expect(updated.task?.d2?.file_path).toBe(absPath);
    expect(updated.task).toEqual(existingTask);
  });

  it("upsertConversation は task を明示すると既存を置き換える", () => {
    const existing: HistoryEntry<TestTask> = {
      title: "diagram",
      last_response_id: "resp-prev",
      task: { mode: "default" },
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
        previousTask: existing.task,
      },
      responseId: "resp-next",
      userText: "更新",
      assistantText: "完了",
      task: { mode: "d2", d2: { file_path: "/tmp/new.d2" } },
    });

    const [updated] = store.loadEntries();
    expect(updated.task?.mode).toBe("d2");
    expect(updated.task?.d2?.file_path).toBe("/tmp/new.d2");
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
      task: { mode: "d2", d2: { file_path: absPath } },
    });

    const entry = store.loadEntries()[0];
    expect(entry.task?.mode).toBe("d2");
    expect(entry.task?.d2?.file_path).toBe(absPath);
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
