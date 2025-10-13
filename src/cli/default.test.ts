import { describe, expect, it } from "bun:test";
import { buildRequest } from "../commands/conversation.js";
import { determineInput } from "./shared/input.js";
import { parseArgs } from "./default.js";
import type { CliDefaults, CliOptions, ConversationContext } from "./types.js";
import type { HistoryEntry, HistoryStore } from "../core/history.js";
import type { DefaultCliHistoryTask } from "./default.js";

type TestHistoryEntry = HistoryEntry<DefaultCliHistoryTask>;
type HistoryStoreLike = HistoryStore<DefaultCliHistoryTask>;

const noopDeps = { printHelp: () => {} };

function createDefaults(): CliDefaults {
  return {
    modelMain: "gpt-5-main",
    modelMini: "gpt-5-mini",
    modelNano: "gpt-5-nano",
    effort: "low",
    verbosity: "low",
    historyIndexPath: "/tmp/history.json",
    promptsDir: "/tmp/prompts",
    d2MaxIterations: 8,
  };
}

function createOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    model: "gpt-5-nano",
    effort: "low",
    verbosity: "low",
    continueConversation: false,
    taskMode: "default",
    resumeListOnly: false,
    operation: "ask",
    args: [],
    modelExplicit: false,
    effortExplicit: false,
    verbosityExplicit: false,
    taskModeExplicit: false,
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

  constructor(private readonly entry: TestHistoryEntry | null = null) {}

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

  it("d2関連フラグは parseArgs で拒否される", () => {
    const defaults = createDefaults();
    expect(() => parseArgs(["-D", "ダイアグラム"], defaults)).toThrow("error: unknown option '-D'");
    expect(() => parseArgs(["--d2-file", "out.d2", "テスト"], defaults)).toThrow(
      "error: unknown option '--d2-file'",
    );
  });

  it("-m の値が欠けていればエラーになる", () => {
    const defaults = createDefaults();
    expect(() => parseArgs(["-m"], defaults)).toThrow(
      "Invalid option: -m には 0/1/2 を続けてください（例: -m1）",
    );
  });
});

describe("buildRequest", () => {
  function createContext(overrides: Partial<ConversationContext> = {}): ConversationContext {
    return {
      isNewConversation: true,
      previousResponseId: undefined,
      previousTitle: undefined,
      titleToUse: "title",
      resumeBaseMessages: [],
      resumeSummaryText: undefined,
      resumeSummaryCreatedAt: undefined,
      activeEntry: undefined,
      activeLastResponseId: undefined,
      ...overrides,
    };
  }

  it("新規会話では system プロンプトを最初に付与する", () => {
    const defaults = createDefaults();
    const options = createOptions();
    const context = createContext();
    const request = buildRequest({
      options,
      context,
      inputText: "最初の質問",
      systemPrompt: "system message",
      defaults,
      logLabel: "[test-cli]",
    });
    const input = request.input as any[];
    expect(input[0]).toEqual({
      role: "system",
      content: [{ type: "input_text", text: "system message" }],
    });
  });

  it("継続会話では system プロンプトを追加しない", () => {
    const defaults = createDefaults();
    const options = createOptions({ continueConversation: true });
    const context = createContext({
      isNewConversation: false,
      previousResponseId: "resp_123",
      resumeBaseMessages: [
        {
          role: "system",
          content: [{ type: "input_text", text: "previous summary" }],
        },
      ],
    });
    const request = buildRequest({
      options,
      context,
      inputText: "続きの質問",
      systemPrompt: "system message",
      defaults,
      logLabel: "[test-cli]",
    });
    const input = request.input as any[];
    const systemTexts = input
      .filter((msg) => msg.role === "system")
      .flatMap((msg) => (Array.isArray(msg.content) ? msg.content : []))
      .map((item: any) => item?.text)
      .filter((text: unknown): text is string => typeof text === "string");
    expect(systemTexts).not.toContain("system message");
  });
});

describe("determineInput", () => {
  it("削除フラグで対象履歴を削除して終了する", async () => {
    const defaults = createDefaults();
    const store = new StubHistoryStore();
    const options = createOptions({ deleteIndex: 2 });
    const result = await determineInput(
      options,
      store as unknown as HistoryStoreLike,
      defaults,
      noopDeps,
    );
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
    const result = await determineInput(
      options,
      store as unknown as HistoryStoreLike,
      defaults,
      noopDeps,
    );
    expect(store.shownIndex).toBe(5);
    expect(result.kind).toBe("exit");
  });

  it("履歴一覧のみを要求した場合は listHistory を呼ぶ", async () => {
    const defaults = createDefaults();
    const store = new StubHistoryStore();
    const options = createOptions({ resumeListOnly: true });
    const result = await determineInput(
      options,
      store as unknown as HistoryStoreLike,
      defaults,
      noopDeps,
    );
    expect(store.listCalled).toBe(true);
    expect(result.kind).toBe("exit");
  });

  it("履歴番号指定で入力テキストを返す", async () => {
    const defaults = createDefaults();
    const entry: TestHistoryEntry = {
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
    const result = await determineInput(
      options,
      store as unknown as HistoryStoreLike,
      defaults,
      noopDeps,
    );
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
    let helpCalled = false;
    const deps = {
      printHelp: () => {
        helpCalled = true;
      },
    };
    const result = await determineInput(
      options,
      store as unknown as HistoryStoreLike,
      defaults,
      deps,
    );
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") {
      expect(result.code).toBe(1);
    }
    expect(helpCalled).toBe(true);
  });
});
