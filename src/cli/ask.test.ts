import { describe, expect, it } from "bun:test";
import type { Tool as AgentsSdkTool } from "@openai/agents";
import { buildRequest } from "../pipeline/process/responses.js";
import { resolveInputOrExecuteHistoryAction } from "../pipeline/input/cli-input.js";
import {
  buildAskHistoryContext,
  buildAskConversationToolset,
  createAskWebSearchTool,
  parseArgs,
} from "./ask.js";
import type { CliDefaults, CliOptions, ConfigEnvironment, ConversationContext } from "../types.js";
import type { HistoryEntry, HistoryStore } from "../pipeline/history/store.js";
import type { AskCliHistoryContext } from "./ask.js";

type TestHistoryEntry = HistoryEntry<AskCliHistoryContext>;
type HistoryStoreLike = HistoryStore<AskCliHistoryContext>;

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
    maxIterations: 8,
  };
}

function createOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    model: "gpt-5-nano",
    effort: "low",
    verbosity: "low",
    continueConversation: false,
    debug: false,
    taskMode: "ask",
    responseOutputPath: undefined,
    responseOutputExplicit: false,
    copyOutput: false,
    copyExplicit: false,
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
    const options = parseArgs(["-m1e2v0", "テスト"], defaults, createConfigEnv());
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
    const options = parseArgs(["-r2", "続き"], defaults, createConfigEnv());
    expect(options.resumeIndex).toBe(2);
    expect(options.continueConversation).toBe(true);
    expect(options.hasExplicitHistory).toBe(true);
  });

  it("-r 単体なら履歴一覧のみ表示する", () => {
    const defaults = createDefaults();
    const options = parseArgs(["-r"], defaults, createConfigEnv());
    expect(options.resumeListOnly).toBe(true);
    expect(options.resumeIndex).toBeUndefined();
  });

  it("--compact で要約モードになる", () => {
    const defaults = createDefaults();
    const options = parseArgs(["--compact", "3"], defaults, createConfigEnv());
    expect(options.operation).toBe("compact");
    expect(options.compactIndex).toBe(3);
  });

  it("--debug でデバッグログを有効化する", () => {
    const defaults = createDefaults();
    const options = parseArgs(["--debug", "確認"], defaults, createConfigEnv());
    expect(options.debug).toBe(true);
  });

  it("--copy でコピー出力を有効化する", () => {
    const defaults = createDefaults();
    const options = parseArgs(["--copy", "テスト"], defaults, createConfigEnv());
    expect(options.copyOutput).toBe(true);
    expect(options.copyExplicit).toBe(true);
  });

  it("d2関連フラグは parseArgs で拒否される", () => {
    const defaults = createDefaults();
    expect(() => parseArgs(["-D", "ダイアグラム"], defaults, createConfigEnv())).toThrow(
      "error: unknown option '-D'",
    );
    expect(() => parseArgs(["--d2-file", "out.d2", "テスト"], defaults, createConfigEnv())).toThrow(
      "error: unknown option '--d2-file'",
    );
  });

  it("-m の値が欠けていればエラーになる", () => {
    const defaults = createDefaults();
    expect(() => parseArgs(["-m"], defaults, createConfigEnv())).toThrow(
      "Invalid option: -m には 0/1/2 を続けてください（例: -m1）",
    );
  });
});

