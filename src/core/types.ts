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
import type { EasyInputMessage } from "openai/resources/responses/responses";
import type { HistoryEntry } from "./history.js";

/** ユーザー入力を解析して得たCLI実行時オプション。 */
export interface CliOptions {
  model: string;
  effort: EffortLevel;
  verbosity: VerbosityLevel;
  continueConversation: boolean;
  debug: boolean;
  taskMode: TaskMode;
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
