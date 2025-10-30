/**
 * @file finalize アクション生成のためのビルダー群。
 * CLI 層などが利用するヘルパーをまとめる。
 */
import type { FinalizeClipboardAction, FinalizeCopySource } from "../types.js";

/**
 * クリップボードアクション生成時に必要な入力。
 */
export interface ClipboardActionParams {
  /** コピー対象を表す情報。 */
  source: FinalizeCopySource;
  /** アクションを実行する作業ディレクトリ。 */
  workingDirectory: string;
  /** 実行優先順位。小さい値ほど先に実行される。 */
  priority: number;
}

/**
 * クリップボードアクションを構築する。
 */
export function createClipboardAction(params: ClipboardActionParams): FinalizeClipboardAction {
  return {
    kind: "clipboard",
    flag: "--copy",
    source: params.source,
    workingDirectory: params.workingDirectory,
    priority: params.priority,
  };
}
