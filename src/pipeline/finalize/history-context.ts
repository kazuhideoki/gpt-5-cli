/**
 * @file finalize 層が提供する汎用的な履歴コンテキストビルダー。
 * ファイル出力を伴う CLI（d2 / mermaid など）向けに、履歴へ保存する基本情報を組み立てる。
 */
import type { TaskMode } from "../../types.js";

/**
 * finalize 層が履歴へ保存するファイル成果物の基礎情報。
 * 各プロパティは `undefined` の場合にコンテキスト未設定を示す。
 */
export interface FileHistoryContext {
  cli: TaskMode;
  /** 絶対パスでのファイル参照。 */
  absolute_path: string | undefined;
  /** ワークスペース基準の相対パス。 */
  relative_path: string | undefined;
  /** コピー指示フラグ。 */
  copy: boolean | undefined;
}

interface BuildFileHistoryContextParams<TContext extends FileHistoryContext> {
  base: TContext;
  /**
   * 実際に生成された成果物の絶対パスなど、優先して使いたいファイルパス。
   * `undefined` の場合は優先パスが存在しないことを示す。
   */
  contextPath: string | undefined;
  /**
   * CLI が認識している既定の出力パス。`contextPath` が無い場合のフォールバックに利用する。
   * `undefined` の場合は CLI 既定値が存在しない。
   */
  defaultFilePath: string | undefined;
  /**
   * 直前の履歴コンテキスト。ファイルパスや copy フラグを必要に応じて引き継ぐ。
   * 履歴が無い場合は `undefined`。
   */
  previousContext: FileHistoryContext | undefined;
  /**
   * 履歴に保存したい Artifact のパス。`responseOutputPath ?? options.<artifactPath>` などを想定する。
   * 保存しない場合は `undefined`。
   */
  historyArtifactPath: string | undefined;
  /**
   * `--copy` フラグが有効かどうか。
   */
  copyOutput: boolean;
}

/**
 * d2 / mermaid など、単純なファイル成果物を扱う CLI の履歴コンテキストを構築する。
 *
 * @param params コンテキスト構築に必要な情報。
 * @returns 履歴へ保存するコンテキスト。
 */
export function buildFileHistoryContext<TContext extends FileHistoryContext>(
  params: BuildFileHistoryContextParams<TContext>,
): TContext {
  const { base, contextPath, defaultFilePath, previousContext, historyArtifactPath, copyOutput } =
    params;

  const result: TContext = {
    ...base,
  };

  const resolvedAbsolutePath = contextPath ?? previousContext?.absolute_path;
  if (resolvedAbsolutePath !== undefined) {
    result.absolute_path = resolvedAbsolutePath;
  } else {
    delete result.absolute_path;
  }

  const resolvedRelativePath =
    historyArtifactPath ?? defaultFilePath ?? previousContext?.relative_path;
  if (resolvedRelativePath !== undefined) {
    result.relative_path = resolvedRelativePath;
  } else {
    delete result.relative_path;
  }

  if (copyOutput || previousContext?.copy) {
    result.copy = true;
  } else {
    delete result.copy;
  }

  return result;
}
