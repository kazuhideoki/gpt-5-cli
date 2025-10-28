import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfigEnvironment } from "../../types.js";
import type { HistoryEntry } from "./store.js";
import { HistoryStore, resolveHistoryPath } from "./store.js";
import { printHistoryDetail, printHistoryList } from "./output.js";

interface TestContext {
  cli: string;
  absolute_path?: string;
  relative_path?: string;
  copy?: boolean;
}

let tempDir: string;
let historyPath: string;
let store: HistoryStore<TestContext>;
const originalHome = process.env.HOME;

function createConfigEnv(values: Record<string, string | undefined> = {}): ConfigEnvironment {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") {
      map.set(key, value);
    }
  }
  if (!map.has("HOME")) {
    const homeEnv = process.env.HOME;
    if (typeof homeEnv === "string") {
      map.set("HOME", homeEnv);
    }
  }
  return {
    get: (key: string) => map.get(key),
    has: (key: string) => map.has(key),
    entries: () => map.entries(),
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-cli-history-"));
  historyPath = path.join(tempDir, "history_index.json");
  store = new HistoryStore<TestContext>(historyPath, {
    entryFilter: (entry) => entry.context?.cli === "ask" || !entry.context?.cli,
  });
  process.env.HOME = tempDir;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("HistoryStore", () => {
  it("ensureInitialized がファイルを用意する", () => {
    store.ensureInitialized();
    expect(fs.existsSync(historyPath)).toBe(true);
    const content = fs.readFileSync(historyPath, "utf8");
    expect(content.trim()).toBe("[]");
  });

  it("loadEntries は不正な JSON でエラーを投げる", () => {
    fs.writeFileSync(historyPath, "{ invalid json", "utf8");
    expect(() => store.loadEntries()).toThrow("[gpt-5-cli] failed to parse history index:");
  });

  it("saveEntries/loadEntries がラウンドトリップする", () => {
    const entry: HistoryEntry<TestContext> = {
      title: "test",
      last_response_id: "resp-123",
      turns: [{ role: "user", text: "hello" }],
    };
    store.saveEntries([entry]);
    expect(store.loadEntries()).toEqual([entry]);
  });

  it("context メタデータも保存・復元できる", () => {
    const entry: HistoryEntry<TestContext> = {
      title: "ask conversation",
      last_response_id: "resp-1",
      context: { cli: "ask", copy: true },
    };
    store.saveEntries([entry]);
    const [loaded] = store.loadEntries();
    expect(loaded.context?.cli).toBe("ask");
    expect(loaded.context?.copy).toBe(true);
  });

  it("selectByNumber は更新日時でソートする", () => {
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 1000).toISOString();
    store.saveEntries([
      { last_response_id: "1", updated_at: now },
      { last_response_id: "2", updated_at: later },
    ]);
    const entry = store.selectByNumber(1);
    expect(entry.last_response_id).toBe("2");
  });

  it("deleteByNumber は対象を削除する", () => {
    const entries: HistoryEntry<TestContext>[] = [
      { last_response_id: "keep", updated_at: "2024-05-01T00:00:00Z" },
      { last_response_id: "remove", updated_at: "2024-06-01T00:00:00Z" },
    ];
    store.saveEntries(entries);
    const scopedStore = new HistoryStore<TestContext>(historyPath, {
      entryFilter: (entry) => entry.last_response_id !== "keep",
    });
    const { removedId } = scopedStore.deleteByNumber(1);
    expect(removedId).toBe("remove");
    const remaining = store.loadEntries().map((entry) => entry.last_response_id);
    expect(remaining).toEqual(["keep"]);
  });

  it("entryFilter で別 CLI の履歴を除外できる", () => {
    const altPath = path.join(tempDir, "history_index_alt.json");
    const scopedStore = new HistoryStore<TestContext>(altPath, {
      entryFilter: (entry) => entry.context?.cli === "d2",
    });
    scopedStore.saveEntries([
      { last_response_id: "keep", context: { cli: "d2" } },
      { last_response_id: "skip", context: { cli: "ask" } },
    ]);
    const entries = scopedStore.getFilteredEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.last_response_id).toBe("keep");
  });

  it("findLatest も entryFilter を尊重する", () => {
    const scopedStore = new HistoryStore<TestContext>(historyPath, {
      entryFilter: (entry) => entry.context?.cli === "ask",
    });
    scopedStore.saveEntries([
      { last_response_id: "skip", updated_at: "2024-05-01T00:00:00Z", context: { cli: "d2" } },
      { last_response_id: "take", updated_at: "2024-05-02T00:00:00Z", context: { cli: "ask" } },
    ]);
    const latest = scopedStore.findLatest();
    expect(latest?.last_response_id).toBe("take");
  });

  it("upsertConversation が新規エントリを追加する", () => {
    store.upsertConversation({
      metadata: {
        model: "gpt-5-mini",
        effort: "medium",
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
    const existingContext: TestContext = { cli: "d2", absolute_path: absPath };
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
    expect(updated.context?.absolute_path).toBe(absPath);
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
      contextData: { cli: "d2", absolute_path: "/tmp/new.d2" },
    });

    const [updated] = store.loadEntries();
    expect(updated.context?.cli).toBe("d2");
    expect(updated.context?.absolute_path).toBe("/tmp/new.d2");
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
      contextData: { cli: "d2", absolute_path: absPath },
    });

    const entry = store.loadEntries()[0];
    expect(entry.context?.cli).toBe("d2");
    expect(entry.context?.absolute_path).toBe(absPath);
  });
});

