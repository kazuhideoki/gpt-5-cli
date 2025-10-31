/**
 * CLI ロガーに関するユーティリティを提供するモジュール。
 * 実装は create-cli-logger.ts を用いたログ出力へ置き換える想定。
 */
import type { CliLoggerConfig } from "./types.js";
import type { BuildAgentsToolListOptions } from "../../pipeline/process/tools/runtime.js";

/**
 * ツール実行時ログを CLI ロガーへ委譲するためのオプションを構築する。
 */
export function createCliToolLoggerOptions(
  config: CliLoggerConfig,
): BuildAgentsToolListOptions {
  return {
    logLabel: config.logLabel,
    createExecutionContext: () => ({
      cwd: process.cwd(),
      log: (message: string) => {
        console.log(`${config.logLabel} ${message}`);
      },
    }),
    debugLog: config.debugEnabled
      ? (message: string) => {
          console.error(`${config.logLabel} debug: ${message}`);
        }
      : undefined,
  };
}
