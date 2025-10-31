// create-cli-logger.ts: CLI 向け Winston ロガー生成ヘルパー。
import type { TransformableInfo } from "logform";
import { createLogger, format, transports } from "winston";
import type { CliLogger, CliLoggerParams } from "./types.js";

const MESSAGE_SYMBOL = Symbol.for("message");
const LEVEL_SYMBOL = Symbol.for("level");
const SPLAT_SYMBOL = Symbol.for("splat");
// Winston ログの JSON 化で BigInt を拒否しないよう文字列へ変換する。
const JSON_REPLACER = (_key: string, value: unknown) => {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
};

/**
 * CLI 専用ロガーを生成する。
 *
 * @param params CLI モード・表示ラベル・ログレベル設定。
 * @returns Winston Logger インスタンス。
 */
export function createCliLogger(params: CliLoggerParams): CliLogger {
  const level = params.debug ? "debug" : "info";

  const consoleFormat = format.combine(
    format.errors({ stack: true }),
    format.splat(),
    format.label({ label: params.label }),
    format.timestamp(),
    format.printf((entry) => formatConsoleLine(entry)),
  );

  return createLogger({
    level,
    defaultMeta: { task: params.task },
    format: consoleFormat,
    transports: [
      new transports.Console({
        level,
        stderrLevels: ["error"],
        consoleWarnLevels: ["warn"],
      }),
    ],
  });
}

function formatConsoleLine(
  info: TransformableInfo & { label?: string; timestamp?: string },
): string {
  if (info.label === undefined) {
    throw new Error("Logger format requires label metadata.");
  }

  if (info.timestamp === undefined) {
    throw new Error("Logger format requires timestamp metadata.");
  }

  const resolvedLabel = info.label.startsWith("[") ? info.label : `[${info.label}]`;
  const prefixParts = [resolvedLabel, info.timestamp];
  const line = `${prefixParts.join(" ")} ${info.level}: ${coerceMessage(info)}`;
  const metadata = extractMetadata(info);
  return metadata === undefined ? line : `${line} ${metadata}`;
}

function coerceMessage(info: TransformableInfo): string {
  const message = info[MESSAGE_SYMBOL];
  if (typeof message === "string") {
    return message;
  }

  if (typeof info.message === "string") {
    return info.message;
  }

  return JSON.stringify(info.message);
}

/** Winston が付与する内部フィールドを取り除いた追加メタデータのみを JSON 化して返す。*/
function extractMetadata(info: TransformableInfo): string | undefined {
  const residual = { ...info } as Record<string | symbol, unknown>;
  delete residual.message;
  delete residual.level;
  delete residual.timestamp;
  delete residual.label;
  delete residual[MESSAGE_SYMBOL];
  delete residual[LEVEL_SYMBOL];
  const splat = residual[SPLAT_SYMBOL];
  delete residual[SPLAT_SYMBOL];

  const keys = Object.keys(residual);
  const symbolKeys = Object.getOwnPropertySymbols(residual);

  if (keys.length === 0 && symbolKeys.length === 0) {
    return undefined;
  }

  const metadata: Record<string, unknown> = {};
  // format.splat() が配列展開した要素に付ける numeric キーは後で metadata.splat に集約する。
  const shouldSkipKey = (key: string) =>
    Array.isArray(splat) && /^[0-9]+$/.test(key) && Number.parseInt(key, 10) < splat.length;

  for (const key of keys) {
    if (shouldSkipKey(key)) {
      continue;
    }
    metadata[key] = residual[key];
  }
  for (const symbolKey of symbolKeys) {
    if (symbolKey === MESSAGE_SYMBOL || symbolKey === LEVEL_SYMBOL || symbolKey === SPLAT_SYMBOL) {
      continue;
    }

    metadata[String(symbolKey)] = residual[symbolKey];
  }

  // format.splat() が保持する追加メタデータを欠落させないよう JSON に含める。
  if (Array.isArray(splat) && splat.length > 0) {
    metadata.splat = splat;
  }

  if (Object.keys(metadata).length === 0 && Object.getOwnPropertySymbols(metadata).length === 0) {
    return undefined;
  }

  return JSON.stringify(metadata, JSON_REPLACER);
}
