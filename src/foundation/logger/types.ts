// types.ts: ロガー関連の共通型契約を集約する。
import type { Logger } from "winston";
import type { TaskMode } from "../../types.js";

/**
 * CLI 用ロガーの生成時に提供するパラメータ。
 */
export interface CliLoggerParams {
  /**
   * ロガーが紐づく CLI モード。
   */
  task: TaskMode;
  /**
   * ロガーに付与する任意のラベル。
   */
  label: string;
  /**
   * デバッグレベルの詳細ログを有効化する場合は true。
   */
  debug: boolean;
}

/**
 * CLI 層およびパイプライン層が利用するロガーの契約。
 */
export type CliLogger = Logger;

/**
 * CLI 全体で共有するロガー設定。
 *
 * プロセス層でも同じ契約を再利用し、ラベル付きのロガーを必ず注入する。
 */
export interface CliLoggerConfig {
  /** CLI で利用する Winston ベースのロガー。 */
  logger: CliLogger;
  /** ログ行に付与する CLI 固有ラベル。 */
  logLabel: string;
  /** デバッグレベルの詳細ログを有効化するとき true。 */
  debugEnabled: boolean;
}
