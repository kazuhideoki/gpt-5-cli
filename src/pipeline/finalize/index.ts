/**
 * finalize 層の公開エントリーポイント。
 */
export { finalizeResult } from "./finalize-result.js";
export { resolveResultOutput } from "./result-output.js";
export { handleResult } from "./handle-result.js";

export {
  DEFAULT_OUTPUT_DIR_ENV,
  deliverOutput,
  generateDefaultOutputPath,
} from "./io.js";
export { buildFileHistoryContext } from "./history-context.js";
export type { FileHistoryContext } from "./history-context.js";
export { createClipboardAction, createD2HtmlAction } from "./actions/builders.js";
export {
  executeFinalizeAction,
  FINALIZE_ACTION_LOG_LABEL,
} from "./actions/execute.js";
export type { FinalizeActionList } from "./types.js";
