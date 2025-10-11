import type { EffortLevel } from "./types.js";

type Level = EffortLevel;

interface LogStyle {
  mediumPrefix: string;
  highPrefix: string;
  reset: string;
}

let cachedLogStyle: LogStyle | null = null;

function resolveLogStyle(): LogStyle {
  if (cachedLogStyle) {
    return cachedLogStyle;
  }

  const supportsColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
  if (!supportsColor) {
    cachedLogStyle = { mediumPrefix: "", highPrefix: "", reset: "" };
    return cachedLogStyle;
  }

  cachedLogStyle = {
    mediumPrefix: "\u001b[33m",
    highPrefix: "\u001b[1;31m",
    reset: "\u001b[0m",
  };
  return cachedLogStyle;
}

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

export function levelForScaleValue(value: string): Level {
  const lower = value.toLowerCase();
  if (lower === "low") return "low";
  if (lower === "medium") return "medium";
  if (lower === "high") return "high";
  return "high";
}

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

export function formatModelValue(
  value: string,
  modelMain: string,
  modelMini: string,
  modelNano: string,
): string {
  return decorateLevelValue(value, levelForModelValue(value, modelMain, modelMini, modelNano));
}

export function formatScaleValue(value: string): string {
  return decorateLevelValue(value, levelForScaleValue(value));
}

// テスト用途でスタイルキャッシュをリセットする。
export function __resetLogStyleCacheForTest(): void {
  cachedLogStyle = null;
}

// テスト用途でスタイルキャッシュを上書きする。
export function __setLogStyleForTest(style: LogStyle | null): void {
  cachedLogStyle = style;
}
