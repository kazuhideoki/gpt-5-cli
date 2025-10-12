// TODO default と d2 部分など共通部分以外は多相性を持たせるように再設計する
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/** 履歴に格納される各ターンを検証するスキーマ。 */
export const historyTurnSchema = z.object({
  role: z.string(),
  text: z.string().optional(),
  at: z.string().optional(),
  response_id: z.string().optional(),
  kind: z.string().optional(),
});

export type HistoryTurn = z.infer<typeof historyTurnSchema>;

/** 要約エントリの構造を検証するスキーマ。 */
export const historySummarySchema = z.object({
  text: z.string().optional(),
  created_at: z.string().optional(),
});

export type HistorySummary = z.infer<typeof historySummarySchema>;

/** 履歴の再開情報を検証するスキーマ。 */
export const historyResumeSchema = z.object({
  mode: z.string().optional(),
  previous_response_id: z.string().optional(),
  summary: historySummarySchema.optional(),
});

export type HistoryResume = z.infer<typeof historyResumeSchema>;

/** d2モードのタスク付随情報を検証するスキーマ。 */
export const historyTaskD2Schema = z.object({
  file_path: z.string().optional(),
});

export type HistoryTaskD2 = z.infer<typeof historyTaskD2Schema>;

/** 履歴タスクメタデータ全体を検証するスキーマ。 */
export const historyTaskSchema = z.object({
  mode: z.string().optional(),
  d2: historyTaskD2Schema.optional(),
});

export type HistoryTask = z.infer<typeof historyTaskSchema>;

/** 履歴エントリ全体を検証するスキーマ。 */
export const historyEntrySchema = z.object({
  title: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  verbosity: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  first_response_id: z.string().optional(),
  last_response_id: z.string().optional(),
  request_count: z
    .preprocess((value) => {
      if (value === undefined) {
        return undefined;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!/^\d+$/u.test(trimmed)) {
          return Number.NaN;
        }
        return Number.parseInt(trimmed, 10);
      }
      return value;
    }, z.number().int().nonnegative())
    .optional(),
  resume: historyResumeSchema.optional(),
  turns: z.array(historyTurnSchema).optional(),
  task: historyTaskSchema.optional(),
});

export type HistoryEntry = z.infer<typeof historyEntrySchema>;

const historyEntriesSchema = z.array(historyEntrySchema);

/**
 * 履歴インデックスファイルを管理するユーティリティ。
 */
export class HistoryStore {
  constructor(private readonly filePath: string) {}

