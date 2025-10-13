import type { EasyInputMessage } from "openai/resources/responses/responses";
import type { HistoryEntry } from "../core/history.js";
import type { EffortLevel, TaskMode, VerbosityLevel } from "../core/types.js";
export type { CliDefaults, EffortLevel, TaskMode, VerbosityLevel } from "../core/types.js";

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
  taskModeExplicit: boolean;
  hasExplicitHistory: boolean;
  helpRequested: boolean;
}

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

/** OpenAI Responses API入力メッセージ型のエイリアス。 */
export type OpenAIInputMessage = EasyInputMessage;
