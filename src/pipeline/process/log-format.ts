// log-format.ts: パイプライン層で利用するログ整形ユーティリティ。
// NOTE: 将来的に共通ロギング基盤へ移行する際は foundation/logging (仮) へ再配置する。
import type { EffortLevel } from "../../types.js";

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

// TODO: foundation/logging (仮称) の整備後、resolveLogStyle などの端末依存処理を移設する。