  /**
   * 履歴ファイルとディレクトリを初期化する。
   */
  ensureInitialized(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "[]\n", "utf8");
    }
  }

  /**
   * 履歴エントリをファイルから読み込み、スキーマ検証する。
   *
   * @returns 検証済みの履歴一覧。
   */
  loadEntries(): HistoryEntry[] {
    this.ensureInitialized();
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return historyEntriesSchema.parse(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[gpt-5-cli] failed to parse history index: ${message}`);
    }
  }

  /**
   * 履歴エントリをファイルへ保存する。
   *
   * @param entries 保存対象の履歴一覧。
   */
  saveEntries(entries: HistoryEntry[]): void {
    this.ensureInitialized();
    const normalized = historyEntriesSchema.parse(entries);
    const json = JSON.stringify(normalized, null, 2);
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

  /**
   * 履歴一覧を更新日時の降順で表示する。
   */
  listHistory(): void {
    const entries = this.sortByUpdated(this.loadEntries());
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
      console.log(
        `${String(index + 1).padStart(2, " ")}) ${title} [${model}/${effort}/${verbosity} ${requestCount}回] ${updated}`,
      );
    });
  }

  /**
   * 指定番号の履歴エントリを取得する。
   *
   * @param index 1始まりの履歴番号。
   * @returns 該当エントリ。
   */
  selectByNumber(index: number): HistoryEntry {
    const entries = this.sortByUpdated(this.loadEntries());
    if (!Number.isInteger(index) || index < 1 || index > entries.length) {
      throw new Error(`[gpt-5-cli] 無効な履歴番号です（1〜${entries.length}）。: ${index}`);
    }
    return entries[index - 1];
  }

  /**
   * 指定番号の履歴を削除し、削除したタイトルとIDを返す。
   *
   * @param index 1始まりの履歴番号。
   * @returns 削除したタイトルとlast_response_id。
   */
  deleteByNumber(index: number): { removedTitle: string; removedId: string } {
    const entries = this.sortByUpdated(this.loadEntries());
    if (!Number.isInteger(index) || index < 1 || index > entries.length) {
      throw new Error(`[gpt-5-cli] 無効な履歴番号です（1〜${entries.length}）。: ${index}`);
    }
    const entry = entries[index - 1];
    const lastId = entry.last_response_id;
    if (!lastId) {
      throw new Error("[gpt-5-cli] 選択した履歴の last_response_id が無効です。");
    }
    const filtered = this.loadEntries().filter((item) => item.last_response_id !== lastId);
    this.saveEntries(filtered);
    return {
      removedTitle: entry.title ?? "(タイトル未設定)",
      removedId: lastId,
    };
  }

  /**
   * 指定番号の履歴詳細を標準出力へ表示する。
   *
   * @param index 1始まりの履歴番号。
   * @param noColor カラー出力を禁止するフラグ。
   */
  showByNumber(index: number, noColor: boolean): void {
    const entries = this.sortByUpdated(this.loadEntries());
    if (!Number.isInteger(index) || index < 1 || index > entries.length) {
      throw new Error(`[gpt-5-cli] 無効な履歴番号です（1〜${entries.length}）。: ${index}`);
    }
    const entry = entries[index - 1];
    const title = entry.title ?? "(タイトル未設定)";
    const updated = entry.updated_at ?? "(更新日時 未設定)";
    const requestCount = entry.request_count ?? 0;
    console.log(
      `=== 履歴 #${index}: ${title} (更新: ${updated}, リクエスト:${requestCount}回) ===`,
    );

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
      console.log(turn.text ?? "");
      console.log("");
    });
  }

  /**
   * 最も新しい履歴エントリを取得する。
   *
   * @returns 最新エントリ。存在しない場合はundefined。
   */
  findLatest(): HistoryEntry | undefined {
    const entries = this.loadEntries();
    if (entries.length === 0) return undefined;
    return this.sortByUpdated(entries)[0];
  }

  /**
   * 履歴エントリをIDで更新または追加する。
   *
   * @param entry 保存対象エントリ。
   */
  upsertEntry(entry: HistoryEntry): void {
    const entries = this.loadEntries();
    const existingIndex = entries.findIndex(
      (item) => item.last_response_id === entry.last_response_id,
    );
    if (existingIndex >= 0) {
      entries[existingIndex] = entry;
    } else {
      entries.push(entry);
    }
    this.saveEntries(entries);
  }
}

/**
 * 履歴エントリ一覧を置き換えて保存する。
 *
 * @param store 履歴ストア。
 * @param entries 保存する一覧。
 */
export function updateHistoryEntries(store: HistoryStore, entries: HistoryEntry[]): void {
  store.saveEntries(entries);
}

/**
 * 履歴エントリを全件読み込むショートカット。
 *
 * @param store 履歴ストア。
 * @returns 履歴一覧。
 */
export function loadAllEntries(store: HistoryStore): HistoryEntry[] {
  return store.loadEntries();
}

/**
 * 条件に一致する履歴エントリを更新し、存在しなければ新規作成する。
 *
 * @param store 履歴ストア。
 * @param predicate 更新対象かを判定する関数。
 * @param updater エントリ更新関数。
 * @param fallback 対象が無かった場合に作成するエントリ。
 * @returns 更新または新規作成したエントリ。
 */
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

/**
 * 履歴ターンを要約用のテキストへ整形する。
 *
 * @param turns 履歴ターン一覧。
 * @returns 要約用に整形した文字列。
 */
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
