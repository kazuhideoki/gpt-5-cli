import type { EasyInputMessage } from "openai/resources/responses/responses";

/** OpenAI Reasoning APIへ渡す effort レベル。 */
export type EffortLevel = "low" | "medium" | "high";

/** アシスタント出力の詳細度レベル。 */
export type VerbosityLevel = "low" | "medium" | "high";

/** CLI が扱うタスクモード。 */
export type TaskMode = "ask" | "d2" | "mermaid" | "sql";

/** CLI が参照する共通既定値セット。 */
export interface CliDefaults {
  modelMain: string;
  modelMini: string;
  modelNano: string;
  effort: EffortLevel;
  verbosity: VerbosityLevel;
  historyIndexPath: string;
  promptsDir: string;
  maxIterations: number;
}

// 以降は CLI/Session 双方から参照される共通型
export interface HistoryTurn {
  role: string;
  text?: string;
  at?: string;
  response_id?: string;
  kind?: string;
}

export interface HistorySummary {
  text?: string;
  created_at?: string;
}

export interface HistoryResume {
  mode?: string;
  previous_response_id?: string;
  summary?: HistorySummary;
}

export interface HistoryEntry<TContext = unknown> {
  title?: string;
  model?: string;
  effort?: string;
  verbosity?: string;
  created_at?: string;
  updated_at?: string;
  first_response_id?: string;
  last_response_id?: string;
  request_count?: number;
  resume?: HistoryResume;
  turns?: HistoryTurn[];
  context?: TContext;
}

/**
 * CLI モード間で共有される解析済みフラグ値を表す。
 * いずれのフラグも CLI 入力に応じて任意で指定されるため、存在しない場合は
 * undefined で表現する必要があるプロパティのみ optional としている。
 */
export interface CommonCliOptions {
  model: string;
  effort: EffortLevel;
  verbosity: VerbosityLevel;
  continueConversation: boolean;
  debug: boolean;
  maxIterations: number;
  maxIterationsExplicit: boolean;
  responseOutputPath?: string;
  responseOutputExplicit: boolean;
  copyOutput: boolean;
  copyExplicit: boolean;
  resumeIndex?: number;
  resumeListOnly: boolean;
  deleteIndex?: number;
  showIndex?: number;
  imagePath?: string;
  operation: "ask" | "compact";
  compactIndex?: number;
  args: string[];
  modelExplicit: boolean;
  effortExplicit: boolean;
  verbosityExplicit: boolean;
  hasExplicitHistory: boolean;
  helpRequested: boolean;
}

/** ユーザー入力を解析して得たCLI実行時オプション。 */
export interface CliOptions extends CommonCliOptions {
  taskMode: TaskMode;
}

/** OpenAI Responses API入力メッセージ型のエイリアス。 */
export type OpenAIInputMessage = EasyInputMessage;

/** OpenAIリクエスト構築時に共有する文脈情報。 */
export interface ConversationContext {
  isNewConversation: boolean;
  previousResponseId?: string;
  previousTitle?: string;
  titleToUse: string;
  resumeBaseMessages: OpenAIInputMessage[];
  resumeSummaryText?: string;
  resumeSummaryCreatedAt?: string;
  activeEntry?: HistoryEntry;
  activeLastResponseId?: string;
}
