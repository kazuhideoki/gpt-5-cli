/**
 * @file 結果処理のエントリーポイント。CLI 各モードの finalize 処理を集約する。
 */
import type { EffortLevel, TaskMode, VerbosityLevel } from "../../types.js";
import type { HistoryStore } from "../history/store.js";
import { deliverOutput } from "./io.js";

type DeliverOutputFn = typeof deliverOutput;

let deliverOutputImpl: DeliverOutputFn = deliverOutput;

export function setDeliverOutputImplementation(fn: DeliverOutputFn): void {
  deliverOutputImpl = fn;
}

export function resetDeliverOutputImplementation(): void {
  deliverOutputImpl = deliverOutput;
}

export type FinalizeExitCode = 0 | 1;

export type FinalizeCopySource =
  | {
      type: "content";
      value: string;
    }
  | {
      type: "file";
      filePath: string;
    };

export interface FinalizeOutputParams {
  filePath?: string;
  copy?: boolean;
  copySource?: FinalizeCopySource;
  cwd?: string;
}

export interface FinalizeHistoryContext<TContext> {
  store: HistoryStore<TContext>;
  metadata: {
    model: string;
    effort: EffortLevel;
    verbosity: VerbosityLevel;
  };
  context: {
    isNewConversation: boolean;
    titleToUse: string;
    previousResponseId?: string;
    activeLastResponseId?: string;
    resumeSummaryText?: string;
    resumeSummaryCreatedAt?: string;
    previousContext?: TContext;
  };
  responseId?: string;
  userText: string;
  assistantText: string;
  contextData?: TContext;
}

export interface FinalizeArgs<TContext = unknown> {
  mode: TaskMode;
  content: string;
  stdout?: string;
  output?: FinalizeOutputParams;
  history?: FinalizeHistoryContext<TContext>;
}

export interface FinalizeOutcome {
  exitCode: FinalizeExitCode;
  stdout: string;
  output?: {
    filePath?: string;
    bytesWritten?: number;
    copied?: boolean;
  };
}

/**
 * CLI の結果をファイル出力・履歴更新・標準出力へ反映する。
 *
 * @param args 終了時処理に必要な情報。
 * @returns 実行結果の要約。
 */
export async function handleResult<TContext>(
  args: FinalizeArgs<TContext>,
): Promise<FinalizeOutcome> {
  const stdout = args.stdout ?? args.content;
  let filePath: string | undefined;
  let bytesWritten: number | undefined;
  let copied: boolean | undefined;

  if (args.output) {
    const deliverResult = await deliverOutputImpl({
      content: args.content,
      cwd: args.output.cwd,
      filePath: args.output.filePath,
      copy: args.output.copy,
      copySource: args.output.copySource,
    });
    if (deliverResult.file) {
      filePath = deliverResult.file.absolutePath;
      bytesWritten = deliverResult.file.bytesWritten;
    }
    if (deliverResult.copied) {
      copied = true;
    }
  }

  if (args.history?.responseId) {
    args.history.store.upsertConversation({
      metadata: args.history.metadata,
      context: args.history.context,
      responseId: args.history.responseId,
      userText: args.history.userText,
      assistantText: args.history.assistantText,
      contextData: args.history.contextData,
    });
  }

  return {
    exitCode: 0,
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
