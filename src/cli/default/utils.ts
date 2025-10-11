import type { EffortLevel } from "./types.js";

type Level = EffortLevel;

interface LogStyle {
  mediumPrefix: string;
  highPrefix: string;
  reset: string;
}

function resolveLogStyle(): LogStyle {
  // TTY(端末)で実行されている場合のみカラーを有効化する
  const supportsColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
  if (!supportsColor) {
    return { mediumPrefix: "", highPrefix: "", reset: "" };
  }

  return {
    mediumPrefix: "\u001b[33m",
    highPrefix: "\u001b[1;31m",
    reset: "\u001b[0m",
  };
}

/**
 * 指定したレベルに応じて値を強調表示する。
 *
 * @param value 表示文字列。
 * @param level 強調レベル。
 * @returns 装飾済みの文字列。
 */
export function decorateLevelValue(value: string, level: Level): string {
  const style = resolveLogStyle();
  if (level === "medium") {
    return `${style.mediumPrefix}+${value}+${style.reset}`;
  }
  if (level === "high") {
    return `${style.highPrefix}!${value}!${style.reset}`;
  }
  return value;
}

/**
 * 文字列値からeffort/verbosityに対応するレベルを推測する。
 *
 * @param value 比較対象の文字列。
 * @returns 判定されたレベル。
 */
export function levelForScaleValue(value: string): Level {
  const lower = value.toLowerCase();
  if (lower === "low") return "low";
  if (lower === "medium") return "medium";
  if (lower === "high") return "high";
  return "high";
}

/**
 * モデル名と既定モデルを比較して推定レベルを返す。
 *
 * @param value モデル名。
 * @param modelMain メインモデル名。
 * @param modelMini ミニモデル名。
 * @param modelNano ナノモデル名。
 * @returns 推定レベル。
 */
export function levelForModelValue(
  value: string,
  modelMain: string,
  modelMini: string,
  modelNano: string,
): Level {
  if (value === modelMain) return "high";
  if (value === modelMini) return "medium";
  if (value === modelNano) return "low";

  const lower = value.toLowerCase();
  if (lower.includes("nano") || lower.includes("lite") || lower.includes("small")) {
    return "low";
  }
  if (lower.includes("mini") || lower.includes("base")) {
    return "medium";
  }
  return "high";
}

/**
 * モデル名をレベルに応じて装飾し、ログ向けに整形する。
 */
export function formatModelValue(
  value: string,
  modelMain: string,
  modelMini: string,
  modelNano: string,
): string {
  return decorateLevelValue(value, levelForModelValue(value, modelMain, modelMini, modelNano));
}

/**
 * スケール値（effort/verbosity）を装飾して整形する。
 */
export function formatScaleValue(value: string): string {
  return decorateLevelValue(value, levelForScaleValue(value));
}
