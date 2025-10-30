/**
 * @file finalize 層のエントリーポイント。CLI の結果処理を集約する。
 */

import { spawn } from "node:child_process";
import { deliverOutput } from "./io.js";
import type { FinalizeOutcome, FinalizeRequest } from "./types.js";

const DEFAULT_EXIT_CODE = 0;
const FINALIZE_LOG_LABEL = "[gpt-5-cli finalize]";

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
      console.error(
        `${FINALIZE_LOG_LABEL} action start: ${action.flag} (priority=${action.priority})`,
      );
      try {
        if (action.kind === "command") {
          if (action.arguments.length === 0) {
            throw new Error(`Error: ${action.flag} で実行するコマンドが設定されていません`);
          }
          const [command, ...commandArgs] = action.arguments;
          await new Promise<void>((resolve, reject) => {
            const child = spawn(command, commandArgs, {
              cwd: action.workingDirectory,
              stdio: "inherit",
            });
            child.once("error", (error) => {
              reject(
                new Error(
                  `Error: ${action.flag} のコマンド実行に失敗しました: ${(error as Error).message}`,
                ),
              );
            });
            child.once("close", (code) => {
              if ((code ?? 1) === 0) {
                resolve();
                return;
              }
              reject(
                new Error(
                  `Error: ${action.flag} のコマンドが終了コード ${code ?? -1} で終了しました`,
                ),
              );
            });
          });
        } else if (action.kind === "clipboard") {
          const result = await deliverOutput({
            content: action.source.type === "content" ? action.source.value : args.content,
            cwd: action.workingDirectory,
            filePath: undefined,
            copy: true,
            copySource: action.source,
            configEnv: args.configEnv,
          });
          if (result.copied) {
            copied = true;
          }
        } else {
          // TODO: finalize-action tool 実行を実装する
        }
        console.error(`${FINALIZE_LOG_LABEL} action success: ${action.flag}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`${FINALIZE_LOG_LABEL} action failure: ${action.flag} - ${message}`);
        throw error;
      }
    }
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
