import { describe, expect, it } from "bun:test";
import { MaxTurnsExceededError, Runner } from "@openai/agents";
import type { Tool as AgentsSdkTool } from "@openai/agents";
import type OpenAI from "openai";
import type { CliOptions } from "../../types.js";
import { runAgentConversation } from "./agent-conversation.js";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { CliLogger, CliLoggerConfig } from "../../foundation/logger/types.js";

function createTestLoggerConfig(
  overrides: { logLabel?: string; debugEnabled?: boolean } = {},
): CliLoggerConfig {
  const debugEnabled = overrides.debugEnabled ?? false;
  const loggerRecord: Record<string, any> = {
    level: debugEnabled ? "debug" : "info",
    transports: [],
    log: () => undefined,
  };

  for (const level of ["info", "warn", "error", "debug"] as const) {
    loggerRecord[level] = () => loggerRecord;
  }

  return {
    logger: loggerRecord as CliLogger,
    logLabel: overrides.logLabel ?? "[agent-test]",
    debugEnabled,
  };
}

class FakeResponsesClient {
  public readonly createCalls: any[] = [];

  async create(body: unknown): Promise<unknown> {
    this.createCalls.push(body);
    return {
      id: "resp_test",
      output_text: ["Agent result"],
      usage: {},
    };
  }
}

class FakeOpenAI {
  public readonly responses = new FakeResponsesClient();
}

const BASE_OPTIONS: CliOptions = {
  model: "gpt-5-nano",
  effort: "low",
  verbosity: "low",
  continueConversation: false,
  debug: false,
  taskMode: "d2",
  resumeListOnly: false,
  operation: "ask",
  args: [],
  modelExplicit: false,
  effortExplicit: false,
  verbosityExplicit: false,
  hasExplicitHistory: false,
  helpRequested: false,
};

const BASE_REQUEST: ResponseCreateParamsNonStreaming = {
  model: "gpt-5-nano",
  reasoning: { effort: "low" },
  text: { verbosity: "low" },
  tools: [],
  input: [
    {
      role: "system",
      content: [{ type: "input_text", text: "You are a helpful agent." }],
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "Create a diagram" }],
    },
  ],
};

describe("runAgentConversation", () => {
  it("Responses API 互換レスポンスから最終出力と responseId を取得する", async () => {
    const client = new FakeOpenAI();
    const loggerConfig = createTestLoggerConfig();
    const result = await runAgentConversation({
      client: client as unknown as OpenAI,
      request: BASE_REQUEST,
      options: BASE_OPTIONS,
      loggerConfig,
      agentTools: [] as AgentsSdkTool[],
      maxTurns: 2,
    });

    expect(result.assistantText).toBe("Agent result");
    expect(result.responseId).toBe("resp_test");
    expect(result.reachedMaxIterations).toBe(false);
    expect(client.responses.createCalls).toHaveLength(1);

    const [requestBody] = client.responses.createCalls;
    expect(requestBody.instructions).toContain("You are a helpful agent.");
    expect(Array.isArray(requestBody.input)).toBe(true);
    expect(requestBody.input.at(-1)?.content?.[0]?.text).toBe("Create a diagram");
  });

  it("maxTurns を undefined にしても実行できる", async () => {
    const client = new FakeOpenAI();
    const loggerConfig = createTestLoggerConfig();
    const result = await runAgentConversation({
      client: client as unknown as OpenAI,
      request: BASE_REQUEST,
      options: BASE_OPTIONS,
      loggerConfig,
      agentTools: [] as AgentsSdkTool[],
      maxTurns: undefined,
    });

    expect(result.assistantText).toBe("Agent result");
    expect(result.responseId).toBe("resp_test");
    expect(result.reachedMaxIterations).toBe(false);
  });

  it("ユーザー入力が存在しない場合にエラーを送出する", async () => {
    const client = new FakeOpenAI();
    const request: ResponseCreateParamsNonStreaming = {
      ...BASE_REQUEST,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: "system only" }],
        },
      ],
    };

    await expect(
      runAgentConversation({
        client: client as unknown as OpenAI,
        request,
        options: BASE_OPTIONS,
        loggerConfig: createTestLoggerConfig(),
        agentTools: [] as AgentsSdkTool[],
        maxTurns: undefined,
      }),
    ).rejects.toThrow("Error: No user input found for agent execution");
  });

  it("maxTurns 超過時に途中結果フラグ付きでテキストを返す", async () => {
    const client = new FakeOpenAI();
    const originalRun = Runner.prototype.run;
    const generatedItems = [
      { type: "message_output_item", content: "途中までの" },
      { type: "message_output_item", content: "応答です。" },
    ];

    Runner.prototype.run = async () => {
      const errorState = {
        _generatedItems: generatedItems,
        _modelResponses: [{ responseId: "resp_partial" }],
      };
      throw new MaxTurnsExceededError("Max turns exceeded", errorState as any);
    };

    try {
      const loggerConfig = createTestLoggerConfig();
      const result = await runAgentConversation({
        client: client as unknown as OpenAI,
        request: BASE_REQUEST,
        options: { ...BASE_OPTIONS, debug: false },
        loggerConfig,
        agentTools: [] as AgentsSdkTool[],
        maxTurns: 1,
      });

      expect(result.assistantText).toBe("途中までの応答です。");
      expect(result.responseId).toBe("resp_partial");
      expect(result.reachedMaxIterations).toBe(true);
    } finally {
      Runner.prototype.run = originalRun;
    }
  });
});
