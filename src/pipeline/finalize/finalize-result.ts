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
import type { CliLogger } from "../../foundation/logger/types.js";
import type { HistoryStore } from "../history/store.js";
import { handleResult } from "./handle-result.js";
import type {
  FinalizeDeliveryInstruction,
  FinalizeHistoryEffect,
  FinalizeOutcome,
  FinalizeActionList,
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
 * 省略可能な値は `undefined` を用いて表現する。
 */
interface FinalizeResultHistoryOptions<TContext> {
  /** 更新対象となるレスポンス ID。 */
  responseId: string | undefined;
  /** 履歴エントリを操作するストア。 */
  store: HistoryStore<TContext>;
  /** 現在の会話コンテキスト。 */
  conversation: ConversationContext;
  /** 履歴保存時に引き継ぐモデル関連メタデータ。 */
  metadata: FinalizeResultMetadata;
  /** 直前の履歴コンテキスト。 */
  previousContextRaw: TContext | undefined;
  /** 保存する履歴コンテキスト本体。 */
  contextData: TContext;
}

/**
 * finalizeResult へ渡す CLI 固有の終了処理パラメータ。
 * 任意入力は `undefined` を指定して不使用を示す。
 */
interface FinalizeResultParams<TContext> {
  /** 応答テキスト本体。 */
  content: string;
  /** finalize 層で利用する CLI ロガー。 */
  logger: CliLogger;
  /** 今回のユーザー入力。 */
  userText: string;
  /** CLI 固有で事前定義された終了後アクション。 */
  actions: FinalizeActionList;
  /** finalize 層が利用する ConfigEnv。 */
  configEnv: ConfigEnvironment;
  /** 標準出力へそのまま流したい補足テキスト。 */
  stdout: string | undefined;
  /** ファイル保存先の相対または絶対パス。 */
  textOutputPath: string | undefined;
  /** 履歴更新を実施する場合の追加オプション。 */
  history: FinalizeResultHistoryOptions<TContext> | undefined;
}

/**
 * CLI 固有のオプションを考慮して結果の保存・履歴更新を実行する。
 */
export async function finalizeResult<TContext>(
  params: FinalizeResultParams<TContext>,
): Promise<FinalizeOutcome> {
  const { content, actions, stdout, textOutputPath, history, userText, configEnv, logger } = params;

  const finalizeOutputInstruction: FinalizeDeliveryInstruction | undefined = textOutputPath
    ? ({
        params: {
          configEnv,
          content: undefined,
          cwd: undefined,
          filePath: textOutputPath,
          copy: undefined,
          copySource: undefined,
        },
        handler: undefined,
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
    logger,
    output: finalizeOutputInstruction,
    actions,
    history: finalizeHistoryEffect,
    exitCode: undefined,
  });
}
