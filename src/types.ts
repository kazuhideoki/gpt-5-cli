export type EffortLevel = "low" | "medium" | "high";
export type VerbosityLevel = "low" | "medium" | "high";

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

export interface HistoryEntry {
  title?: string;
  model?: string;
  effort?: EffortLevel | string;
  verbosity?: VerbosityLevel | string;
  created_at?: string;
  updated_at?: string;
  first_response_id?: string;
  last_response_id?: string;
  request_count?: number;
  resume?: HistoryResume;
  turns?: HistoryTurn[];
}

export interface CliDefaults {
  modelMain: string;
  modelMini: string;
  modelNano: string;
  effort: EffortLevel;
  verbosity: VerbosityLevel;
  historyIndexPath: string;
  systemPromptPath: string;
}

export interface CliOptions {
  model: string;
  effort: EffortLevel;
  verbosity: VerbosityLevel;
  continueConversation: boolean;
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

export interface OpenAIInputMessage {
  role: string;
  content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }>;
}
