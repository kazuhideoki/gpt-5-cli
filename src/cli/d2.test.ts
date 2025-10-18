import { describe, expect, it } from "bun:test";
import { determineInput } from "./runtime/input.js";
import { buildD2ResponseTools, createD2WebSearchTool, parseArgs } from "./d2.js";
import type { CliDefaults } from "../core/types.js";
import type { D2CliOptions } from "./d2.js";
import type { HistoryEntry, HistoryStore } from "../core/history.js";
import type { D2CliHistoryTask } from "./d2.js";

type HistoryStoreLike = HistoryStore<D2CliHistoryTask>;
type D2HistoryEntry = HistoryEntry<D2CliHistoryTask>;

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
    maxIterations: 10,
  };
}

function createOptions(overrides: Partial<D2CliOptions> = {}): D2CliOptions {
  return {
    model: "gpt-5-nano",
    effort: "low",
    verbosity: "low",
    continueConversation: false,
    debug: false,
    taskMode: "d2",
    resumeIndex: undefined,
    resumeListOnly: false,
    deleteIndex: undefined,
    showIndex: undefined,
    imagePath: undefined,
    operation: "ask",
    compactIndex: undefined,
    d2FilePath: undefined,
    args: [],
    modelExplicit: false,
    effortExplicit: false,
    verbosityExplicit: false,
    d2FileExplicit: false,
    maxIterations: 10,
    maxIterationsExplicit: false,
    hasExplicitHistory: false,
    helpRequested: false,
    ...overrides,
  };
}

describe("d2 parseArgs", () => {
  it("既定で d2 モードとして解析する", () => {
    const defaults = createDefaults();
    const options = parseArgs(["ダイアグラム"], defaults);
    expect(options.taskMode).toBe("d2");
    expect(options.args).toEqual(["ダイアグラム"]);
  });

  it("--d2-iterations でツール呼び出し上限を設定できる", () => {
    const defaults = createDefaults();
    const options = parseArgs(["--d2-iterations", "5", "図"], defaults);
    expect(options.maxIterations).toBe(5);
    expect(options.maxIterationsExplicit).toBe(true);
  });

  it("--d2-iterations へ不正な値を渡すとエラーになる", () => {
    const defaults = createDefaults();
    expect(() => parseArgs(["--d2-iterations", "0", "図"], defaults)).toThrow(
      "Error: --d2-iterations の値は 1 以上で指定してください",
    );
  });

  it("--d2-file で出力パスを指定できる", () => {
    const defaults = createDefaults();
    const options = parseArgs(["--d2-file", "diagram.d2", "生成"], defaults);
    expect(options.d2FilePath).toBe("diagram.d2");
    expect(options.d2FileExplicit).toBe(true);
  });

  it("--debug でデバッグログを有効化する", () => {
    const defaults = createDefaults();
    const options = parseArgs(["--debug", "図"], defaults);
    expect(options.debug).toBe(true);
  });
});

class StubHistoryStore {
  selected: number | undefined;
  listed = false;

  constructor(private readonly entry: D2HistoryEntry | null = null) {}

  selectByNumber(index: number) {
    this.selected = index;
    if (!this.entry) {
      throw new Error("missing entry");
    }
    return this.entry;
  }

  deleteByNumber() {
    throw new Error("not implemented");
  }

  showByNumber() {
    throw new Error("not implemented");
  }

  listHistory() {
    this.listed = true;
  }
}

describe("d2 determineInput", () => {
  it("履歴番号指定で既存の d2 タスクを保持したまま返す", async () => {
    const defaults = createDefaults();
    const entry: D2HistoryEntry = {
      last_response_id: "resp-d2",
      title: "diagram",
      task: { mode: "d2", d2: { file_path: "/tmp/out.d2" } },
    };
    const store = new StubHistoryStore(entry);
    const options = createOptions({
      resumeIndex: 1,
      continueConversation: true,
      hasExplicitHistory: true,
      args: ["続けよう"],
    });

    const result = await determineInput(
      options,
      store as unknown as HistoryStoreLike,
      defaults,
      noopDeps,
    );
    expect(store.selected).toBe(1);
    expect(result.kind).toBe("input");
    if (result.kind === "input") {
      expect(result.activeEntry).toBe(entry);
      expect(result.previousResponseId).toBe("resp-d2");
      expect(result.inputText).toBe("続けよう");
    }
  });

  it("入力がない場合はヘルプ出力して終了する", async () => {
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
    expect(store.listed).toBe(false);
    expect(helpCalled).toBe(true);
  });
});

describe("d2 web search integration", () => {
  it("web_search ツールを d2lang.com のみに制限する", () => {
    const tool = createD2WebSearchTool();
    expect(tool).toBeDefined();
    if (typeof tool !== "object" || tool === null) {
      throw new Error("web_search ツールの生成に失敗しました");
    }
    const providerData = (tool as { providerData?: unknown }).providerData;
    expect(providerData).toBeDefined();
    if (!providerData || typeof providerData !== "object") {
      throw new Error("web_search ツールの providerData を取得できませんでした");
    }
    const filters = (providerData as { filters?: unknown }).filters;
    expect(filters).toBeDefined();
    if (!filters || typeof filters !== "object") {
      throw new Error("web_search ツールの filters を取得できませんでした");
    }
    const allowedDomains = (filters as { allowed_domains?: unknown }).allowed_domains;
    expect(Array.isArray(allowedDomains)).toBe(true);
    expect(allowedDomains).toEqual(["d2lang.com"]);
  });

  it("Responses API 用ツールから web_search_preview を除外する", () => {
    const tools = buildD2ResponseTools();
    const hasPreview = tools?.some((tool) => tool.type === "web_search_preview");
    expect(hasPreview).toBe(false);
  });
});
