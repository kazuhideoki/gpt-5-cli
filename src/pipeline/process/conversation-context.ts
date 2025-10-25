// conversation-context.ts: 履歴ストアを元に CLI 用会話コンテキストを構築するユーティリティ。
import type { HistoryEntry, HistoryStore } from "../history/store.js";
import type { CliOptions, ConversationContext, OpenAIInputMessage } from "../../types.js";

/**
 * 履歴同期コールバックへ渡す情報セット。
 */
interface SynchronizeHistoryParams<TOptions extends CliOptions, THistoryTask = unknown> {
  /** 現在の CLI オプション。 */
  options: TOptions;
  /** 選択中の履歴エントリ。 */
  activeEntry: HistoryEntry<THistoryTask>;
  /** 警告ログを出力する関数。 */
  logWarning: (message: string) => void;
}

/**
 * computeContext の挙動を調整する追加設定。
 */
export interface ComputeContextConfig<TOptions extends CliOptions, THistoryTask = unknown> {
  /** ログ出力に利用する CLI 固有ラベル。 */
  logLabel: string;
  /** 履歴オプションを更新するときに呼び出す同期ハンドラ。 */
  synchronizeWithHistory?: (params: SynchronizeHistoryParams<TOptions, THistoryTask>) => void;
}

/**
 * 履歴情報と入力テキストから会話コンテキストを構築し、履歴継続設定を調整する。
 *
 * @param options CLI オプション（履歴継承フラグを含む）。
 * @param historyStore 履歴の検索・選択に使用するストア。
 * @param inputText 今回ユーザーが送信するテキスト。
 * @param initialActiveEntry `determineInput` が返した履歴エントリ候補。
 * @param explicitPrevId 履歴再開時に明示されたレスポンス ID。
 * @param explicitPrevTitle 履歴再開時に明示されたタイトル。
 */
export function computeContext<TOptions extends CliOptions, THistoryTask = unknown>(
  options: TOptions,
  historyStore: HistoryStore<THistoryTask>,
  inputText: string,
  initialActiveEntry?: HistoryEntry<THistoryTask>,
  explicitPrevId?: string,
  explicitPrevTitle?: string,
  config?: ComputeContextConfig<TOptions, THistoryTask>,
): ConversationContext {
  const logLabel = config?.logLabel ?? "[gpt-5-cli]";
  const logWarning = (message: string): void => {
    console.error(`${logLabel} ${message}`);
  };

  let activeEntry = initialActiveEntry;
  let previousResponseId = explicitPrevId;
  let previousTitle = explicitPrevTitle;

  if (!options.hasExplicitHistory && options.continueConversation) {
    const latest = historyStore.findLatest();
    if (latest) {
      activeEntry = latest;
      previousResponseId = latest.last_response_id ?? previousResponseId;
      previousTitle = latest.title ?? previousTitle;
    } else {
      logWarning("warn: 継続できる履歴が見つかりません（新規開始）。");
    }
  }

  let resumeSummaryText: string | undefined;
  let resumeSummaryCreatedAt: string | undefined;
  let resumeMode = "";
  let resumePrev = "";
  const resumeBaseMessages: OpenAIInputMessage[] = [];

  if (activeEntry) {
    if (options.continueConversation) {
      if (!options.modelExplicit && typeof activeEntry.model === "string" && activeEntry.model) {
        options.model = activeEntry.model;
      }
      if (!options.effortExplicit && typeof activeEntry.effort === "string" && activeEntry.effort) {
        const lower = String(activeEntry.effort).toLowerCase();
        if (lower === "low" || lower === "medium" || lower === "high") {
          options.effort = lower as CliOptions["effort"];
        }
      }
      if (
        !options.verbosityExplicit &&
        typeof activeEntry.verbosity === "string" &&
        activeEntry.verbosity
      ) {
        const lower = String(activeEntry.verbosity).toLowerCase();
        if (lower === "low" || lower === "medium" || lower === "high") {
          options.verbosity = lower as CliOptions["verbosity"];
        }
      }
    }

    config?.synchronizeWithHistory?.({
      options,
      activeEntry,
      logWarning,
    });

    resumeMode = activeEntry.resume?.mode ?? "";
    resumePrev = activeEntry.resume?.previous_response_id ?? "";
    resumeSummaryText = activeEntry.resume?.summary?.text ?? undefined;
    resumeSummaryCreatedAt = activeEntry.resume?.summary?.created_at ?? undefined;

    if (resumeSummaryText) {
      resumeBaseMessages.push({
        role: "system",
        content: [{ type: "input_text", text: resumeSummaryText }],
      });
    }

    if (resumePrev) {
      previousResponseId = resumePrev;
    }

    if (!previousTitle && activeEntry.title) {
      previousTitle = activeEntry.title;
    }

    if (resumeMode === "new_request") {
      previousResponseId = undefined;
    }
  }

  let isNewConversation = true;
  if (options.continueConversation) {
    if (previousResponseId) {
      isNewConversation = false;
    } else if (activeEntry && resumeMode === "new_request") {
      isNewConversation = false;
    }
  }

  const titleCandidate = inputText.replace(/\s+/g, " ").slice(0, 50);
  let titleToUse = titleCandidate;
  if (isNewConversation) {
    if (options.continueConversation && previousTitle) {
      titleToUse = previousTitle;
    }
  } else {
    titleToUse = previousTitle ?? "";
  }

  return {
    isNewConversation,
    previousResponseId,
    previousTitle,
    titleToUse,
    resumeBaseMessages,
    resumeSummaryText,
    resumeSummaryCreatedAt,
    activeEntry,
    activeLastResponseId: activeEntry?.last_response_id ?? undefined,
  };
}
