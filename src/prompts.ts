import fs from "node:fs";
import path from "node:path";
import type { TaskMode } from "./types.js";

function normalizeMode(mode?: string | TaskMode): string {
  if (typeof mode === "string") {
    const trimmed = mode.trim();
    return trimmed.length > 0 ? trimmed : "default";
  }
  if (mode) {
    return mode;
  }
  return "default";
}

function readPromptFile(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const content = fs.readFileSync(filePath, "utf8");
  if (content.trim().length === 0) {
    return undefined;
  }
  return content;
}

/**
 * 指定したモードに対応するプロンプトファイルを読み込む。
 * 存在しない、もしくは空の場合は undefined を返す。
 */
export function loadPrompt(
  mode: string | TaskMode | undefined,
  promptsDir: string,
): string | undefined {
  const normalized = normalizeMode(mode);
  const filePath = resolvePromptPath(normalized, promptsDir);
  return readPromptFile(filePath);
}

export function resolvePromptPath(mode: string | TaskMode | undefined, promptsDir: string): string {
  const normalized = normalizeMode(mode);
  return path.join(promptsDir, `${normalized}.txt`);
}
