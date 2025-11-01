/**
 * @file finalize アクション生成のためのビルダー群。
 * CLI 層などが利用するヘルパーをまとめる。
 */
import type {
  FinalizeClipboardAction,
  FinalizeCopySource,
  FinalizeD2HtmlAction,
} from "../types.js";

/**
 * クリップボードアクション生成時に必要な入力。
 */
interface ClipboardActionParams {
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

/**
 * D2 HTML 変換アクション生成時に必要な入力。
 */
interface D2HtmlActionParams {
  /** 変換対象となる D2 ファイルの相対パス。 */
  sourcePath: string;
  /** 生成した HTML を出力する相対パス。 */
  htmlOutputPath: string;
  /** コマンドを実行する作業ディレクトリ。 */
  workingDirectory: string;
  /** HTML 生成後にブラウザで開く場合に true。 */
  openHtml: boolean;
  /** 実行優先順位。小さい値ほど先に実行される。 */
  priority: number;
}

/**
 * D2 HTML 変換アクションを構築する。
 */
export function createD2HtmlAction(params: D2HtmlActionParams): FinalizeD2HtmlAction {
  return {
    kind: "d2-html",
    sourcePath: params.sourcePath,
    htmlOutputPath: params.htmlOutputPath,
    workingDirectory: params.workingDirectory,
    openHtml: params.openHtml,
    priority: params.priority,
  };
}
