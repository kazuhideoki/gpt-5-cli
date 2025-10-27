/**
 * @file finalizeResult は CLI 各モードの終了処理を共通化する。
 * 呼び出し側で構築した履歴コンテキストを受け取り、出力・履歴更新をまとめて実行する。
 */
import type {
  ConfigEnvironment,
  ConversationContext,
  EffortLevel,
  VerbosityLevel,
} from "../../types.js";
import type { HistoryStore } from "../history/store.js";
import { handleResult } from "./handle-result.js";
import type {
  FinalizeDeliveryInstruction,
  FinalizeHistoryEffect,
  FinalizeOutcome,
} from "./types.js";

/**
 * 履歴へ保存する際に必要となるモデル情報のスナップショット。
 */
interface FinalizeResultMetadata {
  /** 実行に利用したモデル名。 */
  model: string;
  /** 実行時の reasoning effort レベル。 */
  effort: EffortLevel;
  /** 応答生成に使用した verbosity レベル。 */
  verbosity: VerbosityLevel;
}

/**
 * finalizeResult が履歴更新を行うためのオプション。
 */
export interface FinalizeResultHistoryOptions<TContext> {
  /** 更新対象となるレスポンス ID。 */
  responseId?: string;
  /** 履歴エントリを操作するストア。 */
  store: HistoryStore<TContext>;
  /** 現在の会話コンテキスト。 */
  conversation: ConversationContext;
  /** 履歴保存時に引き継ぐモデル関連メタデータ。 */
  metadata: FinalizeResultMetadata;
  /** 直前の履歴コンテキスト。 */
  previousContextRaw?: TContext;
  /** 保存する履歴コンテキスト本体。 */
  contextData: TContext;
}

/**
 * finalizeResult へ渡す CLI 固有の終了処理パラメータ。
 */
export interface FinalizeResultParams<TContext> {
  /** 応答テキスト本体。 */
  content: string;
  /** 今回のユーザー入力。 */
  userText: string;
  /** finalize 層が利用する ConfigEnv。 */
  configEnv: ConfigEnvironment;
  /** 標準出力へそのまま流したい補足テキスト。 */
  stdout?: string;
  /** ファイル保存先の相対または絶対パス。 */
  textOutputPath?: string;
  /** クリップボードへコピーするかどうか。 */
  copyOutput: boolean;
  /** コピー元をファイルへ切り替える場合のパス。 */
  copySourceFilePath?: string;
  /** 履歴更新を実施する場合の追加オプション。 */
  history?: FinalizeResultHistoryOptions<TContext>;
}

/**
 * CLI 固有のオプションを考慮して結果の保存・履歴更新を実行する。
 */
export async function finalizeResult<TContext>(
  params: FinalizeResultParams<TContext>,
): Promise<FinalizeOutcome> {
  const {
    content,
    stdout,
    textOutputPath,
    copyOutput,
    copySourceFilePath,
    history,
    userText,
    configEnv,
  } = params;

  const finalizeOutputInstruction: FinalizeDeliveryInstruction | undefined =
    textOutputPath || copyOutput
      ? ({
          params: {
            ...(textOutputPath ? { filePath: textOutputPath } : {}),
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
    configEnv,
    output: finalizeOutputInstruction,
    history: finalizeHistoryEffect,
  });
}