describe("buildAskHistoryContext", () => {
  it("records new output path when provided", () => {
    const context = buildAskHistoryContext({
      responseOutputPath: "/tmp/output.txt",
      copyOutput: false,
    });

    expect(context).toEqual<AskCliHistoryContext>({
      cli: "ask",
      relative_path: "/tmp/output.txt",
    });
  });

  it("falls back to previous output file when no new path is given", () => {
    const context = buildAskHistoryContext({
      previousContext: {
        cli: "ask",
        relative_path: "/tmp/previous.txt",
      },
      copyOutput: false,
    });

    expect(context).toEqual<AskCliHistoryContext>({
      cli: "ask",
      relative_path: "/tmp/previous.txt",
    });
  });

  it("includes copy flag only when explicitly requested", () => {
    const context = buildAskHistoryContext({
      responseOutputPath: "/tmp/output.txt",
      copyOutput: true,
      previousContext: {
        cli: "ask",
        relative_path: "/tmp/previous.txt",
        copy: true,
      },
    });

    expect(context).toEqual<AskCliHistoryContext>({
      cli: "ask",
      relative_path: "/tmp/output.txt",
      copy: true,
    });
  });

  it("preserves previous copy flag even when no file is present", () => {
    const context = buildAskHistoryContext({
      copyOutput: false,
      previousContext: {
        cli: "ask",
        copy: true,
      },
    });

    expect(context).toEqual<AskCliHistoryContext>({
      cli: "ask",
      copy: true,
    });
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
    const configEnv = createConfigEnv();
    const { request } = buildRequest({
      options,
      context,
      inputText: "最初の質問",
      systemPrompt: "system message",
      defaults,
      logLabel: "[test-cli]",
      configEnv,
      toolset: buildAskConversationToolset({
        logLabel: "[test-cli]",
        debug: false,
      }),
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
    const configEnv = createConfigEnv();
    const { request } = buildRequest({
      options,
      context,
      inputText: "続きの質問",
      systemPrompt: "system message",
      defaults,
      logLabel: "[test-cli]",
      configEnv,
      toolset: buildAskConversationToolset({
        logLabel: "[test-cli]",
        debug: false,
      }),
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

describe("resolveInputOrExecuteHistoryAction", () => {
  it("削除フラグで対象履歴を削除して終了する", async () => {
    const defaults = createDefaults();
    const store = new StubHistoryStore();
    const options = createOptions({ deleteIndex: 2 });
    const configEnv = createConfigEnv();
    const result = await resolveInputOrExecuteHistoryAction(
      options,
      store as unknown as HistoryStoreLike,
      defaults,
      noopDeps,
      configEnv,
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
    const configEnv = createConfigEnv({ NO_COLOR: "1" });
    const printDetail = (historyStore: HistoryStoreLike, index: number, noColor: boolean) => {
      expect(historyStore).toBe(store);
      expect(index).toBe(5);
      expect(noColor).toBe(true);
    };
    const result = await resolveInputOrExecuteHistoryAction(
      options,
      store as unknown as HistoryStoreLike,
      defaults,
      {
        ...noopDeps,
        printHistoryDetail: printDetail,
      },
      configEnv,
    );
    expect(result.kind).toBe("exit");
  });

  it("履歴一覧のみを要求した場合は listHistory を呼ぶ", async () => {
    const defaults = createDefaults();
    const store = new StubHistoryStore();
    const options = createOptions({ resumeListOnly: true });
    const configEnv = createConfigEnv();
    const printList = (historyStore: HistoryStoreLike) => {
      expect(historyStore).toBe(store);
    };
    const result = await resolveInputOrExecuteHistoryAction(
      options,
      store as unknown as HistoryStoreLike,
      defaults,
      {
        ...noopDeps,
        printHistoryList: printList,
      },
      configEnv,
    );
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
    const configEnv = createConfigEnv();
    const result = await resolveInputOrExecuteHistoryAction(
      options,
      store as unknown as HistoryStoreLike,
      defaults,
      noopDeps,
      configEnv,
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
    expect(helpCalled).toBe(true);
  });
});

describe("main", () => {
  it("--iterations で指定した上限を runAgentConversation に渡す", async () => {
    const file = Bun.file(new URL("./ask.ts", import.meta.url));
    const source = await file.text();
    expect(source.includes("maxTurns: options.maxIterations")).toBe(true);
  });
});

describe("ask web search integration", () => {
  it("web_search ツールを生成して名称を固定する", () => {
    const tool = createAskWebSearchTool();
    expect(tool).toBeDefined();
    if (!tool || typeof tool !== "object") {
      throw new Error("web_search ツールの生成に失敗しました");
    }
    const name = (tool as { name?: unknown }).name;
    expect(name).toBe("web_search");
  });

  it("toolset は web_search_preview を含まず Agents ツールに web_search を含める", () => {
    const toolset = buildAskConversationToolset({
      logLabel: "[test-cli]",
      debug: false,
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
