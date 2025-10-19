import { describe, expect, it } from "bun:test";
import { determineInput } from "./runtime/input.js";
import { parseArgs } from "./mermaid.js";
import type { CliDefaults } from "../core/types.js";
import type { MermaidCliOptions } from "./mermaid.js";
import type { HistoryEntry, HistoryStore } from "../core/history.js";
import type { MermaidCliHistoryTask } from "./mermaid.js";

type HistoryStoreLike = HistoryStore<MermaidCliHistoryTask>;
type MermaidHistoryEntry = HistoryEntry<MermaidCliHistoryTask>;

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

function createOptions(overrides: Partial<MermaidCliOptions> = {}): MermaidCliOptions {
  return {
    model: "gpt-5-nano",
    effort: "low",
    verbosity: "low",
    continueConversation: false,
    debug: false,
    taskMode: "mermaid",
    resumeIndex: undefined,
    resumeListOnly: false,
    deleteIndex: undefined,
    showIndex: undefined,
    imagePath: undefined,
    operation: "ask",
    compactIndex: undefined,
    outputPath: "diagram.mmd",
    outputExplicit: false,
    copyOutput: false,
    copyExplicit: false,
    mermaidFilePath: "diagram.mmd",
    args: [],
    modelExplicit: false,
    effortExplicit: false,
    verbosityExplicit: false,
    maxIterations: 10,
    maxIterationsExplicit: false,
    hasExplicitHistory: false,
    helpRequested: false,
    ...overrides,
  };
}

describe("mermaid parseArgs", () => {
  it("既定で mermaid モードとして解析する", () => {
    const defaults = createDefaults();
    const options = parseArgs(["ダイアグラム"], defaults);
    expect(options.taskMode).toBe("mermaid");
    expect(options.args).toEqual(["ダイアグラム"]);
    expect(options.mermaidFilePath).toMatch(
      /^output[/\\]mermaid[/\\]mermaid-\d{8}-\d{6}-[0-9a-f]{4}\.mmd$/u,
    );
    expect(options.outputPath).toBe(options.mermaidFilePath);
  });

  it("--mermaid-iterations でツール呼び出し上限を設定できる", () => {
    const defaults = createDefaults();
    const options = parseArgs(["--mermaid-iterations", "5", "図"], defaults);
    expect(options.maxIterations).toBe(5);
    expect(options.maxIterationsExplicit).toBe(true);
  });

  it("--mermaid-iterations へ不正な値を渡すとエラーになる", () => {
    const defaults = createDefaults();
    expect(() => parseArgs(["--mermaid-iterations", "0", "図"], defaults)).toThrow(
      "Error: --mermaid-iterations の値は 1 以上で指定してください",
    );
  });

  it("--output で出力パスを指定できる", () => {
    const defaults = createDefaults();
    const options = parseArgs(["--output", "diagram.mmd", "生成"], defaults);
    expect(options.mermaidFilePath).toBe("diagram.mmd");
    expect(options.outputExplicit).toBe(true);
  });

  it("--copy でコピー出力を有効化する", () => {
    const defaults = createDefaults();
    const options = parseArgs(["--copy", "生成"], defaults);
    expect(options.copyOutput).toBe(true);
    expect(options.copyExplicit).toBe(true);
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

  constructor(private readonly entry: MermaidHistoryEntry | null = null) {}

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

describe("mermaid determineInput", () => {
  it("履歴番号指定で既存の mermaid タスクを保持したまま返す", async () => {
    const defaults = createDefaults();
    const entry: MermaidHistoryEntry = {
      last_response_id: "resp-mermaid",
      title: "diagram",
      task: { mode: "mermaid", mermaid: { file_path: "/tmp/out.mmd" } },
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
      expect(result.previousResponseId).toBe("resp-mermaid");
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
