/** OpenAI Reasoning APIへ渡す effort レベル。 */
export type EffortLevel = "low" | "medium" | "high";

/** アシスタント出力の詳細度レベル。 */
export type VerbosityLevel = "low" | "medium" | "high";

/** CLI が扱うタスクモード。 */
export type TaskMode = "default" | "d2" | "sql";

/** CLI が参照する共通既定値セット。 */
export interface CliDefaults {
  modelMain: string;
  modelMini: string;
  modelNano: string;
  effort: EffortLevel;
  verbosity: VerbosityLevel;
  historyIndexPath: string;
  promptsDir: string;
  d2MaxIterations: number;
  sqlMaxIterations: number;
}
