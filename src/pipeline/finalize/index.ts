/**
 * finalize 層の公開エントリーポイント。
 */
export { finalizeResult } from "./finalize-result.js";
export { resolveResultOutput } from "./result-output.js";
export type { FinalizeResultHistoryOptions, FinalizeResultParams } from "./finalize-result.js";
export { handleResult } from "./handle-result.js";
export type {
  FinalizeRequest,
  FinalizeOutcome,
  FinalizeDeliveryInstruction,
  FinalizeDeliveryHandler,
  FinalizeHistoryEffect,
  FinalizeCopySource,
  FinalizeExitCode,
  type FinalizeAction,
  type FinalizeActionList,
  type FinalizeCommandAction,
  type FinalizeToolAction,
} from "./types.js";

export {
  DEFAULT_OUTPUT_DIR_ENV,
  deliverOutput,
  generateDefaultOutputPath,
  type DefaultOutputPathParams,
  type DefaultOutputPathResult,
} from "./io.js";
export { buildFileHistoryContext } from "./history-context.js";
export type { FileHistoryContext } from "./history-context.js";
