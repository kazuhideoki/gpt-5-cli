/**
 * @file finalize 層のエントリーポイント。CLI の結果処理を集約する。
 */

import { deliverOutput } from "./io.js";
import type { FinalizeOutcome, FinalizeRequest } from "./types.js";

const DEFAULT_EXIT_CODE = 0;

/**
 * CLI の結果をファイル出力・履歴更新・標準出力へ反映する。
 *
 * @param args 終了時処理に必要な情報。
 * @returns 実行結果の要約。
 */
export async function handleResult(args: FinalizeRequest): Promise<FinalizeOutcome> {
  const stdout = args.stdout ?? args.content;
  let filePath: string | undefined;
  let bytesWritten: number | undefined;
  let copied: boolean | undefined;

  if (args.output) {
    const { handler, params } = args.output;
    const deliveryHandler = handler ?? deliverOutput;
    const deliverResult = await deliveryHandler({
      ...params,
      content: params.content ?? args.content,
      configEnv: args.configEnv,
    });
    if (deliverResult.file) {
      filePath = deliverResult.file.absolutePath;
      bytesWritten = deliverResult.file.bytesWritten;
    }
    if (deliverResult.copied) {
      copied = true;
    }
  }

  if (args.history) {
    await args.history.run();
  }

  // TODO: finalize-action 実行ロジックを追加する（command/tool など）

  return {
    exitCode: args.exitCode ?? DEFAULT_EXIT_CODE,
    stdout,
    output:
      filePath || typeof bytesWritten === "number" || copied
        ? {
            filePath,
            bytesWritten,
            copied,
          }
        : undefined,
  };
}
