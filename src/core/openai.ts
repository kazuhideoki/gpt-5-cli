import OpenAI from "openai";

export interface CreateOpenAIClientOptions {
  /**
   * 明示的に指定するAPIキー。省略時は環境変数から取得する。
   */
  apiKey?: string;
}

/**
 * OpenAIクライアントを生成する。
 *
 * @param options 明示的なAPIキー設定。
 * @returns 初期化済みのOpenAIクライアント。
 */
export function createOpenAIClient(options: CreateOpenAIClientOptions = {}): OpenAI {
  const apiKey = resolveApiKey(options.apiKey);
  return new OpenAI({ apiKey });
}

function resolveApiKey(explicit?: string): string {
  if (typeof explicit === "string") {
    return explicit;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not found. Please set it in .env");
  }
  return apiKey;
}
