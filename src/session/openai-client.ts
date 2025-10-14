// openai-client.ts: Session層で利用するOpenAIクライアントのファクトリ。
// 責務: APIキーの解決（configへ委譲）と OpenAI インスタンス生成のみ。
import OpenAI from "openai";
import { resolveOpenAIApiKey } from "../core/config.js";

interface CreateOpenAIClientOptions {
  /** 明示的に指定するAPIキー。省略時は環境から解決。 */
  apiKey?: string;
}

/**
 * OpenAIクライアントを生成する。
 * @param options 明示APIキー（省略時は環境変数）
 */
export function createOpenAIClient(options: CreateOpenAIClientOptions = {}): OpenAI {
  const apiKey = typeof options.apiKey === "string" ? options.apiKey : resolveOpenAIApiKey();
  return new OpenAI({ apiKey });
}
