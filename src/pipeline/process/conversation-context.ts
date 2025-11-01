// conversation-context.ts: 履歴ストアを元に CLI 用会話コンテキストを構築するユーティリティ。
import type { HistoryEntry, HistoryStore } from "../history/store.js";
import type { CliLogger, CliLoggerConfig } from "../../foundation/logger/types.js";
import type { CliOptions, ConversationContext, OpenAIInputMessage } from "../../types.js";

/**
 * 履歴エントリに記録された値を CLI オプションへ転写する。
 */
function applyHistoryOverrides<TOptions extends CliOptions, THistoryTask>(
  options: TOptions,
  activeEntry: HistoryEntry<THistoryTask>,
): void {
  if (!options.continueConversation) {
    return;
  }

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

/**
 * 履歴エントリから再開に必要な情報を抽出する。
 */
function extractResumeState<THistoryTask>(activeEntry: HistoryEntry<THistoryTask>): {
  resumeMode: string;
  resumePrev: string | undefined;
  resumeSummaryText: string | undefined;
  resumeSummaryCreatedAt: string | undefined;
  resumeSummaryMessage: OpenAIInputMessage | undefined;
  previousTitle: string | undefined;
} {
  const resumeMode = activeEntry.resume?.mode ?? "";
  const resumePrev = activeEntry.resume?.previous_response_id ?? undefined;
  const resumeSummaryText = activeEntry.resume?.summary?.text ?? undefined;
  const resumeSummaryCreatedAt = activeEntry.resume?.summary?.created_at ?? undefined;
  const resumeSummaryMessage = resumeSummaryText
    ? {
        role: "system" as const,
        content: [{ type: "input_text" as const, text: resumeSummaryText }],
      }
    : undefined;

  return {
    resumeMode,
    resumePrev,
    resumeSummaryText,
    resumeSummaryCreatedAt,
    resumeSummaryMessage,
    previousTitle: activeEntry.title ?? undefined,
  };
}

/**
 * 履歴同期コールバックへ渡す情報セット。
 */
interface SynchronizeHistoryParams<TOptions extends CliOptions, THistoryTask = unknown> {
  /** 現在の CLI オプション。 */
  options: TOptions;
  /** 選択中の履歴エントリ。 */
  activeEntry: HistoryEntry<THistoryTask>;
  /** 警告や情報ログを書き出すロガー。 */
  logger: CliLogger;
}

/**
 * computeContext の挙動を調整する追加設定。
 */
export interface ComputeContextConfig<TOptions extends CliOptions, THistoryTask = unknown> {
  /** ログ出力に利用する CLI 固有ラベル。 */
  logLabel: string;
  /** 履歴オプションを更新するときに呼び出す同期ハンドラ。CLI によっては不要なため任意。 */
  synchronizeWithHistory?: (params: SynchronizeHistoryParams<TOptions, THistoryTask>) => void;
}

/**
 * computeContext へ渡す引数群。
 */
export interface ComputeContextParams<TOptions extends CliOptions, THistoryTask = unknown> {
  /** CLI オプション（履歴継承フラグを含む）。 */
  options: TOptions;
  /** 履歴の検索・選択に使用するストア。 */
  historyStore: HistoryStore<THistoryTask>;
  /** 今回ユーザーが送信するテキスト。 */
  inputText: string;
  /** resolveInputOrExecuteHistoryAction が履歴候補を返した場合のみ指定するため任意。 */
  initialActiveEntry?: HistoryEntry<THistoryTask>;
  /** 履歴再開時にレスポンス ID が明示された場合にのみ必要となるため任意。 */
  explicitPrevId?: string;
  /** 履歴再開時にタイトルが明示された場合にのみ必要となるため任意。 */
  explicitPrevTitle?: string;
  /** CLI 固有の挙動調整が不要な場合もあるため任意。 */
  config?: ComputeContextConfig<TOptions, THistoryTask>;
  /** CLI 層から注入されるロガー設定。 */
  loggerConfig: CliLoggerConfig;
}

/**
 * 履歴情報と入力テキストから会話コンテキストを構築し、履歴継続設定を調整する。
 *
 * @param params 会話構築に必要な情報セット。
 */
export function computeContext<TOptions extends CliOptions, THistoryTask = unknown>({
  options,
  historyStore,
  inputText,
  initialActiveEntry,
  explicitPrevId,
  explicitPrevTitle,
  config,
  loggerConfig,
}: ComputeContextParams<TOptions, THistoryTask>): ConversationContext {
  const { logger } = loggerConfig;

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
      logger.warn("継続できる履歴が見つかりません（新規開始）。");
    }
  }

  let resumeSummaryText: string | undefined;
  let resumeSummaryCreatedAt: string | undefined;
  let resumeMode = "";
  const resumeBaseMessages: OpenAIInputMessage[] = [];

  if (activeEntry) {
    applyHistoryOverrides(options, activeEntry);
    config?.synchronizeWithHistory?.({
      options,
      activeEntry,
      logger,
    });

    const {
      resumeMode: modeFromHistory,
      resumePrev,
      resumeSummaryText: summaryText,
      resumeSummaryCreatedAt: summaryCreatedAt,
      resumeSummaryMessage,
      previousTitle: resolvedTitle,
    } = extractResumeState(activeEntry);

    resumeMode = modeFromHistory;
    resumeSummaryText = summaryText;
    resumeSummaryCreatedAt = summaryCreatedAt;

    if (resumeSummaryMessage) {
      resumeBaseMessages.push(resumeSummaryMessage);
    }

    if (resumePrev) {
      previousResponseId = resumePrev;
    }

    if (!previousTitle && resolvedTitle) {
      previousTitle = resolvedTitle;
    }

    if (modeFromHistory === "new_request") {
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
