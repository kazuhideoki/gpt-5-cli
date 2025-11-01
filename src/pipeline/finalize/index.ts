/**
 * finalize 層の公開エントリーポイント。
 */
export { finalizeResult } from "./finalize-result.js";
export { resolveResultOutput } from "./result-output.js";
export { generateDefaultOutputPath } from "./io.js";
export { buildFileHistoryContext } from "./history-context.js";
export type { FileHistoryContext } from "./history-context.js";
export { createClipboardAction, createD2HtmlAction } from "./actions/builders.js";
export type { FinalizeActionList } from "./types.js";
