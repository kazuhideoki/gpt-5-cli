/**
 * 環境変数関連の共通スキーマと定数を提供するモジュール。
 * Input/Process 層から参照される検証ロジックをここに集約する。
 */
import { z } from "zod";
import type { EffortLevel, VerbosityLevel } from "../types.js";

// NOTE(pipeline/input): 現状は Input 層が主用途だが、types で型共有しているため
// レイヤ規約上 foundation に配置している。将来的に型の依存方向を整理できれば
// input 配下へ移設する選択肢も検討する。
const effortValues: readonly EffortLevel[] = ["low", "medium", "high"];
const verbosityValues: readonly VerbosityLevel[] = ["low", "medium", "high"];

type EffortLevelValue = EffortLevel;
type VerbosityLevelValue = VerbosityLevel;

const effortMessage = 'OPENAI_DEFAULT_EFFORT must be one of "low", "medium", or "high".';
const verbosityMessage = 'OPENAI_DEFAULT_VERBOSITY must be one of "low", "medium", or "high".';

/** effort レベルを検証・正規化するスキーマ。 */
export const effortLevelSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .superRefine((value, ctx) => {
    if (!effortValues.includes(value as EffortLevelValue)) {
      ctx.addIssue({ code: "custom", message: `${effortMessage} Received: ${value}` });
    }
  })
  .transform((value) => value as EffortLevelValue);

/** verbosity レベルを検証・正規化するスキーマ。 */
export const verbosityLevelSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .superRefine((value, ctx) => {
    if (!verbosityValues.includes(value as VerbosityLevelValue)) {
      ctx.addIssue({ code: "custom", message: `${verbosityMessage} Received: ${value}` });
    }
  })
  .transform((value) => value as VerbosityLevelValue);

/** `.env` と環境変数から読み取る設定値を検証するスキーマ。 */
export const envConfigSchema = z
  .object({
    OPENAI_MODEL_MAIN: z.string().trim().min(1).optional(),
    OPENAI_MODEL_MINI: z.string().trim().min(1).optional(),
    OPENAI_MODEL_NANO: z.string().trim().min(1).optional(),
    OPENAI_DEFAULT_EFFORT: effortLevelSchema.optional(),
    OPENAI_DEFAULT_VERBOSITY: verbosityLevelSchema.optional(),
    GPT_5_CLI_PROMPTS_DIR: z.string().optional(),
    GPT_5_CLI_MAX_ITERATIONS: z
      .string()
      .transform((value) => value.trim())
      .pipe(
        z
          .string()
          .min(1)
          .transform((value) => Number.parseInt(value, 10))
          .superRefine((value, ctx) => {
            if (!Number.isInteger(value) || value <= 0) {
              ctx.addIssue({
                code: "custom",
                message: "GPT_5_CLI_MAX_ITERATIONS must be a positive integer when specified.",
              });
            }
          }),
      )
      .transform((value) => value as number)
      .optional(),
  })
  .passthrough();

export type EnvConfig = z.infer<typeof envConfigSchema>;
