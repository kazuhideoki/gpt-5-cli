/**
 * 履歴インデックスの読み書きを担うストレージモジュール。
 * CLI やパイプライン各層から共有されるデータアクセスを提供する。
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { expandHome } from "../../foundation/paths.js";
import type {
  EffortLevel,
  HistoryEntry as CoreHistoryEntry,
  HistoryTurn as CoreHistoryTurn,
  VerbosityLevel,
} from "../../types.js";

/** 履歴に格納される各ターンを検証するスキーマ。 */
const historyTurnSchema = z.object({
  role: z.string(),
  text: z.string().optional(),
  at: z.string().optional(),
  response_id: z.string().optional(),
  kind: z.string().optional(),
});

/** 要約エントリの構造を検証するスキーマ。 */
const historySummarySchema = z.object({
  text: z.string().optional(),
  created_at: z.string().optional(),
});

/** 履歴の再開情報を検証するスキーマ。 */
const historyResumeSchema = z.object({
  mode: z.string().optional(),
  previous_response_id: z.string().optional(),
  summary: historySummarySchema.optional(),
});

/**
 * 履歴エントリ全体を検証するスキーマ。
 * TODO(gpt-5-cli#history-top-level-cli): Promote CLI discriminator to top-level fields and migrate existing histories.
 */
const baseHistoryEntrySchema = z.object({
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
  context: z.unknown().optional(),
});

export type HistoryTurn = CoreHistoryTurn;

export type HistoryEntry<TContext = unknown> = CoreHistoryEntry<TContext>;

/**
 * 履歴ファイルの保存先パスを決定する。
 *
 * @param defaultPath 既定パス。
 * @returns 解析済みの絶対パス。
 */
export function resolveHistoryPath(defaultPath?: string): string {
  const configured = process.env.GPT_5_CLI_HISTORY_INDEX_FILE;
  if (typeof configured === "string") {
    const trimmed = configured.trim();
    if (trimmed.length === 0) {
      throw new Error("GPT_5_CLI_HISTORY_INDEX_FILE is set but empty.");
    }
    const expanded = expandHome(trimmed);
    return path.resolve(expanded);
  }
  if (typeof defaultPath === "string") {
    const trimmed = defaultPath.trim();
    if (trimmed.length === 0) {
      throw new Error("Default history path is empty.");
    }
    const expanded = expandHome(trimmed);
    return path.resolve(expanded);
  }
  throw new Error("GPT_5_CLI_HISTORY_INDEX_FILE must be configured via environment files.");
}

function createHistoryEntrySchema<TContext>(
  contextSchema?: z.ZodType<TContext>,
): z.ZodType<HistoryEntry<TContext>> {
  if (contextSchema) {
    return baseHistoryEntrySchema.extend({
      context: contextSchema.optional(),
    }) as z.ZodType<HistoryEntry<TContext>>;
  }
  return baseHistoryEntrySchema as unknown as z.ZodType<HistoryEntry<TContext>>;
}

function createHistoryEntriesSchema<TContext>(
  contextSchema?: z.ZodType<TContext>,
): z.ZodArray<z.ZodType<HistoryEntry<TContext>>> {
  return z.array(createHistoryEntrySchema(contextSchema));
}

interface HistoryEntryMetadata {
  model: string;
  effort: EffortLevel;
  verbosity: VerbosityLevel;
}

interface HistoryUpsertContext<TContext> {
  isNewConversation: boolean;
  titleToUse: string;
  previousResponseId?: string;
  activeLastResponseId?: string;
  resumeSummaryText?: string;
  resumeSummaryCreatedAt?: string;
  previousContext?: TContext;
}

interface HistoryConversationUpsert<TContext> {
  metadata: HistoryEntryMetadata;
  context: HistoryUpsertContext<TContext>;
  responseId: string;
  userText: string;
  assistantText: string;
  contextData?: TContext;
}

interface HistoryStoreOptions<TContext> {
  contextSchema?: z.ZodType<TContext>;
  entryFilter?: (entry: HistoryEntry<TContext>) => boolean;
}

/**
 * 履歴インデックスファイルを管理するユーティリティ。
 */
export class HistoryStore<TContext = unknown> {
  private readonly entriesSchema: z.ZodArray<z.ZodType<HistoryEntry<TContext>>>;

  private readonly entryFilter?: (entry: HistoryEntry<TContext>) => boolean;

  constructor(
    private readonly filePath: string,
    options: HistoryStoreOptions<TContext> = {},
  ) {
    this.entriesSchema = createHistoryEntriesSchema(options.contextSchema);
    this.entryFilter = options.entryFilter;
  }

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
  loadEntries(): HistoryEntry<TContext>[] {
    this.ensureInitialized();
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return this.entriesSchema.parse(parsed);
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
  saveEntries(entries: HistoryEntry<TContext>[]): void {
    this.ensureInitialized();
    const normalized = this.entriesSchema.parse(entries);
    const json = JSON.stringify(normalized, null, 2);
    fs.writeFileSync(this.filePath, `${json}\n`, "utf8");
  }

  private sortByUpdated(entries: HistoryEntry<TContext>[]): HistoryEntry<TContext>[] {
    return [...entries].sort((a, b) => {
      const left = a.updated_at ?? "";
      const right = b.updated_at ?? "";
      if (left === right) return 0;
      return right.localeCompare(left);
    });
  }

  /**
   * フィルタ済みの履歴一覧を更新日時降順で取得する。
   */
  getFilteredEntries(): HistoryEntry<TContext>[] {
    const sorted = this.sortByUpdated(this.loadEntries());
    if (!this.entryFilter) {
      return sorted;
    }
    return sorted.filter((entry) => {
      try {
        return this.entryFilter!(entry);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`[gpt-5-cli] history filter failed: ${message}`);
      }
    });
  }

