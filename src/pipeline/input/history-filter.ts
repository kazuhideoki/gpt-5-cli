// history-filter.ts: CLI 用履歴ストアから特定モードの履歴だけを抽出するユーティリティ。
import type { HistoryEntry } from "../../core/history.js";

export function createCliHistoryEntryFilter(
  cliName: string,
): <TContext>(entry: HistoryEntry<TContext>) => boolean {
  return (entry) => {
    const context = entry.context;
    if (!context || typeof context !== "object") {
      return true;
    }
    const rawCli = (context as { cli?: unknown }).cli;
    if (typeof rawCli !== "string") {
      return true;
    }
    return rawCli === cliName;
  };
}
