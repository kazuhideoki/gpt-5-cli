import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z, ZodError } from "zod";
import type { CliDefaults, EffortLevel, VerbosityLevel } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** プロジェクトのルートディレクトリ絶対パス。 */
export const ROOT_DIR = path.resolve(__dirname, "../../..");

const effortLevelSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .superRefine((value, ctx) => {
    if (value !== "low" && value !== "medium" && value !== "high") {
      ctx.addIssue({
        code: "custom",
        message: `OPENAI_DEFAULT_EFFORT must be one of "low", "medium", or "high". Received: ${value}`,
      });
    }
  })
  .transform((value) => value as EffortLevel);

const verbosityLevelSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .superRefine((value, ctx) => {
    if (value !== "low" && value !== "medium" && value !== "high") {
      ctx.addIssue({
        code: "custom",
        message: `OPENAI_DEFAULT_VERBOSITY must be one of "low", "medium", or "high". Received: ${value}`,
      });
    }
  })
  .transform((value) => value as VerbosityLevel);

/** `.env`と環境変数から読み取る設定値を検証するスキーマ。 */
const envConfigSchema = z
  .object({
    OPENAI_MODEL_MAIN: z.string().trim().min(1).optional(),
    OPENAI_MODEL_MINI: z.string().trim().min(1).optional(),
    OPENAI_MODEL_NANO: z.string().trim().min(1).optional(),
    OPENAI_DEFAULT_EFFORT: effortLevelSchema.optional(),
    OPENAI_DEFAULT_VERBOSITY: verbosityLevelSchema.optional(),
    GPT_5_CLI_PROMPTS_DIR: z.string().optional(),
    GPT_5_CLI_D2_MAX_ITERATIONS: z
      .string()
      .transform((value) => value.trim())
      .pipe(
        z
          .string()
          .min(1)
          .transform((value) => Number.parseInt(value, 10))
          .superRefine((value, ctx) => {
            if (!Number.isInteger(value) || value <= 0) {
              ctx.addIssue({
                code: "custom",
                message: "GPT_5_CLI_D2_MAX_ITERATIONS must be a positive integer when specified.",
              });
            }
          }),
      )
      .transform((value) => value as number)
      .optional(),
  })
  .passthrough();

/**
 * リポジトリ直下の`.env`を読み込み、環境変数へ反映する。
 */
export function loadEnvironment(): void {
  const envPath = path.join(ROOT_DIR, ".env");
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

/**
 * `~`始まりのパスをHOME環境変数で展開する。
 *
 * @param p 変換対象のパス。
 * @returns 展開済みパス。
 */
function expandHome(p: string): string {
  if (!p.startsWith("~")) {
    return p;
  }
  const home = process.env.HOME;
  if (!home || home.trim().length === 0) {
    throw new Error("HOME environment variable is required when using '~' paths.");
  }
  return path.join(home, p.slice(1));
}

/**
 * 履歴ファイルの保存先パスを決定する。
 *
 * @param defaultPath 既定パス。
 * @returns 解析済みの絶対パス。
 */
export function resolveHistoryPath(defaultPath: string): string {
  const configured = process.env.GPT_5_CLI_HISTORY_INDEX_FILE;
  if (typeof configured === "string") {
    const trimmed = configured.trim();
    if (trimmed.length === 0) {
      throw new Error("GPT_5_CLI_HISTORY_INDEX_FILE is set but empty.");
    }
    const expanded = expandHome(trimmed);
    return path.resolve(expanded);
  }
  const expanded = expandHome(defaultPath);
  return path.resolve(expanded);
}

/**
 * プロンプトディレクトリのパスを決定する。
 *
 * @param defaultPath 既定パス。
 * @returns 解析済みの絶対パス。
 */
export function resolvePromptsDir(defaultPath: string): string {
  const configured = process.env.GPT_5_CLI_PROMPTS_DIR;
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
export function loadDefaults(): CliDefaults {
  let envConfig: z.infer<typeof envConfigSchema>;
  try {
    envConfig = envConfigSchema.parse(process.env);
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      if (firstIssue?.message) {
        throw new Error(firstIssue.message);
      }
    }
    throw error;
  }
  const historyIndexPath = resolveHistoryPath(path.join(ROOT_DIR, "history_index.json"));
  const promptsDir = resolvePromptsDir(path.join(ROOT_DIR, "prompts"));

  return {
    modelMain: envConfig.OPENAI_MODEL_MAIN ?? "gpt-5",
    modelMini: envConfig.OPENAI_MODEL_MINI ?? "gpt-5-mini",
    modelNano: envConfig.OPENAI_MODEL_NANO ?? "gpt-5-nano",
    effort: envConfig.OPENAI_DEFAULT_EFFORT ?? "low",
    verbosity: envConfig.OPENAI_DEFAULT_VERBOSITY ?? "low",
    historyIndexPath,
    promptsDir,
    d2MaxIterations: envConfig.GPT_5_CLI_D2_MAX_ITERATIONS ?? 8,
  };
}

/**
 * `OPENAI_API_KEY`の存在を検証し、値を返す。
 *
 * @returns OpenAI APIキー。
 * @throws 設定されていない場合。
 */
export function ensureApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not found. Please set it in .env");
  }
  return apiKey;
}
