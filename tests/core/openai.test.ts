import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import OpenAI from "openai";
import { createOpenAIClient } from "../../src/core/openai.js";

const originalApiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalApiKey;
  }
});

describe("createOpenAIClient", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("環境変数が無ければ例外を送出する", () => {
    expect(() => createOpenAIClient()).toThrow("OPENAI_API_KEY not found");
  });

  it("環境変数からAPIキーを読み取って初期化する", () => {
    process.env.OPENAI_API_KEY = "test-key";
    const client = createOpenAIClient();
    expect(client).toBeInstanceOf(OpenAI);
  });

  it("明示したAPIキーを優先して利用する", () => {
    const client = createOpenAIClient({ apiKey: "override-key" });
    expect(client).toBeInstanceOf(OpenAI);
  });
});
