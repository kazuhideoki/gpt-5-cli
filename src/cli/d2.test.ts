import { describe, expect, it } from "bun:test";
import type { Tool as AgentsSdkTool } from "@openai/agents";
import path from "node:path";
import { resolveInputOrExecuteHistoryAction } from "../pipeline/input/cli-input.js";
import {
  buildD2ConversationToolset,
  createD2WebSearchTool,
  ensureD2Context,
  parseArgs,
} from "./d2.js";
import type { CliDefaults, ConfigEnvironment } from "../types.js";
import type { D2CliOptions } from "./d2.js";
import type { HistoryEntry, HistoryStore } from "../pipeline/history/store.js";
import type { D2CliHistoryContext } from "./d2.js";
import type { CliLoggerConfig } from "./common/types.js";
import type { CliLogger } from "../foundation/logger/types.js";

type HistoryStoreLike = HistoryStore<D2CliHistoryContext>;
type D2HistoryEntry = HistoryEntry<D2CliHistoryContext>;

function createLoggerConfig(debugEnabled = false): CliLoggerConfig {
  const logger = {
    level: "info",
    info: () => logger,
    debug: () => logger,
    warn: () => logger,
    error: () => logger,
  } as unknown as CliLogger;
  return {
    logger,
    logLabel: "[test-cli-d2]",
    debugEnabled,
  };
}

const noopLogger = createLoggerConfig(false).logger;
const noopDeps = { printHelp: () => {}, logger: noopLogger };

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
    responseOutputPath: "diagram.d2",
    responseOutputExplicit: false,
    copyOutput: false,
    copyExplicit: false,
    artifactPath: "diagram.d2",
    htmlOutputPath: "diagram.html",
    htmlOutputExplicit: false,
    openHtml: false,
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

describe("d2 parseArgs", () => {
  it("既定で d2 モードとして解析する", () => {
    const defaults = createDefaults();
    const options = parseArgs(["ダイアグラム"], defaults, createConfigEnv());
    expect(options.taskMode).toBe("d2");
    expect(options.args).toEqual(["ダイアグラム"]);
    expect(options.artifactPath).toMatch(/^output[/\\]d2[/\\]d2-\d{8}-\d{6}-[0-9a-f]{4}\.d2$/u);
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
    const options = parseArgs(["--output", "diagram.d2", "生成"], defaults, createConfigEnv());
    expect(options.artifactPath).toBe("diagram.d2");
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

describe("d2 parseArgs html options", () => {
  it("既定で成果物パスに基づく HTML 出力パスを設定する", () => {
    const defaults = createDefaults();
    const configEnv = createConfigEnv();

    const options = parseArgs(["グラフを描いて"], defaults, configEnv);

    expect(options.openHtml).toBe(false);
    expect(options.htmlOutputExplicit).toBe(false);
    const baseName = options.artifactPath.replace(/\.d2$/u, "");
    expect(options.htmlOutputPath).toBe(`${baseName}.html`);
  });

  it("--open-html で HTML 生成を有効にできる", () => {
    const defaults = createDefaults();
    const configEnv = createConfigEnv();

    const options = parseArgs(["--open-html", "グラフ"], defaults, configEnv);

    expect(options.openHtml).toBe(true);
    expect(options.htmlOutputExplicit).toBe(false);
    const baseName = options.artifactPath.replace(/\.d2$/u, "");
    expect(options.htmlOutputPath).toBe(`${baseName}.html`);
  });

  it("--output-html は --open-html と同時に指定する必要がある", () => {
    const defaults = createDefaults();
    const configEnv = createConfigEnv();

    expect(() => parseArgs(["--output-html", "diagram.html", "図"], defaults, configEnv)).toThrow(
      "Error: --output-html を使うには --open-html を同時に指定してください",
    );
  });

  it("--output-html で HTML 出力パスを明示できる", () => {
    const defaults = createDefaults();
    const configEnv = createConfigEnv();

    const options = parseArgs(
      ["--open-html", "--output-html", "custom.html", "図"],
      defaults,
      configEnv,
    );

    expect(options.openHtml).toBe(true);
    expect(options.htmlOutputExplicit).toBe(true);
    expect(options.htmlOutputPath).toBe("custom.html");
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

describe("d2 resolveInputOrExecuteHistoryAction", () => {
  it("履歴番号指定で既存の d2 タスクを保持したまま返す", async () => {
    const defaults = createDefaults();
    const entry: D2HistoryEntry = {
      last_response_id: "resp-d2",
      title: "diagram",
      context: {
        cli: "d2",
        absolute_path: "/tmp/out.d2",
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
      logger: createLoggerConfig(false).logger,
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

  it("toolset は web_search_preview を含まず Agents ツールに web_search を含める", () => {
    const toolset = buildD2ConversationToolset({
      loggerConfig: createLoggerConfig(false),
    });
    const hasPreview = toolset.response.some((tool) => tool.type === "web_search_preview");
    expect(hasPreview).toBe(false);
    const agentHasWebSearch = toolset.agents.some((tool: AgentsSdkTool) => {
      return (
        typeof tool === "object" && tool !== null && "name" in tool && tool.name === "web_search"
      );
    });
    expect(agentHasWebSearch).toBe(true);
  });
});

describe("ensureD2Context", () => {
  it("正規化済みオプションを返す", () => {
    const input = createOptions({
      artifactPath: "./diagram.d2",
      responseOutputPath: "./diagram.d2",
      htmlOutputPath: "./diagram.html",
      htmlOutputExplicit: true,
      openHtml: true,
    });
    const snapshot = { ...input };

    const result = ensureD2Context(input);

    expect(result.normalizedOptions).not.toBe(input);
    expect(result.normalizedOptions.artifactPath).toBe("diagram.d2");
    expect(result.normalizedOptions.responseOutputPath).toBe("diagram.d2");
    expect(result.normalizedOptions.htmlOutputPath).toBe("diagram.html");
    expect(result.normalizedOptions.openHtml).toBe(true);
    expect(result.normalizedOptions.htmlOutputExplicit).toBe(true);
    expect(input).toEqual(snapshot);
  });

  it("ファイル検証結果を context に含める", () => {
    const result = ensureD2Context(
      createOptions({ artifactPath: "./diagram.d2", htmlOutputPath: "./diagram.html" }),
    );

    expect(result.context.relativePath).toBe("diagram.d2");
    expect(result.context.absolutePath).toBe(path.resolve(process.cwd(), "diagram.d2"));
    expect(result.context.exists).toBe(false);
    expect(result.normalizedOptions.htmlOutputPath).toBe("diagram.html");
  });

  it("履歴から復元した成果物に合わせて HTML 出力パスを再計算する", () => {
    const options = createOptions({
      artifactPath: "history/diagram.d2",
      responseOutputPath: "history/diagram.d2",
      htmlOutputPath: "output/d2/original.html",
      htmlOutputExplicit: false,
    });

    const result = ensureD2Context(options);

    expect(result.normalizedOptions.artifactPath).toBe("history/diagram.d2");
    expect(result.normalizedOptions.htmlOutputPath).toBe("history/diagram.html");
  });
});

describe("d2 main", () => {
  it("maxIterations を超過した場合は完了ログを出力する", async () => {
    const file = Bun.file(new URL("./d2.ts", import.meta.url));
    const source = await file.text();
    expect(source).toMatch(
      /logger\.warn\(\s*"指定したイテレーション上限に達したため途中結果を出力して処理を終了します"\s*\);/,
    );
  });
});
