import { afterEach, describe, expect, it } from "bun:test";
import type { Tool as AgentsSdkTool } from "@openai/agents";
import type OpenAI from "openai";
import type {
  CliDefaults,
  CliOptions,
  ConfigEnvironment,
  ConversationContext,
  OpenAIInputMessage,
} from "../../types.js";
import type { HistoryEntry, HistoryStore } from "../history/store.js";
import type { Response } from "openai/resources/responses/responses";
import { buildRequest, extractResponseText, performCompact } from "./responses.js";
import type { CliLogger, CliLoggerConfig } from "../../foundation/logger/types.js";

interface TestHistoryTask {
  label?: string;
}

function createOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    model: "gpt-5-nano",
    effort: "low",
    verbosity: "low",
    continueConversation: false,
    debug: false,
    taskMode: "ask",
    maxIterations: 8,
    maxIterationsExplicit: false,
    resumeIndex: undefined,
    deleteIndex: undefined,
    showIndex: undefined,
    imagePath: undefined,
    responseOutputPath: undefined,
    responseOutputExplicit: false,
    copyOutput: false,
    copyExplicit: false,
    compactIndex: undefined,
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

const DEFAULTS: CliDefaults = {
  modelMain: "gpt-5-main",
  modelMini: "gpt-5-mini",
  modelNano: "gpt-5-nano",
  effort: "low",
  verbosity: "low",
  historyIndexPath: "/tmp/history.json",
  promptsDir: "/tmp/prompts",
  maxIterations: 8,
};

let restoredStdout = false;
const originalStdoutWrite = process.stdout.write;

type LoggerMessages = Record<"info" | "warn" | "error" | "debug", string[]>;

function createTestLoggerConfig(
  overrides: { logLabel?: string; debugEnabled?: boolean } = {},
): { config: CliLoggerConfig; messages: LoggerMessages } {
  const messages: LoggerMessages = {
    info: [],
    warn: [],
    error: [],
    debug: [],
  };

  const loggerRecord: Record<string, any> = {
    level: "info",
    transports: [],
    log: () => undefined,
  };

  for (const level of ["info", "warn", "error", "debug"] as const) {
    loggerRecord[level] = (message: unknown, ..._meta: unknown[]) => {
      messages[level].push(String(message ?? ""));
      return loggerRecord;
    };
  }

  return {
    config: {
      logger: loggerRecord as CliLogger,
      logLabel: overrides.logLabel ?? "[test-cli]",
      debugEnabled: overrides.debugEnabled ?? false,
    },
    messages,
  };
}

afterEach(() => {
  // 念のため stdout を元に戻す
  if (restoredStdout) {
    process.stdout.write = originalStdoutWrite;
    restoredStdout = false;
  }
});

