import type { EasyInputMessage } from "openai/resources/responses/responses";
import type { ConfigEnvKey, ConfigEnvSnapshot } from "./pipeline/input/config-env.js";

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

/**
 * `.env` 読み込み後の設定値へ不変アクセスするための契約。
 */
export interface ConfigEnvironment {
  /**
   * 指定した環境キーに紐づく値を取得する。
   *
   * @param key 参照対象の環境変数名。ConfigEnv が認識しているキーのみ指定できる。
   * @returns キーが存在する場合は値、存在しない場合は undefined。
   */
  get<TKey extends ConfigEnvKey>(key: TKey): ConfigEnvSnapshot[TKey];

  /**
   * 指定した環境キーが保持されているか判定する。
   *
   * @param key 存在確認を行う環境変数名。ConfigEnv が認識しているキーのみ指定できる。
   * @returns キーが存在する場合は true、それ以外は false。
   */
  has(key: ConfigEnvKey): boolean;

  /**
   * 保持している全てのキーと値を列挙する。
   *
   * @returns イテレータで表現したキーと値のペア。値は読み取り専用として扱う。
   */
  entries(): IterableIterator<readonly [key: ConfigEnvKey, value: string]>;
}

// 以降は CLI/Session 双方から参照される共通型
export interface HistoryTurn {
  role: string;
  text?: string;
  at?: string;
  response_id?: string;
  kind?: string;
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
  resume?: {
    mode?: string;
    previous_response_id?: string;
    summary?: {
      text?: string;
      created_at?: string;
    };
  };
  turns?: HistoryTurn[];
  context?: TContext;
}

/**
 * CLI モード間で共有される解析済みフラグ値を表す。
 * すべてのプロパティを必須化し、値が存在しない場合は undefined を明示的に保持する。
 */
export interface CommonCliOptions {
  model: string;
  effort: EffortLevel;
  verbosity: VerbosityLevel;
  continueConversation: boolean;
  debug: boolean;
  maxIterations: number;
  maxIterationsExplicit: boolean;
  responseOutputPath: string | undefined;
  responseOutputExplicit: boolean;
  copyOutput: boolean;
  copyExplicit: boolean;
  resumeIndex: number | undefined;
  resumeListOnly: boolean;
  deleteIndex: number | undefined;
  showIndex: number | undefined;
  imagePath: string | undefined;
  operation: "ask" | "compact";
  compactIndex: number | undefined;
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

/** Agents SDK での会話実行結果を CLI 層へ受け渡すための契約。 */
export interface AgentConversationOutcome {
  /**
   * エージェントが生成したテキスト出力。途中終了時は未完成の可能性がある。
   */
  assistantText: string;
  /**
   * Responses API が返した最後のレスポンス ID。未取得の場合は undefined。
   */
  responseId: string | undefined;
  /**
   * 最大イテレーションに到達して途中結果を返している場合は true。
   */
  reachedMaxIterations: boolean;
}
