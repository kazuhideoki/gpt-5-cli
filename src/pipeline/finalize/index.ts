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
  FinalizeAction,
  FinalizeActionList,
  FinalizeCommandAction,
  FinalizeClipboardAction,
} from "./types.js";

export {
  DEFAULT_OUTPUT_DIR_ENV,
  deliverOutput,
  generateDefaultOutputPath,
} from "./io.js";
export type { DefaultOutputPathParams, DefaultOutputPathResult } from "./io.js";
export { buildFileHistoryContext } from "./history-context.js";
export type { FileHistoryContext } from "./history-context.js";
export { createClipboardAction } from "./actions/builders.js";
export {
  executeFinalizeAction,
  FINALIZE_ACTION_LOG_LABEL,
  type ExecuteFinalizeActionContext,
  type ExecuteFinalizeActionResult,
} from "./actions/execute.js";
