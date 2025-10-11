import type { EasyInputMessage } from "openai/resources/responses/responses";
import type { HistoryEntry } from "./history.js";

export type EffortLevel = "low" | "medium" | "high";
export type VerbosityLevel = "low" | "medium" | "high";
export type TaskMode = "default" | "d2";

export interface CliDefaults {
  modelMain: string;
  modelMini: string;
  modelNano: string;
  effort: EffortLevel;
  verbosity: VerbosityLevel;
  historyIndexPath: string;
  promptsDir: string;
}

export interface CliOptions {
  model: string;
  effort: EffortLevel;
  verbosity: VerbosityLevel;
  continueConversation: boolean;
  taskMode: TaskMode;
  resumeIndex?: number;
  resumeListOnly: boolean;
  deleteIndex?: number;
  showIndex?: number;
  imagePath?: string;
  operation: "ask" | "compact";
  compactIndex?: number;
  d2FilePath?: string;
  args: string[];
  modelExplicit: boolean;
  effortExplicit: boolean;
  verbosityExplicit: boolean;
  taskModeExplicit: boolean;
  d2FileExplicit: boolean;
  hasExplicitHistory: boolean;
  helpRequested: boolean;
}

export interface ActiveHistory {
  entry?: HistoryEntry;
  lastResponseId?: string;
}

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

export interface RequestResources {
  systemPrompt?: string;
  imageDataUrl?: string;
}

export type OpenAIInputMessage = EasyInputMessage;
