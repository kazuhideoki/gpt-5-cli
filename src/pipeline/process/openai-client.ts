// openai-client.ts: Process 層で利用する OpenAI クライアントのファクトリ。
// 責務: APIキーの解決（configへ委譲）と OpenAI インスタンス生成のみ。
import OpenAI from "openai";
import type { ConfigEnvironment } from "../../types.js";

interface CreateOpenAIClientOptions {
  /** ConfigEnv から得た値をテスト等で上書きしたい場合に使う明示 API キー。 */
  apiKey?: string;
  /** `.env` 群を読み取った ConfigEnv。 */
  configEnv: ConfigEnvironment;
}

/**
 * OpenAIクライアントを生成する。
 * @param options 明示APIキー（省略時は環境変数）
 */
export function createOpenAIClient(options: CreateOpenAIClientOptions): OpenAI {
  const apiKey = resolveOpenAIApiKey(options);
  return new OpenAI({ apiKey });
}

/**
 * OpenAI APIキーを環境から解決する。
 * `.env` および `.env.{suffix}`（ask/d2/sql）による上書きを前提とする。
 *
 * @throws `OPENAI_API_KEY not found` を含むエラー（テスト互換のため）。
 */
function resolveOpenAIApiKey(options: CreateOpenAIClientOptions): string {
  if (typeof options.apiKey === "string" && options.apiKey.trim().length > 0) {
    return options.apiKey.trim();
  }
  const configValue = options.configEnv.get("OPENAI_API_KEY");
  const rawFromConfig = typeof configValue === "string" ? configValue.trim() : "";
  if (rawFromConfig.length === 0) {
    throw new Error("OPENAI_API_KEY not found. Please set it in .env or .env.{ask|d2|sql}");
  }
  return rawFromConfig;
}
