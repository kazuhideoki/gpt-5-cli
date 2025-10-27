/**
 * @file CLI でのサマリ出力先判定を共通化するユーティリティ。
 */
import type { ResultOutputResolution, ResultOutputResolutionParams } from "./types.js";

const EMPTY_PATH_LENGTH = 0;

function shouldUseTextOutput(
  params: ResultOutputResolutionParams,
): params is ResultOutputResolutionParams & {
  responseOutputPath: string;
} {
  if (!params.responseOutputExplicit) {
    return false;
  }
  if (!params.responseOutputPath || params.responseOutputPath.length === EMPTY_PATH_LENGTH) {
    return false;
  }
  return params.responseOutputPath !== params.artifactPath;
}

/**
 * CLI がユーザーへ返すサマリテキスト保存先を決定する。
 */
export function resolveResultOutput(params: ResultOutputResolutionParams): ResultOutputResolution {
  if (shouldUseTextOutput(params)) {
    return {
      textOutputPath: params.responseOutputPath,
      artifactReferencePath: params.responseOutputPath,
    };
  }

  return {
    textOutputPath: null,
    artifactReferencePath: params.artifactPath,
  };
}
