/**
 * finalize 層の公開エントリーポイント。
 */
export { handleResult } from "./handle-result.js";
export type {
  FinalizeRequest,
  FinalizeOutcome,
  FinalizeDeliveryInstruction,
  FinalizeDeliveryHandler,
  FinalizeHistoryEffect,
  FinalizeCopySource,
  FinalizeExitCode,
} from "./types.js";

export {
  DEFAULT_OUTPUT_DIR_ENV,
  deliverOutput,
  generateDefaultOutputPath,
  type DefaultOutputPathParams,
  type DefaultOutputPathResult,
} from "./io.js";
