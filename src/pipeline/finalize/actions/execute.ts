/**
 * @file finalize アクションを実行する共通ランタイム。
 */
import { spawn } from "node:child_process";
import { deliverOutput } from "../io.js";
import type { FinalizeAction } from "../types.js";
import type { ConfigEnvironment } from "../../../types.js";

export const FINALIZE_ACTION_LOG_LABEL = "[gpt-5-cli finalize]";

/**
 * finalize アクション実行時に渡されるコンテキスト。
 */
export interface ExecuteFinalizeActionContext {
  /** finalize 層が参照する環境スナップショット。 */
  configEnv: ConfigEnvironment;
  /** CLI から受け取った標準出力用コンテンツ。 */
  defaultContent: string;
}

/**
 * finalize アクションの実行結果。
 */
export interface ExecuteFinalizeActionResult {
  /** クリップボードコピーが発生した場合に true。 */
  copied: boolean;
}

/**
 * 単一の finalize アクションを実行する。
 */
export async function executeFinalizeAction(
  action: FinalizeAction,
  context: ExecuteFinalizeActionContext,
): Promise<ExecuteFinalizeActionResult> {
  console.error(
    `${FINALIZE_ACTION_LOG_LABEL} action start: ${action.flag} (priority=${action.priority})`,
  );

  try {
    switch (action.kind) {
      case "command":
        await runCommandAction(action);
        break;
      case "clipboard":
        await runClipboardAction(action, context);
        break;
      case "tool":
        // TODO(finalize/actions): implement tool action execution
        break;
      default: {
        const neverAction: never = action;
        throw new Error(`Error: unknown finalize action type: ${String(neverAction)}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${FINALIZE_ACTION_LOG_LABEL} action failure: ${action.flag} - ${message}`);
    throw error;
  }

  console.error(`${FINALIZE_ACTION_LOG_LABEL} action success: ${action.flag}`);
  return {
    copied: action.kind === "clipboard",
  };
}

async function runCommandAction(action: FinalizeAction & { kind: "command" }): Promise<void> {
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
        new Error(`Error: ${action.flag} のコマンドが終了コード ${code ?? -1} で終了しました`),
      );
    });
  });
}

async function runClipboardAction(
  action: FinalizeAction & { kind: "clipboard" },
  context: ExecuteFinalizeActionContext,
): Promise<void> {
  await deliverOutput({
    content: action.source.type === "content" ? action.source.value : context.defaultContent,
    cwd: action.workingDirectory,
    filePath: undefined,
    copy: true,
    copySource: action.source,
    configEnv: context.configEnv,
  });
}
