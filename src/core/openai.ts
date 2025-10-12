import OpenAI from "openai";
import { ensureApiKey } from "./config.js";

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
  const apiKey = options.apiKey ?? ensureApiKey();
  return new OpenAI({ apiKey });
}
