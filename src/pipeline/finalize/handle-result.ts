/**
 * @file finalize 層のエントリーポイント。CLI の結果処理を集約する。
 */

import { executeFinalizeAction } from "./actions/execute.js";
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

  if (args.actions.length > 0) {
    const sortedActions = args.actions
      .map((action, index) => ({ action, index }))
      .sort((left, right) => {
        const priorityDiff = left.action.priority - right.action.priority;
        if (priorityDiff !== 0) {
          return priorityDiff;
        }
        return left.index - right.index;
      })
      .map((entry) => entry.action);

    for (const action of sortedActions) {
      const result = await executeFinalizeAction(action, {
        configEnv: args.configEnv,
        defaultContent: args.content,
      });
      if (result.copied) {
        copied = true;
      }
    }
  }

  if (args.history) {
    await args.history.run();
  }

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
