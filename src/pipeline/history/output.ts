/**
 * 履歴エントリを CLI 向け表示へ整形するユーティリティ。
 * TODO(pipeline/history): 将来的には純粋データを返し、表示は CLI 側で制御する。
 */
import type { HistoryEntry, HistoryStore } from "./store.js";

function extractOutputInfo(
  context: unknown,
): { relative?: string; absolute?: string; copy?: boolean } | undefined {
  if (!context || typeof context !== "object") {
    return undefined;
  }
  const relative =
    typeof (context as { relative_path?: unknown }).relative_path === "string"
      ? (context as { relative_path: string }).relative_path
      : undefined;
  const absolute =
    typeof (context as { absolute_path?: unknown }).absolute_path === "string"
      ? (context as { absolute_path: string }).absolute_path
      : undefined;
  const copyRaw = (context as { copy?: unknown }).copy;
  const copy = typeof copyRaw === "boolean" ? copyRaw : undefined;
  if (!relative && !absolute && !copy) {
    return undefined;
  }
  return { relative, absolute, copy };
}

/**
 * 履歴一覧を標準出力へ描画する。
 *
 * @param store 履歴ストア。
 */
export function printHistoryList<TContext>(store: HistoryStore<TContext>): void {
  const entries = store.getFilteredEntries();
  if (entries.length === 0) {
    console.log("(履歴なし)");
    return;
  }

  console.log("=== 履歴一覧（新しい順） ===");
  entries.forEach((entry, index) => {
    const model = entry.model ?? "(model 未設定)";
    const effort = entry.effort ?? "(effort 未設定)";
    const verbosity = entry.verbosity ?? "(verbosity 未設定)";
    const requestCount = entry.request_count ?? 0;
    const updated = entry.updated_at ?? "(更新日時 未設定)";
    const title = entry.title ?? "(タイトル未設定)";
    let line = `${String(index + 1).padStart(2, " ")}) ${title} [${model}/${effort}/${verbosity} ${requestCount}回] ${updated}`;
    const outputInfo = extractOutputInfo(entry.context);
    if (outputInfo) {
      const parts: string[] = [];
      if (outputInfo.relative) {
        parts.push(`relative=${outputInfo.relative}`);
      }
      if (outputInfo.absolute) {
        parts.push(`absolute=${outputInfo.absolute}`);
      }
      if (outputInfo.copy) {
        parts.push("copy");
      }
      if (parts.length > 0) {
        line = `${line} paths[${parts.join(", ")}]`;
      }
    }
    console.log(line);
  });
}

function printOutputInfo(entry: HistoryEntry<unknown>): void {
  const outputInfo = extractOutputInfo(entry.context);
  if (!outputInfo) {
    return;
  }
  const parts: string[] = [];
  if (outputInfo.relative) {
    parts.push(`relative=${outputInfo.relative}`);
  }
  if (outputInfo.absolute) {
    parts.push(`absolute=${outputInfo.absolute}`);
  }
  if (outputInfo.copy) {
    parts.push("copy");
  }
  if (parts.length > 0) {
    console.log(`出力: ${parts.join(", ")}`);
    console.log("");
  }
}

function pickPrintableTurns(entry: HistoryEntry<unknown>) {
  const turns = entry.turns ?? [];
  return turns.filter((turn) => {
    if (turn.role === "user" || turn.role === "assistant") return true;
    if (turn.role === "system" && turn.kind === "summary") return true;
    return false;
  });
}

/**
 * 指定番号の履歴詳細を標準出力へ描画する。
 *
 * @param store 履歴ストア。
 * @param index 1 始まりの履歴番号。
 * @param noColor カラー出力を禁止するフラグ。
 */
export function printHistoryDetail<TContext>(
  store: HistoryStore<TContext>,
  index: number,
  noColor: boolean,
): void {
  const entries = store.getFilteredEntries();
  if (!Number.isInteger(index) || index < 1 || index > entries.length) {
    throw new Error(`[gpt-5-cli] 無効な履歴番号です（1〜${entries.length}）。: ${index}`);
  }
  const entry = entries[index - 1];
  const title = entry.title ?? "(タイトル未設定)";
  const updated = entry.updated_at ?? "(更新日時 未設定)";
  const requestCount = entry.request_count ?? 0;
  console.log(`=== 履歴 #${index}: ${title} (更新: ${updated}, リクエスト:${requestCount}回) ===`);

  printOutputInfo(entry);

  const printable = pickPrintableTurns(entry);
  if (printable.length === 0) {
    console.log("(この履歴には保存された対話メッセージがありません)");
    return;
  }

  const useColor = !noColor && Boolean(process.stdout.isTTY);
  const colors = {
    user: useColor ? "\u001b[36m" : "",
    assistant: useColor ? "\u001b[34m" : "",
    summary: useColor ? "\u001b[33m" : "",
    reset: useColor ? "\u001b[0m" : "",
  };

  printable.forEach((turn) => {
    let label = `${turn.role}:`;
    if (turn.role === "user") {
      label = `${colors.user}user:${colors.reset}`;
    } else if (turn.role === "assistant") {
      label = `${colors.assistant}assistant:${colors.reset}`;
    } else if (turn.role === "system" && turn.kind === "summary") {
      label = `${colors.summary}summary:${colors.reset}`;
    }
    console.log(label);
    console.log(turn.text ?? "");
    console.log("");
  });
}
