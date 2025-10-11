import { describe, expect, it } from "bun:test";
import { determineInput, parseArgs } from "./cli.js";
import type { CliDefaults, CliOptions, HistoryEntry } from "./types.js";
import type { HistoryStore } from "./history.js";

function createDefaults(): CliDefaults {
  return {
    modelMain: "gpt-5-main",
    modelMini: "gpt-5-mini",
    modelNano: "gpt-5-nano",
    effort: "low",
    verbosity: "low",
    historyIndexPath: "/tmp/history.json",
    systemPromptPath: "/tmp/system_prompt.txt",
  };
}

function createOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    model: "gpt-5-nano",
    effort: "low",
    verbosity: "low",
    continueConversation: false,
    resumeListOnly: false,
    operation: "ask",
    args: [],
    modelExplicit: false,
    effortExplicit: false,
    verbosityExplicit: false,
    hasExplicitHistory: false,
    helpRequested: false,
    ...overrides,
  };
}

class StubHistoryStore {
  deletedIndex: number | null = null;
  shownIndex: number | null = null;
  listCalled = false;
  selectedIndex: number | null = null;

  constructor(private readonly entry: HistoryEntry | null = null) {}

  deleteByNumber(index: number) {
    this.deletedIndex = index;
    return { removedTitle: `title-${index}`, removedId: `id-${index}` };
  }

  showByNumber(index: number) {
    this.shownIndex = index;
  }

  listHistory() {
    this.listCalled = true;
  }

  selectByNumber(index: number) {
    this.selectedIndex = index;
    if (this.entry) {
      return this.entry;
    }
    throw new Error("entry not found");
  }
}

describe("parseArgs", () => {
  it("短縮フラグを束ねた記法を解釈できる", () => {
    const defaults = createDefaults();
    const options = parseArgs(["-m1e2v0", "テスト"], defaults);
    expect(options.model).toBe(defaults.modelMini);
    expect(options.effort).toBe("high");
    expect(options.verbosity).toBe("low");
    expect(options.args).toEqual(["テスト"]);
    expect(options.modelExplicit).toBe(true);
    expect(options.effortExplicit).toBe(true);
    expect(options.verbosityExplicit).toBe(true);
  });

  it("-r2 フラグで履歴継続が有効になる", () => {
    const defaults = createDefaults();
    const options = parseArgs(["-r2", "続き"], defaults);
    expect(options.resumeIndex).toBe(2);
    expect(options.continueConversation).toBe(true);
    expect(options.hasExplicitHistory).toBe(true);
  });

  it("-r 単体なら履歴一覧のみ表示する", () => {
    const defaults = createDefaults();
    const options = parseArgs(["-r"], defaults);
    expect(options.resumeListOnly).toBe(true);
    expect(options.resumeIndex).toBeUndefined();
  });

  it("--compact で要約モードになる", () => {
    const defaults = createDefaults();
    const options = parseArgs(["--compact", "3"], defaults);
    expect(options.operation).toBe("compact");
    expect(options.compactIndex).toBe(3);
  });

  it("-m の値が欠けていればエラーになる", () => {
    const defaults = createDefaults();
    expect(() => parseArgs(["-m"], defaults)).toThrow(
      "Invalid option: -m には 0/1/2 を続けてください（例: -m1）",
    );
  });
});

describe("determineInput", () => {
  it("削除フラグで対象履歴を削除して終了する", async () => {
    const defaults = createDefaults();
    const store = new StubHistoryStore();
    const options = createOptions({ deleteIndex: 2 });
    const result = await determineInput(options, store as unknown as HistoryStore, defaults);
    expect(store.deletedIndex).toBe(2);
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") {
      expect(result.code).toBe(0);
    }
  });

  it("履歴表示フラグで指定番号を出力する", async () => {
    const defaults = createDefaults();
    const store = new StubHistoryStore();
    const options = createOptions({ showIndex: 5 });
    const result = await determineInput(options, store as unknown as HistoryStore, defaults);
    expect(store.shownIndex).toBe(5);
    expect(result.kind).toBe("exit");
  });

  it("履歴一覧のみを要求した場合は listHistory を呼ぶ", async () => {
    const defaults = createDefaults();
    const store = new StubHistoryStore();
    const options = createOptions({ resumeListOnly: true });
    const result = await determineInput(options, store as unknown as HistoryStore, defaults);
    expect(store.listCalled).toBe(true);
    expect(result.kind).toBe("exit");
  });

  it("履歴番号指定で入力テキストを返す", async () => {
    const defaults = createDefaults();
    const entry: HistoryEntry = {
      last_response_id: "resp-123",
      title: "前回の対話",
    };
    const store = new StubHistoryStore(entry);
    const options = createOptions({
      resumeIndex: 1,
      continueConversation: true,
      hasExplicitHistory: true,
      args: ["次に進めよう"],
    });
    const result = await determineInput(options, store as unknown as HistoryStore, defaults);
    expect(store.selectedIndex).toBe(1);
    expect(result.kind).toBe("input");
    if (result.kind === "input") {
      expect(result.activeEntry).toBe(entry);
      expect(result.previousResponseId).toBe("resp-123");
      expect(result.inputText).toBe("次に進めよう");
    }
  });

  it("入力が無い場合はヘルプ表示で終了する", async () => {
    const defaults = createDefaults();
    const store = new StubHistoryStore();
    const options = createOptions();
    const result = await determineInput(options, store as unknown as HistoryStore, defaults);
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") {
      expect(result.code).toBe(1);
    }
  });
});
