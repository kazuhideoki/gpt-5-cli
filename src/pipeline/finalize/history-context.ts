/**
 * @file finalize 層が提供する汎用的な履歴コンテキストビルダー。
 * ファイル出力を伴う CLI（d2 / mermaid など）向けに、履歴へ保存する基本情報を組み立てる。
 */
import type { TaskMode } from "../../types.js";

export interface FileHistoryContext {
  cli: TaskMode;
  file_path?: string;
  output?: {
    file?: string;
    copy?: boolean;
  };
}

interface BuildFileHistoryContextParams<TContext extends FileHistoryContext> {
  base: TContext;
  /**
   * 実際に生成された成果物の絶対パスなど、優先して使いたいファイルパス。
   */
  contextPath?: string;
  /**
   * CLI が認識している既定の出力パス。`contextPath` が無い場合のフォールバックに利用する。
   */
  defaultFilePath?: string;
  /**
   * 直前の履歴コンテキスト。ファイルパスや copy フラグを必要に応じて引き継ぐ。
   */
  previousContext?: FileHistoryContext;
  /**
   * 履歴に保存したい出力ファイルパス。`summaryOutputPath ?? options.<filePath>` などを想定する。
   */
  historyOutputFile?: string;
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
  const { base, contextPath, defaultFilePath, previousContext, historyOutputFile, copyOutput } =
    params;

  const result: TContext = {
    ...base,
  };

  const fallbackPath = defaultFilePath ?? previousContext?.file_path;
  const resolvedFilePath = contextPath ?? fallbackPath;
  if (resolvedFilePath !== undefined) {
    result.file_path = resolvedFilePath;
  } else {
    delete result.file_path;
  }

  if (historyOutputFile !== undefined || copyOutput) {
    result.output = {
      file: historyOutputFile,
      ...(copyOutput ? { copy: true } : {}),
    };
  } else if (previousContext?.output) {
    // copy フラグなど以前の情報をそのまま引き継ぐ。
    result.output = { ...previousContext.output };
  } else {
    delete result.output;
  }

  return result;
}
