import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z, ZodError } from "zod";
import type { CliDefaults, EffortLevel, VerbosityLevel } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "..");

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

const envConfigSchema = z
  .object({
    OPENAI_MODEL_MAIN: z.string().trim().min(1).optional(),
    OPENAI_MODEL_MINI: z.string().trim().min(1).optional(),
    OPENAI_MODEL_NANO: z.string().trim().min(1).optional(),
    OPENAI_DEFAULT_EFFORT: effortLevelSchema.optional(),
    OPENAI_DEFAULT_VERBOSITY: verbosityLevelSchema.optional(),
    GPT_5_CLI_PROMPTS_DIR: z.string().optional(),
  })
  .passthrough();

export function loadEnvironment(): void {
  const envPath = path.join(ROOT_DIR, ".env");
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

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
  };
}

export function ensureApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not found. Please set it in .env");
  }
  return apiKey;
}
