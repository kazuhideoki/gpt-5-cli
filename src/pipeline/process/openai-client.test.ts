import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import OpenAI from "openai";
import type { ConfigEnvironment } from "../../types.js";
import { createOpenAIClient } from "./openai-client.js";

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
    const configEnv = createConfigEnv();
    expect(() => createOpenAIClient({ configEnv })).toThrow("OPENAI_API_KEY not found");
  });

  it("環境変数からAPIキーを読み取って初期化する", () => {
    process.env.OPENAI_API_KEY = "test-key";
    const configEnv = createConfigEnv({ OPENAI_API_KEY: "test-key" });
    const client = createOpenAIClient({ configEnv });
    expect(client).toBeInstanceOf(OpenAI);
  });

  it("明示したAPIキーを優先して利用する", () => {
    const configEnv = createConfigEnv({ OPENAI_API_KEY: "ignored" });
    const client = createOpenAIClient({ apiKey: "override-key", configEnv });
    expect(client).toBeInstanceOf(OpenAI);
  });

  it("ConfigEnv の API キーを優先して参照する", () => {
    delete process.env.OPENAI_API_KEY;
    const configEnv = createConfigEnv({ OPENAI_API_KEY: "config-key" });

    const client = createOpenAIClient({ configEnv });

    expect(client).toBeInstanceOf(OpenAI);
  });
});
