/**
 * @file finalize アクションを実行する共通ランタイム。
 */
import { spawn } from "node:child_process";
import { deliverOutput } from "../io.js";
import type { FinalizeAction, FinalizeClipboardAction, FinalizeD2HtmlAction } from "../types.js";
import type { ConfigEnvironment } from "../../../types.js";
import type { CliLogger } from "../../../foundation/logger/types.js";

export const FINALIZE_ACTION_LOG_LABEL = "[gpt-5-cli finalize]";

/**
 * finalize アクション実行時に渡されるコンテキスト。
 */
interface ExecuteFinalizeActionContext {
  /** finalize 層で使用する CLI ロガー。 */
  logger: CliLogger;
  /** finalize 層が参照する環境スナップショット。 */
  configEnv: ConfigEnvironment;
  /** CLI から受け取った標準出力用コンテンツ。 */
  defaultContent: string;
}

/**
 * finalize アクションの実行結果。
 */
interface ExecuteFinalizeActionResult {
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
  const label = buildActionLabel(action);
  context.logger.debug(
    `${FINALIZE_ACTION_LOG_LABEL} action start: ${label} (priority=${action.priority})`,
  );

  let copied = false;
  try {
    if (action.kind === "clipboard") {
      await runClipboardAction(action, context);
      copied = true;
    } else if (action.kind === "d2-html") {
      await runD2HtmlAction(action);
    } else {
      assertNever(action);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.logger.error(`${FINALIZE_ACTION_LOG_LABEL} action failure: ${label} - ${message}`);
    throw error;
  }

  context.logger.debug(`${FINALIZE_ACTION_LOG_LABEL} action success: ${label}`);
  return { copied };
}

function buildActionLabel(action: FinalizeAction): string {
  if (action.kind === "clipboard") {
    return action.flag;
  }
  if (action.kind === "d2-html") {
    return "--open-html";
  }
  return assertNever(action);
}

async function runClipboardAction(
  action: FinalizeClipboardAction,
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

async function runD2HtmlAction(action: FinalizeD2HtmlAction): Promise<void> {
  await runChildProcess("d2", ["--layout=elk", action.sourcePath, action.htmlOutputPath], {
    cwd: action.workingDirectory,
  });
  if (action.openHtml) {
    const opener = resolveHtmlOpener(action.htmlOutputPath);
    await runChildProcess(opener.command, opener.args, { cwd: action.workingDirectory });
  }
}

function resolveHtmlOpener(htmlPath: string): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    return { command: "open", args: [htmlPath] };
  }
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", htmlPath] };
  }
  return { command: "xdg-open", args: [htmlPath] };
}

async function runChildProcess(
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: "inherit" });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if ((code ?? 1) === 0) {
        resolve();
      } else {
        reject(new Error(`command exited with non-zero code (${code ?? -1})`));
      }
    });
  });
}

function assertNever(_value: never): never {
  throw new Error("Unsupported finalize action");
}
