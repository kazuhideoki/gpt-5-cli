/**
 * CLI 起動時に利用する環境ロードと既定値解決を担うモジュール。
 * Input 層で共通化された初期化ロジックをまとめる。
 */
import path from "node:path";
import { ZodError } from "zod";
import type { CliDefaults, ConfigEnvironment } from "../../types.js";
import { envConfigSchema, type EnvConfig } from "../../foundation/env.js";
import { ROOT_DIR, expandHome } from "../../foundation/paths.js";
import { resolveHistoryPath } from "../history/store.js";
import type { ConfigEnvContract, ConfigEnvInitOptions } from "./config-env.js";
import { ConfigEnv } from "./config-env.js";

const DEFAULT_PROMPTS_DIR = "prompts";

/** ツール呼び出し回数のデフォルト上限。 */
export const DEFAULT_MAX_ITERATIONS = 10;

type LoadEnvironmentOptions = ConfigEnvInitOptions;

/**
 * リポジトリ直下の`.env`を読み込み、必要に応じて`.env.{suffix}`で上書きする。
 *
 * @param options.envSuffix CLIごとの追加環境ファイル接尾辞。
 * @param options.baseDir   ルートディレクトリをテストなどで上書きする場合に指定。
 */
export async function loadEnvironment(
  options: LoadEnvironmentOptions = {},
): Promise<ConfigEnvContract> {
  const baseDir = options.baseDir ?? ROOT_DIR;
  const configEnv = await ConfigEnv.create({ ...options, baseDir });
  for (const [key, value] of configEnv.entries()) {
    process.env[key] = value;
  }
  return configEnv;
}

/**
 * プロンプトディレクトリのパスを決定する。
 *
 * @param defaultPath 既定パス。
 * @returns 解析済みの絶対パス。
 */
export function resolvePromptsDir(configEnv: ConfigEnvironment, defaultPath: string): string {
  const configured = configEnv.get("GPT_5_CLI_PROMPTS_DIR");
  if (typeof configured === "string") {
    const trimmed = configured.trim();
    if (trimmed.length === 0) {
      throw new Error("GPT_5_CLI_PROMPTS_DIR is set but empty.");
    }
    const expanded = expandHome(trimmed);
    return path.resolve(expanded);
  }
  const expanded = expandHome(defaultPath);
  return path.resolve(expanded);
}

/**
 * 環境変数や既定値からCLIで使用するデフォルト設定を読み込む。
 *
 * @returns CLIデフォルト値。
 */
export function loadDefaults(configEnv: ConfigEnvironment): CliDefaults {
  const envEntries = Object.fromEntries(configEnv.entries());
  let envConfig: EnvConfig;
  try {
    envConfig = envConfigSchema.parse(envEntries);
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      if (firstIssue?.message) {
        throw new Error(firstIssue.message);
      }
    }
    throw error;
  }

  const historyIndexPath = resolveHistoryPath(configEnv);
  const promptsDir = resolvePromptsDir(configEnv, path.join(ROOT_DIR, DEFAULT_PROMPTS_DIR));

  const config = envConfig;
  return {
    modelMain: config.OPENAI_MODEL_MAIN ?? "gpt-5",
    modelMini: config.OPENAI_MODEL_MINI ?? "gpt-5-mini",
    modelNano: config.OPENAI_MODEL_NANO ?? "gpt-5-nano",
    effort: config.OPENAI_DEFAULT_EFFORT ?? "low",
    verbosity: config.OPENAI_DEFAULT_VERBOSITY ?? "low",
    historyIndexPath,
    promptsDir,
    maxIterations: config.GPT_5_CLI_MAX_ITERATIONS ?? DEFAULT_MAX_ITERATIONS,
  };
}