  /**
   * 指定番号の履歴エントリを取得する。
   *
   * @param index 1始まりの履歴番号。
   * @returns 該当エントリ。
   */
  selectByNumber(index: number): HistoryEntry<TContext> {
    const entries = this.getFilteredEntries();
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
    const scopedEntries = this.getFilteredEntries();
    if (!Number.isInteger(index) || index < 1 || index > scopedEntries.length) {
      throw new Error(`[gpt-5-cli] 無効な履歴番号です（1〜${scopedEntries.length}）。: ${index}`);
    }
    const entry = scopedEntries[index - 1];
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
   * 対話履歴へ新たなターンを保存する。該当会話が存在すれば更新、無ければ新規作成する。
   */
  upsertConversation(params: HistoryConversationUpsert<TContext>): void {
    const { metadata, context, responseId, userText, assistantText, contextData } = params;
    const entries = this.loadEntries();
    const tsNow = new Date().toISOString();
    let targetLastId = context.previousResponseId;
    if (!targetLastId && context.activeLastResponseId) {
      targetLastId = context.activeLastResponseId;
    }

    const resumeSummaryText = context.resumeSummaryText ?? "";
    let resumeSummaryCreated = context.resumeSummaryCreatedAt ?? "";
    if (resumeSummaryText && !resumeSummaryCreated) {
      resumeSummaryCreated = tsNow;
    }

    const resume = resumeSummaryText
      ? {
          mode: "response_id" as const,
          previous_response_id: responseId,
          summary: {
            text: resumeSummaryText,
            created_at: resumeSummaryCreated,
          },
        }
      : {
          mode: "response_id" as const,
          previous_response_id: responseId,
        };

    const userTurn = { role: "user", text: userText, at: tsNow };
    const assistantTurn = {
      role: "assistant",
      text: assistantText,
      at: tsNow,
      response_id: responseId,
    };

    const resolveContext = (previousContext?: TContext, existingContext?: TContext) =>
      contextData ?? previousContext ?? existingContext;

    if (context.isNewConversation && !targetLastId) {
      const newEntry: HistoryEntry<TContext> = {
        title: context.titleToUse,
        model: metadata.model,
        effort: metadata.effort,
        verbosity: metadata.verbosity,
        created_at: tsNow,
        updated_at: tsNow,
        first_response_id: responseId,
        last_response_id: responseId,
        request_count: 1,
        resume,
        turns: [userTurn, assistantTurn],
        context: resolveContext(context.previousContext),
      };
      entries.push(newEntry);
      this.saveEntries(entries);
      return;
    }

    let updated = false;
    const nextEntries = entries.map((entry) => {
      if ((entry.last_response_id ?? "") === (targetLastId ?? "")) {
        updated = true;
        const turns = [...(entry.turns ?? []), userTurn, assistantTurn];
        const nextResume = resumeSummaryText
          ? {
              ...(entry.resume ?? {}),
              mode: "response_id" as const,
              previous_response_id: responseId,
              summary: {
                text: resumeSummaryText,
                created_at:
                  resumeSummaryCreated ||
                  entry.resume?.summary?.created_at ||
                  entry.created_at ||
                  tsNow,
              },
            }
          : {
              ...(entry.resume ?? {}),
              mode: "response_id" as const,
              previous_response_id: responseId,
            };
        if (!resumeSummaryText && nextResume.summary) {
          delete nextResume.summary;
        }
        const nextEntry = {
          ...entry,
          updated_at: tsNow,
          last_response_id: responseId,
          model: metadata.model,
          effort: metadata.effort,
          verbosity: metadata.verbosity,
          request_count: (entry.request_count ?? 0) + 1,
          turns,
          resume: nextResume,
          context: resolveContext(context.previousContext, entry.context),
        };
        return nextEntry;
      }
      return entry;
    });

    if (updated) {
      this.saveEntries(nextEntries);
      return;
    }

    const fallbackEntry: HistoryEntry<TContext> = {
      title: context.titleToUse,
      model: metadata.model,
      effort: metadata.effort,
      verbosity: metadata.verbosity,
      created_at: tsNow,
      updated_at: tsNow,
      first_response_id: responseId,
      last_response_id: responseId,
      request_count: 1,
      resume,
      turns: [userTurn, assistantTurn],
      context: resolveContext(context.previousContext),
    };
    nextEntries.push(fallbackEntry);
    this.saveEntries(nextEntries);
  }

  /**
   * 最も新しい履歴エントリを取得する。
   *
   * @returns 最新エントリ。存在しない場合はundefined。
   */
  findLatest(): HistoryEntry<TContext> | undefined {
    const entries = this.getFilteredEntries();
    if (entries.length === 0) return undefined;
    return entries[0];
  }

  /**
   * 履歴エントリをIDで更新または追加する。
   *
   * @param entry 保存対象エントリ。
   */
  upsertEntry(entry: HistoryEntry<TContext>): void {
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
