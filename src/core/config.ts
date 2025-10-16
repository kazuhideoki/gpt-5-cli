import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z, ZodError } from "zod";
import type { CliDefaults, EffortLevel, VerbosityLevel } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** プロジェクトのルートディレクトリ絶対パス。 */
export const ROOT_DIR = path.resolve(__dirname, "../..");
/** ツール呼び出し回数のデフォルト上限。 */
export const DEFAULT_MAX_ITERATIONS = 10;

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
  // 既存の環境スナップショット（親プロセスが渡した値や Bun の自動読み込みを区別するため）
  const existingEnv = new Map<string, string | undefined>(
    Object.entries(process.env).map(([k, v]) => [k, v]),
  );

  const baseEnvPath = path.join(baseDir, ".env");
  const baseParsed = fs.existsSync(baseEnvPath)
    ? dotenv.parse(fs.readFileSync(baseEnvPath, "utf8"))
    : undefined;

  // 親環境に無いキーのみ .env で補完
  if (baseParsed) {
    for (const [key, value] of Object.entries(baseParsed)) {
      if (!existingEnv.has(key)) {
        process.env[key] = value;
      }
    }
  }

  const suffix = options.envSuffix?.trim();
  if (suffix && suffix.length > 0) {
    const overrideEnvPath = path.join(baseDir, `.env.${suffix}`);
    if (fs.existsSync(overrideEnvPath)) {
      const overrideParsed = dotenv.parse(fs.readFileSync(overrideEnvPath, "utf8"));
      for (const [key, value] of Object.entries(overrideParsed)) {
        const existedAtStart = existingEnv.has(key);
        if (!existedAtStart) {
          // 新規キーはそのまま適用
          process.env[key] = value;
          continue;
        }
        // 既存キーの場合、元の値が .env の値と一致するなら上書き（Bun の自動 .env を置き換える）。
        const baseValue = baseParsed?.[key];
        if (baseValue !== undefined && existingEnv.get(key) === baseValue) {
          process.env[key] = value;
        }
        // それ以外（親プロセスが明示した値など）は尊重し、上書きしない。
      }
    }
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
    maxIterations: envConfig.GPT_5_CLI_MAX_ITERATIONS ?? DEFAULT_MAX_ITERATIONS,
  };
}

/**
 * OpenAI APIキーを環境から解決する。
 * `.env` および `.env.{suffix}`（ask/d2/sql）による上書きを前提とする。
 *
 * @throws `OPENAI_API_KEY not found` を含むエラー（テスト互換のため）。
 */
export function resolveOpenAIApiKey(): string {
  const raw = process.env.OPENAI_API_KEY;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    // テスト互換: 既存テストがこのメッセージ断片を期待している
    throw new Error("OPENAI_API_KEY not found. Please set it in .env or .env.{ask|d2|sql}");
  }
  return raw.trim();
}
