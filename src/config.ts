import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { CliDefaults, EffortLevel, VerbosityLevel } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "..");

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
  const configured = process.env.OPENAI_HISTORY_INDEX_FILE;
  if (typeof configured === "string") {
    const trimmed = configured.trim();
    if (trimmed.length === 0) {
      throw new Error("OPENAI_HISTORY_INDEX_FILE is set but empty.");
    }
    const expanded = expandHome(trimmed);
    return path.resolve(expanded);
  }
  const expanded = expandHome(defaultPath);
  return path.resolve(expanded);
}

function coerceEffort(value: string | undefined, fallback: EffortLevel): EffortLevel {
  if (!value) return fallback;
  const lower = value.toLowerCase();
  if (lower === "low" || lower === "medium" || lower === "high") {
    return lower as EffortLevel;
  }
  throw new Error(`OPENAI_DEFAULT_EFFORT must be one of "low", "medium", or "high". Received: ${value}`);
}

function coerceVerbosity(value: string | undefined, fallback: VerbosityLevel): VerbosityLevel {
  if (!value) return fallback;
  const lower = value.toLowerCase();
  if (lower === "low" || lower === "medium" || lower === "high") {
    return lower as VerbosityLevel;
  }
  throw new Error(
    `OPENAI_DEFAULT_VERBOSITY must be one of "low", "medium", or "high". Received: ${value}`,
  );
}

export function loadDefaults(): CliDefaults {
  const historyIndexPath = resolveHistoryPath(path.join(ROOT_DIR, "history_index.json"));
  const systemPromptPath = path.join(ROOT_DIR, "system_prompt.txt");

  return {
    modelMain: process.env.OPENAI_MODEL_MAIN ?? "gpt-5",
    modelMini: process.env.OPENAI_MODEL_MINI ?? "gpt-5-mini",
    modelNano: process.env.OPENAI_MODEL_NANO ?? "gpt-5-nano",
    effort: coerceEffort(process.env.OPENAI_DEFAULT_EFFORT, "low"),
    verbosity: coerceVerbosity(process.env.OPENAI_DEFAULT_VERBOSITY, "low"),
    historyIndexPath,
    systemPromptPath,
  };
}

export function ensureApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not found. Please set it in .env");
  }
  return apiKey;
}

export function readSystemPrompt(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const content = fs.readFileSync(filePath, "utf8");
  if (!content.trim()) {
    return undefined;
  }
  return content;
}
