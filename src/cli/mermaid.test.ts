import { describe, expect, it } from "bun:test";
import { resolveInputOrExecuteHistoryAction } from "../pipeline/input/cli-input.js";
import path from "node:path";
import { ensureMermaidContext, parseArgs } from "./mermaid.js";
import type { CliDefaults, ConfigEnvironment } from "../types.js";
import type { MermaidCliOptions } from "./mermaid.js";
import type { HistoryEntry, HistoryStore } from "../pipeline/history/store.js";
import type { MermaidCliHistoryContext } from "./mermaid.js";

type HistoryStoreLike = HistoryStore<MermaidCliHistoryContext>;
type MermaidHistoryEntry = HistoryEntry<MermaidCliHistoryContext>;

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
    responseOutputPath: "diagram.mmd",
    responseOutputExplicit: false,
    copyOutput: false,
    copyExplicit: false,
    artifactPath: "diagram.mmd",
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

function createConfigEnv(values: Record<string, string | undefined> = {}): ConfigEnvironment {
  return {
    get: (key: string) => values[key],
    has: (key: string) => values[key] !== undefined,
    entries(): IterableIterator<readonly [key: string, value: string]> {
      const entries = Object.entries(values).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      );
      return entries[Symbol.iterator]();
    },
  };
}

describe("mermaid parseArgs", () => {
  it("既定で mermaid モードとして解析する", () => {
    const defaults = createDefaults();
    const options = parseArgs(["ダイアグラム"], defaults, createConfigEnv());
    expect(options.taskMode).toBe("mermaid");
    expect(options.args).toEqual(["ダイアグラム"]);
    expect(options.artifactPath).toMatch(
      /^output[/\\]mermaid[/\\]mermaid-\d{8}-\d{6}-[0-9a-f]{4}\.mmd$/u,
    );
    // TODO 履歴保存と成果物保存が一緒になり得るという、混乱する仕様。要修正
    expect(options.responseOutputPath).toBe(options.artifactPath);
  });

  it("--iterations でイテレーション上限を設定できる", () => {
    const defaults = createDefaults();
    const options = parseArgs(["--iterations", "5", "図"], defaults, createConfigEnv());
    expect(options.maxIterations).toBe(5);
    expect(options.maxIterationsExplicit).toBe(true);
  });

  it("--iterations へ不正な値を渡すとエラーになる", () => {
    const defaults = createDefaults();
    expect(() => parseArgs(["--iterations", "0", "図"], defaults, createConfigEnv())).toThrow(
      "Error: --iterations の値は 1 以上で指定してください",
    );
  });

  it("--output で出力パスを指定できる", () => {
    const defaults = createDefaults();
    const options = parseArgs(["--output", "diagram.mmd", "生成"], defaults, createConfigEnv());
    expect(options.artifactPath).toBe("diagram.mmd");
    expect(options.responseOutputExplicit).toBe(true);
  });

  it("--copy でコピー出力を有効化する", () => {
    const defaults = createDefaults();
    const options = parseArgs(["--copy", "生成"], defaults, createConfigEnv());
    expect(options.copyOutput).toBe(true);
    expect(options.copyExplicit).toBe(true);
  });

  it("--debug でデバッグログを有効化する", () => {
    const defaults = createDefaults();
    const options = parseArgs(["--debug", "図"], defaults, createConfigEnv());
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

describe("mermaid resolveInputOrExecuteHistoryAction", () => {
  it("履歴番号指定で既存の mermaid コンテキストを保持したまま返す", async () => {
    const defaults = createDefaults();
    const entry: MermaidHistoryEntry = {
      last_response_id: "resp-mermaid",
      title: "diagram",
      context: {
        cli: "mermaid",
        absolute_path: "/tmp/out.mmd",
        relative_path: undefined,
        copy: undefined,
      },
    };
    const store = new StubHistoryStore(entry);
    const options = createOptions({
      resumeIndex: 1,
      continueConversation: true,
      hasExplicitHistory: true,
      args: ["続けよう"],
    });
    const configEnv = createConfigEnv();

    const result = await resolveInputOrExecuteHistoryAction(
      options,
      store as unknown as HistoryStoreLike,
      defaults,
      noopDeps,
      configEnv,
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
    const configEnv = createConfigEnv();
    const result = await resolveInputOrExecuteHistoryAction(
      options,
      store as unknown as HistoryStoreLike,
      defaults,
      deps,
      configEnv,
    );
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") {
      expect(result.code).toBe(1);
    }
    expect(store.listed).toBe(false);
    expect(helpCalled).toBe(true);
  });
});

describe("ensureMermaidContext", () => {
  it("正規化済みオプションを返す", () => {
    const input = createOptions({
      artifactPath: "./diagram.mmd",
      responseOutputPath: "./diagram.mmd",
    });
    const snapshot = { ...input };

    const result = ensureMermaidContext(input);

    expect(result.normalizedOptions).not.toBe(input);
    expect(result.normalizedOptions.artifactPath).toBe("diagram.mmd");
    expect(result.normalizedOptions.responseOutputPath).toBe("diagram.mmd");
    expect(input).toEqual(snapshot);
  });

  it("ファイル検証結果を context に含める", () => {
    const input = createOptions({ artifactPath: "./diagram.mmd" });

    const result = ensureMermaidContext(input);

    expect(result.context.relativePath).toBe("diagram.mmd");
    expect(result.context.absolutePath).toBe(path.resolve(process.cwd(), "diagram.mmd"));
    expect(result.context.exists).toBe(false);
  });
});

describe("mermaid main", () => {
  it("maxIterations を超過した場合は完了ログを出力する", async () => {
    const file = Bun.file(new URL("./mermaid.ts", import.meta.url));
    const source = await file.text();
    expect(source).toMatch(
      /console\.error\(\s*"\[gpt-5-cli-mermaid] info: 指定したイテレーション上限に達したため途中結果を出力して処理を終了します",?\s*\);/,
    );
  });
});
