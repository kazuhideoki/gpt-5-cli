import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z, ZodError } from "zod";
import type { CliDefaults, EffortLevel, VerbosityLevel } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** プロジェクトのルートディレクトリ絶対パス。 */
export const ROOT_DIR = path.resolve(__dirname, "../..");

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
    GPT_5_CLI_MAX_ITERATIONS: z
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
                message: "GPT_5_CLI_MAX_ITERATIONS must be a positive integer when specified.",
              });
            }
          }),
      )
      .transform((value) => value as number)
      .optional(),
  })
  .passthrough();

interface LoadEnvironmentOptions {
  envSuffix?: string;
  baseDir?: string;
}

/**
 * リポジトリ直下の`.env`を読み込み、必要に応じて`.env.{suffix}`で上書きする。
 *
 * @param options.envSuffix CLIごとの追加環境ファイル接尾辞。
 * @param options.baseDir   ルートディレクトリをテストなどで上書きする場合に指定。
 */
export function loadEnvironment(options: LoadEnvironmentOptions = {}): void {
  const baseDir = options.baseDir ?? ROOT_DIR;
  const appliedFromBase = new Set<string>();
  const applyEnvFile = (filePath: string, mode: "base" | "override") => {
    if (!fs.existsSync(filePath)) {
      return;
    }
    const parsed = dotenv.parse(fs.readFileSync(filePath, "utf8"));
    Object.entries(parsed).forEach(([key, value]) => {
      if (mode === "base") {
        if (process.env[key] === undefined) {
          process.env[key] = value;
          appliedFromBase.add(key);
        }
        return;
      }
      if (process.env[key] === undefined || appliedFromBase.has(key)) {
        process.env[key] = value;
      }
    });
  };

  const envPath = path.join(baseDir, ".env");
  applyEnvFile(envPath, "base");

  const suffix = options.envSuffix?.trim();
  if (suffix && suffix.length > 0) {
    applyEnvFile(path.join(baseDir, `.env.${suffix}`), "override");
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
export function resolveHistoryPath(defaultPath?: string): string {
  const configured = process.env.GPT_5_CLI_HISTORY_INDEX_FILE;
  if (typeof configured === "string") {
    const trimmed = configured.trim();
    if (trimmed.length === 0) {
      throw new Error("GPT_5_CLI_HISTORY_INDEX_FILE is set but empty.");
    }
    const expanded = expandHome(trimmed);
    return path.resolve(expanded);
  }
  if (typeof defaultPath === "string") {
    const trimmed = defaultPath.trim();
    if (trimmed.length === 0) {
      throw new Error("Default history path is empty.");
    }
    const expanded = expandHome(trimmed);
    return path.resolve(expanded);
  }
  throw new Error("GPT_5_CLI_HISTORY_INDEX_FILE must be configured via environment files.");
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
  const historyIndexPath = resolveHistoryPath();
  const promptsDir = resolvePromptsDir(path.join(ROOT_DIR, "prompts"));

  return {
    modelMain: envConfig.OPENAI_MODEL_MAIN ?? "gpt-5",
    modelMini: envConfig.OPENAI_MODEL_MINI ?? "gpt-5-mini",
    modelNano: envConfig.OPENAI_MODEL_NANO ?? "gpt-5-nano",
    effort: envConfig.OPENAI_DEFAULT_EFFORT ?? "low",
    verbosity: envConfig.OPENAI_DEFAULT_VERBOSITY ?? "low",
    historyIndexPath,
    promptsDir,
    maxIterations: envConfig.GPT_5_CLI_MAX_ITERATIONS ?? 8,
  };
}
