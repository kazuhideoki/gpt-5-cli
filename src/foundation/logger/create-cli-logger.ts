// create-cli-logger.ts: CLI 向け Winston ロガー生成ヘルパー。
import { createLogger } from "winston";
import type { CliLogger, CliLoggerParams } from "./types.js";

/**
 * CLI 専用ロガーを生成する。
 */
export function createCliLogger(params: CliLoggerParams): CliLogger {
  return createLogger({
    level: "info",
    defaultMeta: { task: params.task },
  });
}