describe("buildRequest", () => {
  it("新規会話で system プロンプトとユーザー入力を組み立てる", () => {
    const options = createOptions();
    const context = createContext();

    const toolset = {
      response: [
        {
          type: "function",
          name: "sample_tool",
          description: "sample tool",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      ],
      agents: [],
    };

    const { config: loggerConfig } = createTestLoggerConfig();

    const { request, agentTools } = buildRequest({
      options,
      context,
      inputText: "質問内容",
      systemPrompt: "system message",
      defaults: DEFAULTS,
      loggerConfig,
      configEnv: createConfigEnv(),
      imageDataUrl: undefined,
      additionalSystemMessages: undefined,
      toolset,
    });

    expect(Array.isArray(request.input)).toBe(true);
    const inputMessages = request.input as OpenAIInputMessage[];
    expect(inputMessages[0]).toEqual({
      role: "system",
      content: [{ type: "input_text", text: "system message" }],
    });
    const lastMessage = inputMessages.at(-1);
    expect(lastMessage?.role).toBe("user");
    expect(lastMessage?.content?.[0]).toEqual({ type: "input_text", text: "質問内容" });
    expect(request.previous_response_id).toBeUndefined();
    expect(request.tools).toEqual(toolset.response);
    expect(agentTools).toEqual(toolset.agents);
  });

  it("systemPrompt が undefined のときに system メッセージを追加しない", () => {
    const options = createOptions();
    const context = createContext();
    const toolset = {
      response: [],
      agents: [],
    };

    const { config: loggerConfig } = createTestLoggerConfig();

    const { request } = buildRequest({
      options,
      context,
      inputText: "質問内容",
      systemPrompt: undefined,
      defaults: DEFAULTS,
      loggerConfig,
      configEnv: createConfigEnv(),
      imageDataUrl: undefined,
      additionalSystemMessages: undefined,
      toolset,
    });

    const inputMessages = request.input as OpenAIInputMessage[];
    expect(inputMessages[0]?.role).toBe("user");
    expect(inputMessages[0]?.content?.[0]).toEqual({ type: "input_text", text: "質問内容" });
  });

  it("継続会話では previous_response_id と追加の system メッセージを含める", () => {
    const options = createOptions({ continueConversation: true });
    const context = createContext({
      isNewConversation: false,
      previousResponseId: "resp_prev",
      resumeBaseMessages: [
        { role: "system", content: [{ type: "input_text", text: "前回の要約" }] },
      ],
    });
    const additional: OpenAIInputMessage[] = [
      { role: "system", content: [{ type: "input_text", text: "追加指示" }] },
    ];

    const agentTool = { name: "dummy_tool" } as AgentsSdkTool;

    const toolset = {
      response: [
        {
          type: "function",
          name: "sample_tool",
          description: "sample tool",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      ],
      agents: [agentTool],
    };

    const { config: loggerConfig } = createTestLoggerConfig();

    const { request, agentTools } = buildRequest({
      options,
      context,
      inputText: "続きの質問",
      systemPrompt: "system message",
      defaults: DEFAULTS,
      loggerConfig,
      additionalSystemMessages: additional,
      imageDataUrl: "data:image/png;base64,AAA",
      configEnv: createConfigEnv(),
      toolset,
    });

    const inputMessages = request.input as OpenAIInputMessage[];
    expect(inputMessages[0]?.content?.[0]).toEqual({ type: "input_text", text: "追加指示" });
    expect(inputMessages[1]?.content?.[0]).toEqual({ type: "input_text", text: "前回の要約" });
    const userMessage = inputMessages.at(-1);
    expect(userMessage?.content?.[0]).toEqual({ type: "input_text", text: "続きの質問" });
    expect(userMessage?.content?.[1]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,AAA",
      detail: "auto",
    });
    expect(request.previous_response_id).toBe("resp_prev");
    expect(request.tools).toEqual(toolset.response);
    expect(agentTools).toEqual(toolset.agents);
  });

  it("toolset を受け取り request.tools と agentTools の両方へ反映する", () => {
    const options = createOptions();
    const context = createContext();
    const agentTool = { name: "dummy_tool" } as AgentsSdkTool;
    const toolDefinition = {
      type: "function",
      name: "custom_tool",
      description: "custom tool",
      parameters: {
        type: "object",
        properties: {},
      },
    };
    const toolset = {
      response: [toolDefinition],
      agents: [agentTool],
    };

    const { config: loggerConfig } = createTestLoggerConfig();

    const { request, agentTools } = buildRequest({
      options,
      context,
      inputText: "tool check",
      systemPrompt: undefined,
      imageDataUrl: undefined,
      defaults: DEFAULTS,
      loggerConfig,
      configEnv: createConfigEnv(),
      additionalSystemMessages: undefined,
      toolset,
    });

    expect(request.tools).toBe(toolset.response);
    expect(agentTools).toBe(toolset.agents);
  });

  it("loggerConfig を使ってモデル情報を info ログに記録する", () => {
    const options = createOptions();
    const context = createContext();
    const toolset = { response: [], agents: [] };
    const { config: loggerConfig, messages } = createTestLoggerConfig();

    buildRequest({
      options,
      context,
      inputText: "ログ確認",
      systemPrompt: undefined,
      defaults: DEFAULTS,
      loggerConfig,
      configEnv: createConfigEnv(),
      imageDataUrl: undefined,
      additionalSystemMessages: undefined,
      toolset,
    });

    expect(messages.info.some((message) => message.includes("model="))).toBe(true);
  });

  it("previous_response_id が無い継続会話では warn ログを記録する", () => {
    const options = createOptions({ continueConversation: true });
    const context = createContext({
      isNewConversation: false,
      previousResponseId: undefined,
      resumeSummaryText: undefined,
    });
    const toolset = { response: [], agents: [] };
    const { config: loggerConfig, messages } = createTestLoggerConfig();

    buildRequest({
      options,
      context,
      inputText: "warn 確認",
      systemPrompt: undefined,
      defaults: DEFAULTS,
      loggerConfig,
      configEnv: createConfigEnv(),
      imageDataUrl: undefined,
      additionalSystemMessages: undefined,
      toolset,
    });

    expect(messages.warn.some((message) => message.includes("新規会話として開始"))).toBe(true);
  });
});

describe("extractResponseText", () => {
  it("output_text 配列から文字列を抽出する", () => {
    const response = { output_text: ["foo", "bar"] } as Response;
    expect(extractResponseText(response)).toBe("foobar");
  });

  it("message.content からフォールバック抽出する", () => {
    const response = {
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "fallback" }],
        },
      ],
    } as Response;
    expect(extractResponseText(response)).toBe("fallback");
  });
});

describe("performCompact", () => {
  it("選択した履歴を要約し、履歴エントリを更新する", async () => {
    const options = createOptions({ operation: "compact", compactIndex: 3 });
    const turns = [
      { role: "user", text: "こんにちは" },
      { role: "assistant", text: "こんにちは！" },
    ];
    const compactTarget: HistoryEntry<TestHistoryTask> = {
      last_response_id: "resp_target",
      turns,
      resume: {
        mode: "continue",
        previous_response_id: "resp_prev",
      },
    };
    const entries: HistoryEntry<TestHistoryTask>[] = [
      compactTarget,
      { last_response_id: "another" },
    ];
    let savedEntries: HistoryEntry<TestHistoryTask>[] | null = null;
    const historyStore = {
      selectByNumber: (index: number) => {
        expect(index).toBe(3);
        return compactTarget;
      },
      loadEntries: () => entries,
      saveEntries: (next: HistoryEntry<TestHistoryTask>[]) => {
        savedEntries = next;
      },
    } as unknown as HistoryStore<TestHistoryTask>;
    let stdoutText = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutText += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    restoredStdout = true;
    const { config: loggerConfig, messages } = createTestLoggerConfig();

    const client = {
      responses: {
        create: async () => ({
          output_text: ["要約結果"],
        }),
      },
    } as unknown as OpenAI;

    await performCompact(options, DEFAULTS, historyStore, client, loggerConfig);

    expect(savedEntries).not.toBeNull();
    const updated = savedEntries?.find((entry) => entry.last_response_id === "resp_target");
    const summaryTurn = updated?.turns?.[0];
    expect(summaryTurn?.role).toBe("system");
    expect(summaryTurn?.kind).toBe("summary");
    expect(summaryTurn?.text).toBe("要約結果");
    expect(typeof summaryTurn?.at).toBe("string");
    expect(stdoutText.trim()).toBe("要約結果");
    expect(messages.info.some((line) => line.includes("compact"))).toBe(true);
  });
});
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
