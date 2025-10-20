/**
 * 履歴ターンを要約用のテキストへ整形するヘルパー。
 */
import type { HistoryTurn } from "../../types.js";

export function formatTurnsForSummary(turns: HistoryTurn[]): string {
  return turns
    .map((turn) => {
      let speaker = turn.role ?? "";
      if (turn.role === "user") {
        speaker = "ユーザー";
      } else if (turn.role === "assistant") {
        speaker = "アシスタント";
      } else if (turn.role === "system" && turn.kind === "summary") {
        speaker = "システム要約";
      }
      return `${speaker}:\n${turn.text ?? ""}`;
    })
    .join("\n\n---\n\n");
}
