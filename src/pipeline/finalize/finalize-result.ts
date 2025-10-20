/**
 * @file finalizeResult は CLI 各モードの終了処理を共通化する。
 * 呼び出し側で構築した履歴コンテキストを受け取り、出力・履歴更新をまとめて実行する。
 */
import type { ConversationContext, EffortLevel, VerbosityLevel } from "../../types.js";
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

export interface FinalizeResultHistoryOptions<TContext> {
  responseId?: string;
  store: HistoryStore<TContext>;
  conversation: ConversationContext;
  metadata: FinalizeResultMetadata;
  previousContextRaw?: TContext;
  contextData: TContext;
}

export interface FinalizeResultParams<TContext> {
  content: string;
  userText: string;
  stdout?: string;
  summaryOutputPath?: string;
  copyOutput: boolean;
  copySourceFilePath?: string;
  history?: FinalizeResultHistoryOptions<TContext>;
}

/**
 * CLI 固有のオプションを考慮して結果の保存・履歴更新を実行する。
 *
 * @param params 終了処理に必要な情報。
 * @returns `handleResult` が返す実行結果。
 */
export async function finalizeResult<TContext>(
  params: FinalizeResultParams<TContext>,
): Promise<FinalizeOutcome> {
  const { content, stdout, summaryOutputPath, copyOutput, copySourceFilePath, history, userText } =
    params;

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
    const { responseId } = history;
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
          contextData: history.contextData,
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
