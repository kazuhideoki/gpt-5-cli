import fs from "node:fs";
import path from "node:path";
import type { TaskMode } from "./types.js";

/** プロンプトテンプレートとして扱うファイル拡張子。 */
const PROMPT_EXTENSION = ".md";

/**
 * モード文字列を正規化し、未指定時は`ask`を返す。
 *
 * @param mode CLIオプションで指定されたモード。
 * @returns 正規化されたモード名。
 */
function normalizeMode(mode?: string | TaskMode): string {
  if (typeof mode === "string") {
    const trimmed = mode.trim();
    return trimmed.length > 0 ? trimmed : "ask";
  }
  if (mode) {
    return mode;
  }
  return "ask";
}

/**
 * 指定パスのプロンプトファイルを読み込み、空ならundefinedを返す。
 *
 * @param filePath 読み込み対象パス。
 * @returns 読み込んだ文字列、またはundefined。
 */
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

/**
 * モード名からプロンプトファイルの絶対パスを導出する。
 *
 * @param mode 選択されたモード。
 * @param promptsDir プロンプトファイルの配置ディレクトリ。
 * @returns 対応するファイルパス。
 */
export function resolvePromptPath(mode: string | TaskMode | undefined, promptsDir: string): string {
  const normalized = normalizeMode(mode);
  return path.join(promptsDir, `${normalized}${PROMPT_EXTENSION}`);
}
