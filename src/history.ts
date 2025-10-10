import fs from "node:fs";
import path from "node:path";
import type { HistoryEntry, HistoryTurn } from "./types.js";

export class HistoryStore {
  constructor(private readonly filePath: string) {}

  ensureInitialized(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "[]\n", "utf8");
    }
  }

  loadEntries(): HistoryEntry[] {
    this.ensureInitialized();
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed as HistoryEntry[];
      }
    } catch (error) {
      console.error(`[openai_api] failed to parse history index: ${String(error)}`);
    }
    return [];
  }

  saveEntries(entries: HistoryEntry[]): void {
    this.ensureInitialized();
    const json = JSON.stringify(entries, null, 2);
    fs.writeFileSync(this.filePath, `${json}\n`, "utf8");
  }

  private sortByUpdated(entries: HistoryEntry[]): HistoryEntry[] {
    return [...entries].sort((a, b) => {
      const left = a.updated_at ?? "";
      const right = b.updated_at ?? "";
      if (left === right) return 0;
      return right.localeCompare(left);
    });
  }

  listHistory(): void {
    const entries = this.sortByUpdated(this.loadEntries());
    if (entries.length === 0) {
      console.log("(履歴なし)");
      return;
    }

    console.log("=== 履歴一覧（新しい順） ===");
    entries.forEach((entry, index) => {
      const model = entry.model ?? "-";
      const effort = entry.effort ?? "-";
      const verbosity = entry.verbosity ?? "-";
      const requestCount = entry.request_count ?? 0;
      const updated = entry.updated_at ?? "-";
      const title = entry.title ?? "(no title)";
      console.log(
        `${String(index + 1).padStart(2, " ")}) ${title} [${model}/${effort}/${verbosity} ${requestCount}回] ${updated}`,
      );
    });
  }

  selectByNumber(index: number): HistoryEntry {
    const entries = this.sortByUpdated(this.loadEntries());
    if (!Number.isInteger(index) || index < 1 || index > entries.length) {
      throw new Error(`[openai_api] 無効な履歴番号です（1〜${entries.length}）。: ${index}`);
    }
    return entries[index - 1];
  }

  deleteByNumber(index: number): { removedTitle: string; removedId: string } {
    const entries = this.sortByUpdated(this.loadEntries());
    if (!Number.isInteger(index) || index < 1 || index > entries.length) {
      throw new Error(`[openai_api] 無効な履歴番号です（1〜${entries.length}）。: ${index}`);
    }
    const entry = entries[index - 1];
    const lastId = entry.last_response_id;
    if (!lastId) {
      throw new Error("[openai_api] 選択した履歴の last_response_id が無効です。");
    }
    const filtered = this.loadEntries().filter((item) => item.last_response_id !== lastId);
    this.saveEntries(filtered);
    return { removedTitle: entry.title ?? "(no title)", removedId: lastId };
  }

  showByNumber(index: number, noColor: boolean): void {
    const entries = this.sortByUpdated(this.loadEntries());
    if (!Number.isInteger(index) || index < 1 || index > entries.length) {
      throw new Error(`[openai_api] 無効な履歴番号です（1〜${entries.length}）。: ${index}`);
    }
    const entry = entries[index - 1];
    const title = entry.title ?? "(no title)";
    const updated = entry.updated_at ?? "-";
    const requestCount = entry.request_count ?? 0;
    console.log(`=== 履歴 #${index}: ${title} (更新: ${updated}, リクエスト:${requestCount}回) ===`);

    const turns = entry.turns ?? [];
    if (turns.length === 0) {
      console.log("(この履歴には保存された対話メッセージがありません)");
      return;
    }

    const useColor = !noColor && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    const colors = {
      user: useColor ? "\u001b[36m" : "",
      assistant: useColor ? "\u001b[34m" : "",
      summary: useColor ? "\u001b[33m" : "",
      reset: useColor ? "\u001b[0m" : "",
    };

    const printable = turns.filter((turn) => {
      if (turn.role === "user" || turn.role === "assistant") return true;
      if (turn.role === "system" && turn.kind === "summary") return true;
      return false;
    });

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
      console.log((turn.text ?? ""));
      console.log("");
    });
  }

  findLatest(): HistoryEntry | undefined {
    const entries = this.loadEntries();
    if (entries.length === 0) return undefined;
    return this.sortByUpdated(entries)[0];
  }

  upsertEntry(entry: HistoryEntry): void {
    const entries = this.loadEntries();
    const existingIndex = entries.findIndex((item) => item.last_response_id === entry.last_response_id);
    if (existingIndex >= 0) {
      entries[existingIndex] = entry;
    } else {
      entries.push(entry);
    }
    this.saveEntries(entries);
  }
}

export function updateHistoryEntries(store: HistoryStore, entries: HistoryEntry[]): void {
  store.saveEntries(entries);
}

export function loadAllEntries(store: HistoryStore): HistoryEntry[] {
  return store.loadEntries();
}

export function replaceEntry(
  store: HistoryStore,
  predicate: (entry: HistoryEntry) => boolean,
  updater: (entry: HistoryEntry) => HistoryEntry,
  fallback: () => HistoryEntry,
): HistoryEntry {
  const entries = store.loadEntries();
  let replaced: HistoryEntry | null = null;
  const nextEntries = entries.map((entry) => {
    if (predicate(entry)) {
      replaced = updater(entry);
      return replaced;
    }
    return entry;
  });

  if (replaced) {
    store.saveEntries(nextEntries);
    return replaced;
  }

  const fallbackEntry = fallback();
  nextEntries.push(fallbackEntry);
  store.saveEntries(nextEntries);
  return fallbackEntry;
}

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
