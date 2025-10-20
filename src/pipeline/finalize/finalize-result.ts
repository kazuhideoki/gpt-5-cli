/**
 * @file finalize 層で CLI 共通の終了処理をまとめるユーティリティ。
 */
import type { ConversationContext, EffortLevel, VerbosityLevel, TaskMode } from "../../types.js";
import type { HistoryStore } from "../history/store.js";
import { handleResult } from "./handle-result.js";
import type {
  FinalizeDeliveryInstruction,
  FinalizeHistoryEffect,
  FinalizeOutcome,
} from "./types.js";

interface FinalizeResultMetadata {
  model: string;
  effort: EffortLevel;
  verbosity: VerbosityLevel;
}

interface FinalizeHistoryContextBase {
  cli: TaskMode;
  file_path?: string;
  output?: {
    file?: string;
    copy?: boolean;
  };
  [key: string]: unknown;
}

interface FinalizeResultHistoryOptions<TContext extends FinalizeHistoryContextBase, TStoreContext> {
  responseId?: string;
  store: HistoryStore<TStoreContext>;
  conversation: ConversationContext;
  metadata: FinalizeResultMetadata;
  previousContextRaw?: TStoreContext;
  previousContext?: TContext;
  baseContext: TContext;
  contextPath?: string;
}

interface FinalizeResultParams<TContext extends FinalizeHistoryContextBase, TStoreContext> {
  content: string;
  userText: string;
  stdout?: string;
  summaryOutputPath?: string;
  copyOutput: boolean;
  defaultOutputFilePath?: string;
  copySourceFilePath?: string;
  history?: FinalizeResultHistoryOptions<TContext, TStoreContext>;
}

/**
 * CLI 固有のオプションを考慮して結果の保存・履歴更新を実行する。
 *
 * @param params 終了処理に必要な情報。
 * @returns `handleResult` が返す実行結果。
 */
export async function finalizeResult<
  TContext extends FinalizeHistoryContextBase,
  TStoreContext = TContext,
>(params: FinalizeResultParams<TContext, TStoreContext>): Promise<FinalizeOutcome> {
  const {
    content,
    stdout,
    summaryOutputPath,
    copyOutput,
    defaultOutputFilePath,
    copySourceFilePath,
    history,
    userText,
  } = params;

  const finalizeOutputInstruction: FinalizeDeliveryInstruction | undefined =
    summaryOutputPath || copyOutput
      ? ({
          params: {
            ...(summaryOutputPath ? { filePath: summaryOutputPath } : {}),
            ...(copyOutput
              ? {
                  copy: true,
                  ...(copySourceFilePath
                    ? {
                        copySource: {
                          type: "file" as const,
                          filePath: copySourceFilePath,
                        },
                      }
                    : {}),
                }
              : {}),
          },
        } satisfies FinalizeDeliveryInstruction)
      : undefined;

  let finalizeHistoryEffect: FinalizeHistoryEffect | undefined;
  if (history?.responseId) {
    const responseId = history.responseId;
    const previousContext = history.previousContext;
    const historyContext: TContext = {
      ...history.baseContext,
    };
    const contextPath = history.contextPath;
    const fallbackPath = defaultOutputFilePath ?? previousContext?.file_path;
    if (contextPath) {
      historyContext.file_path = contextPath;
    } else if (fallbackPath) {
      historyContext.file_path = fallbackPath;
    }
    const historyOutputFile = summaryOutputPath ?? defaultOutputFilePath;
    if (historyOutputFile || copyOutput) {
      historyContext.output = {
        file: historyOutputFile,
        ...(copyOutput ? { copy: true } : {}),
      };
    }
    finalizeHistoryEffect = {
      run: () =>
        history.store.upsertConversation({
          metadata: history.metadata,
          context: {
            isNewConversation: history.conversation.isNewConversation,
            titleToUse: history.conversation.titleToUse,
            previousResponseId: history.conversation.previousResponseId,
            activeLastResponseId: history.conversation.activeLastResponseId,
            resumeSummaryText: history.conversation.resumeSummaryText,
            resumeSummaryCreatedAt: history.conversation.resumeSummaryCreatedAt,
            previousContext: history.previousContextRaw,
          },
          responseId,
          userText,
          assistantText: content,
          contextData: historyContext as unknown as TStoreContext,
        }),
    };
  }

  return handleResult({
    content,
    stdout,
    output: finalizeOutputInstruction,
    history: finalizeHistoryEffect,
  });
}
