import { describe, expect, it } from "bun:test";
import type OpenAI from "openai";
import type { CliOptions } from "../../core/types.js";
import { runAgentConversation } from "./agent-conversation.js";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { ToolRegistration } from "./tools/index.js";

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
    const result = await runAgentConversation({
      client: client as unknown as OpenAI,
      request: BASE_REQUEST,
      options: BASE_OPTIONS,
      logLabel: "[agent-test]",
      toolRegistrations: [] as ToolRegistration[],
      maxTurns: 2,
    });

    expect(result.assistantText).toBe("Agent result");
    expect(result.responseId).toBe("resp_test");
    expect(client.responses.createCalls).toHaveLength(1);

    const [requestBody] = client.responses.createCalls;
    expect(requestBody.instructions).toContain("You are a helpful agent.");
    expect(Array.isArray(requestBody.input)).toBe(true);
    expect(requestBody.input.at(-1)?.content?.[0]?.text).toBe("Create a diagram");
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
        logLabel: "[agent-test]",
        toolRegistrations: [] as ToolRegistration[],
      }),
    ).rejects.toThrow("Error: No user input found for agent execution");
  });
});
