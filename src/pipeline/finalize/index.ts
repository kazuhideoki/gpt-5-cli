/**
 * finalize 層の公開エントリーポイント。
 */
export {
  handleResult,
  type FinalizeArgs,
  type FinalizeOutcome,
  type FinalizeHistoryContext,
  type FinalizeOutputParams,
  type FinalizeCopySource,
  type FinalizeExitCode,
  setDeliverOutputImplementation,
  resetDeliverOutputImplementation,
} from "./handle-result.js";

export {
  DEFAULT_OUTPUT_DIR_ENV,
  deliverOutput,
  generateDefaultOutputPath,
  type DefaultOutputPathParams,
  type DefaultOutputPathResult,
} from "./io.js";
