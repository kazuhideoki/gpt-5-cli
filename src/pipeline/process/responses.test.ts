import { afterEach, describe, expect, it } from "bun:test";
import type OpenAI from "openai";
import type {
  CliDefaults,
  CliOptions,
  ConversationContext,
  OpenAIInputMessage,
} from "../../types.js";
import type { HistoryEntry, HistoryStore } from "../history/store.js";
import type { Response } from "openai/resources/responses/responses";
import { buildRequest, extractResponseText, performCompact } from "./responses.js";

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
let restoredConsoleLog = false;
const originalConsoleLog = console.log;

afterEach(() => {
  // 念のため stdout / console を元に戻す
  if (restoredStdout) {
    process.stdout.write = originalStdoutWrite;
    restoredStdout = false;
  }
  if (restoredConsoleLog) {
    console.log = originalConsoleLog;
    restoredConsoleLog = false;
  }
});

describe("buildRequest", () => {
  it("新規会話で system プロンプトとユーザー入力を組み立てる", () => {
    const options = createOptions();
    const context = createContext();

    const request = buildRequest({
      options,
      context,
      inputText: "質問内容",
      systemPrompt: "system message",
      defaults: DEFAULTS,
      logLabel: "[test-cli]",
      tools: [],
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
    expect(request.tools).toEqual([]);
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

    const request = buildRequest({
      options,
      context,
      inputText: "続きの質問",
      systemPrompt: "system message",
      defaults: DEFAULTS,
      logLabel: "[test-cli]",
      additionalSystemMessages: additional,
      imageDataUrl: "data:image/png;base64,AAA",
      tools: [{ type: "web_search_preview" }],
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
    expect(request.tools).toEqual([{ type: "web_search_preview" }]);
  });

  it("CLI で構築したツール配列をそのまま保持する", () => {
    const options = createOptions();
    const context = createContext();
    const cliTools = [
      {
        type: "function" as const,
        name: "read_file",
        strict: true,
        description: "Read file",
        parameters: { type: "object", properties: {}, required: [] },
      },
      { type: "web_search_preview" as const },
    ];

    const request = buildRequest({
      options,
      context,
      inputText: "質問",
      defaults: DEFAULTS,
      logLabel: "[test-cli]",
      tools: cliTools,
    });

    expect(request.tools).toBe(cliTools);
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
    const logs: string[] = [];
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""));
    };
    restoredConsoleLog = true;

    const client = {
      responses: {
        create: async () => ({
          output_text: ["要約結果"],
        }),
      },
    } as unknown as OpenAI;

    await performCompact(options, DEFAULTS, historyStore, client, "[test-cli]");

    expect(savedEntries).not.toBeNull();
    const updated = savedEntries?.find((entry) => entry.last_response_id === "resp_target");
    const summaryTurn = updated?.turns?.[0];
    expect(summaryTurn?.role).toBe("system");
    expect(summaryTurn?.kind).toBe("summary");
    expect(summaryTurn?.text).toBe("要約結果");
    expect(typeof summaryTurn?.at).toBe("string");
    expect(stdoutText.trim()).toBe("要約結果");
    expect(logs.some((line) => line.includes("compact"))).toBe(true);
  });
});