describe("resolveHistoryPath", () => {
  it("環境変数が設定されていれば展開して返す", () => {
    const configEnv = createConfigEnv({ GPT_5_CLI_HISTORY_INDEX_FILE: "~/history/log.json" });
    const resolved = resolveHistoryPath(configEnv, "/default.json");
    expect(resolved).toBe(path.resolve(path.join(process.env.HOME!, "history/log.json")));
  });

  it("環境変数が未設定ならエラーになる", () => {
    const configEnv = createConfigEnv();
    expect(() => resolveHistoryPath(configEnv)).toThrow(
      "GPT_5_CLI_HISTORY_INDEX_FILE must be configured via environment files.",
    );
  });

  it("空文字列を設定するとエラーになる", () => {
    const configEnv = createConfigEnv({ GPT_5_CLI_HISTORY_INDEX_FILE: "   " });
    expect(() => resolveHistoryPath(configEnv, "/default.json")).toThrow(
      "GPT_5_CLI_HISTORY_INDEX_FILE is set but empty.",
    );
  });

  it("HOME が無い状態でもユーザーディレクトリを利用して展開する", () => {
    const fallbackHome = path.join(tempDir, "fallback-home");
    fs.mkdirSync(fallbackHome, { recursive: true });

    const originalHomedir = os.homedir;
    (os as unknown as { homedir: () => string }).homedir = () => fallbackHome;

    delete process.env.HOME;
    const configEnv = createConfigEnv({ GPT_5_CLI_HISTORY_INDEX_FILE: "~/history.json" });

    try {
      const resolved = resolveHistoryPath(configEnv, "/default.json");
      expect(resolved).toBe(path.resolve(path.join(fallbackHome, "history.json")));
    } finally {
      (os as unknown as { homedir: () => string }).homedir = originalHomedir;
      process.env.HOME = tempDir;
    }
  });
});

describe("printHistoryList / printHistoryDetail", () => {
  it("printHistoryList が出力情報を表示する", () => {
    const entry: HistoryEntry<TestContext> = {
      last_response_id: "resp-output",
      updated_at: "2024-06-05T00:00:00Z",
      title: "diagram",
      request_count: 1,
      context: {
        cli: "ask",
        relative_path: "diagram.d2",
        copy: true,
      },
    };
    store.saveEntries([entry]);
    const logs: string[] = [];
    const original = console.log;
    console.log = mock((message?: unknown, ...rest: unknown[]) => {
      logs.push([message, ...rest].filter((value) => value !== undefined).join(" "));
    }) as unknown as typeof console.log;
    try {
      printHistoryList(store);
    } finally {
      console.log = original;
    }
    expect(logs.some((line) => line.includes("paths[relative=diagram.d2, copy]"))).toBe(true);
  });

  it("printHistoryDetail が出力情報を表示する", () => {
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
        cli: "ask",
        relative_path: "diagram.d2",
        copy: false,
      },
    };
    store.saveEntries([entry]);
    const logs: string[] = [];
    const original = console.log;
    console.log = mock((message?: unknown, ...rest: unknown[]) => {
      logs.push([message, ...rest].filter((value) => value !== undefined).join(" "));
    }) as unknown as typeof console.log;
    try {
      printHistoryDetail(store, 1, false);
    } finally {
      console.log = original;
    }
    expect(logs.some((line) => line.includes("出力: relative=diagram.d2"))).toBe(true);
  });
});
