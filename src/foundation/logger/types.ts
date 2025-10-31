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
