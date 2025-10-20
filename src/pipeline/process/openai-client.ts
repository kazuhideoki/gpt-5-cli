// openai-client.ts: Process 層で利用する OpenAI クライアントのファクトリ。
// 責務: APIキーの解決（configへ委譲）と OpenAI インスタンス生成のみ。
import OpenAI from "openai";

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

/**
 * OpenAI APIキーを環境から解決する。
 * `.env` および `.env.{suffix}`（ask/d2/sql）による上書きを前提とする。
 *
 * @throws `OPENAI_API_KEY not found` を含むエラー（テスト互換のため）。
 */
function resolveOpenAIApiKey(): string {
  const raw = process.env.OPENAI_API_KEY;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("OPENAI_API_KEY not found. Please set it in .env or .env.{ask|d2|sql}");
  }
  return raw.trim();
}
