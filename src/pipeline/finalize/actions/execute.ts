/**
 * @file finalize アクションを実行する共通ランタイム。
 */
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
    await runClipboardAction(action, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${FINALIZE_ACTION_LOG_LABEL} action failure: ${action.flag} - ${message}`);
    throw error;
  }

  console.error(`${FINALIZE_ACTION_LOG_LABEL} action success: ${action.flag}`);
  return { copied: true };
}

async function runClipboardAction(
  action: FinalizeAction,
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
