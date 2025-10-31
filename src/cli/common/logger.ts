/**
 * CLI ロガーに関するユーティリティを提供するモジュール。
 * 実装は create-cli-logger.ts を用いたログ出力へ置き換える想定。
 */
import type { CliLoggerConfig } from "./types.js";
import type { BuildAgentsToolListOptions } from "../../pipeline/process/tools/runtime.js";
import type { CliLogger } from "../../foundation/logger/types.js";

/**
 * ツール実行時ログを CLI ロガーへ委譲するためのオプションを構築する。
 */
export function createCliToolLoggerOptions(config: CliLoggerConfig): BuildAgentsToolListOptions {
  return {
    logLabel: config.logLabel,
    createExecutionContext: () => ({
      cwd: process.cwd(),
      log: (message: string) => {
        config.logger.info(message);
      },
    }),
    debugLog: config.debugEnabled ? (message: string) => config.logger.debug(message) : undefined,
  };
}

/**
 * CLI ロガー本体と全トランスポートのログレベルを同時に更新する。
 * Winston Logger#setLevel はトランスポートへ伝播しないため、個別に設定する。
 */
export function updateCliLoggerLevel(logger: CliLogger, level: string): void {
  logger.level = level;
  for (const transport of logger.transports) {
    transport.level = level;
  }
}
