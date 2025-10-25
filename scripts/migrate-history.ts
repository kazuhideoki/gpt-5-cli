#!/usr/bin/env bun
/**
 * 旧フォーマットの履歴ファイルを新しい context ベースの構造へ変換するマイグレーションスクリプト。
 *
 * Usage:
 *   bun run scripts/migrate-history.ts --input path/to/history.json [--output path/to/output.json]
 */
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { z } from "zod";

const outputSchema = z
  .object({
    file: z.string().optional(),
    copy: z.boolean().optional(),
  })
  .optional();

const legacyTaskSchema = z
  .object({
    mode: z.string().optional(),
    output: outputSchema,
    d2: z
      .object({
        file_path: z.string().optional(),
      })
      .optional(),
    mermaid: z
      .object({
        file_path: z.string().optional(),
      })
      .optional(),
    sql: z
      .object({
        type: z.enum(["postgresql", "mysql"]).optional(),
        dsn: z.string().optional(),
        dsn_hash: z.string().optional(),
        connection: z
          .object({
            host: z.string().optional(),
            port: z.number().optional(),
            database: z.string().optional(),
            user: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .optional();

const legacyEntrySchema = z
  .object({
    task: legacyTaskSchema,
    context: z.unknown().optional(),
  })
  .passthrough();

const legacyHistorySchema = z.array(legacyEntrySchema);

type LegacyEntry = z.infer<typeof legacyEntrySchema>;
type LegacyTask = z.infer<NonNullable<typeof legacyTaskSchema>>;

type MigratedBaseContext = {
  cli: "ask" | "d2" | "mermaid" | "sql";
  absolute_path?: string;
  relative_path?: string;
  copy?: boolean;
};

type MigratedAskContext = MigratedBaseContext & {
  cli: "ask";
};

type MigratedFileContext = MigratedBaseContext & {
  cli: "d2" | "mermaid";
};

type MigratedSqlContext = MigratedBaseContext & {
  cli: "sql";
  engine: "postgresql" | "mysql";
  dsn_hash: string;
  dsn?: string;
  connection?: Record<string, unknown>;
};

type MigratedContext = MigratedAskContext | MigratedFileContext | MigratedSqlContext;

const program = new Command()
  .requiredOption("--input <path>", "変換対象の履歴ファイルパス")
  .option("--output <path>", "変換結果の出力先（省略時は上書き保存）");

program.parse(process.argv);

const options = program.opts<{ input: string; output?: string }>();

const inputPath = path.resolve(process.cwd(), options.input);
const outputPath = options.output ? path.resolve(process.cwd(), options.output) : inputPath;

const raw = fs.readFileSync(inputPath, "utf8");
const parsed = JSON.parse(raw);
const history = legacyHistorySchema.parse(parsed);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const ensureCopyFlag = (rawCopy: unknown): boolean | undefined => {
  return rawCopy === true ? true : undefined;
};

const extractOutputFields = (legacyOutput: LegacyTask["output"] | unknown) => {
  if (!isRecord(legacyOutput)) {
    return { relative: undefined, copy: undefined };
  }
  const relative = normalizeString(legacyOutput.file);
  const copy = ensureCopyFlag(legacyOutput.copy);
  return { relative, copy };
};

const migrateTask = (task: LegacyTask | undefined): Record<string, unknown> | undefined => {
  if (!task) {
    return undefined;
  }
  const mode = task.mode ?? guessMode(task);
  if (!mode) {
    throw new Error("legacy entry has a task but no mode is specified");
  }
  if (mode === "ask") {
    const { relative, copy } = extractOutputFields(task.output);
    const context: MigratedAskContext = {
      cli: "ask",
    };
    if (relative) {
      context.relative_path = relative;
    }
    if (copy) {
      context.copy = true;
    }
    return context;
  }
  if (mode === "d2") {
    const { relative, copy } = extractOutputFields(task.output);
    const absolute = normalizeString(task.d2?.file_path);
    const context: MigratedFileContext = {
      cli: "d2",
    };
    if (absolute) {
      context.absolute_path = absolute;
    }
    if (relative) {
      context.relative_path = relative;
    }
    if (copy) {
      context.copy = true;
    }
    return context;
  }
  if (mode === "mermaid") {
    const { relative, copy } = extractOutputFields(task.output);
    const absolute = normalizeString(task.mermaid?.file_path);
    const context: MigratedFileContext = {
      cli: "mermaid",
    };
    if (absolute) {
      context.absolute_path = absolute;
    }
    if (relative) {
      context.relative_path = relative;
    }
    if (copy) {
      context.copy = true;
    }
    return context;
  }
  if (mode === "sql") {
    const engine = task.sql?.type;
    const dsnHash = task.sql?.dsn_hash;
    if (!engine || !dsnHash) {
      throw new Error("legacy SQL task is missing engine or dsn_hash");
    }
    const normalizedConnection =
      task.sql?.connection &&
      Object.fromEntries(
        Object.entries(task.sql.connection).filter(
          ([, value]) => value !== undefined && value !== "",
        ),
      );
    const { relative, copy } = extractOutputFields(task.output);
    const context: MigratedSqlContext = {
      cli: "sql",
      engine,
      dsn_hash: dsnHash,
    };
    if (task.sql?.dsn) {
      context.dsn = task.sql.dsn;
    }
    if (normalizedConnection && Object.keys(normalizedConnection).length > 0) {
      context.connection = normalizedConnection;
    }
    if (relative) {
      context.relative_path = relative;
    }
    if (copy) {
      context.copy = true;
    }
    return context;
  }
  throw new Error(`unsupported legacy mode: ${mode}`);
};

const guessMode = (task: LegacyTask): string | undefined => {
  if (task.d2) return "d2";
  if (task.mermaid) return "mermaid";
  if (task.sql) return "sql";
  return undefined;
};

const migrateExistingContext = (rawContext: unknown): MigratedContext | undefined => {
  if (!isRecord(rawContext)) {
    return undefined;
  }
  const cli = rawContext.cli;
  if (cli !== "ask" && cli !== "d2" && cli !== "mermaid" && cli !== "sql") {
    return undefined;
  }

  const rawOutput = (rawContext as { output?: unknown }).output;
  const { relative: legacyRelative, copy: legacyCopy } = extractOutputFields(rawOutput);
  const existingRelative = normalizeString(
    (rawContext as { relative_path?: unknown }).relative_path,
  );
  const relative = existingRelative ?? legacyRelative;
  const absolute = normalizeString(
    (rawContext as { absolute_path?: unknown }).absolute_path ??
      (rawContext as { file_path?: unknown }).file_path,
  );
  const copyFromContext = ensureCopyFlag((rawContext as { copy?: unknown }).copy);
  const copy = copyFromContext ?? legacyCopy;

  const context: Record<string, unknown> = { ...rawContext };
  delete context.output;
  delete context.file_path;
  if (relative !== undefined) {
    context.relative_path = relative;
  } else {
    delete context.relative_path;
  }
  if (absolute !== undefined) {
    context.absolute_path = absolute;
  } else {
    delete context.absolute_path;
  }
  if (copy) {
    context.copy = true;
  } else {
    delete context.copy;
  }

  if (cli === "sql") {
    if (typeof context.engine !== "string" || typeof context.dsn_hash !== "string") {
      throw new Error("legacy SQL context is missing engine or dsn_hash");
    }
    return context as MigratedSqlContext;
  }

  return context as MigratedAskContext | MigratedFileContext;
};

const migrated = history.map((entry: LegacyEntry) => {
  const { task: legacyTask, context: legacyContext, ...rest } = entry;

  const migratedContext =
    migrateExistingContext(legacyContext) ?? migrateTask(legacyTask ?? undefined);

  if (migratedContext) {
    return { ...rest, context: migratedContext };
  }

  if (legacyContext !== undefined) {
    return { ...rest, context: legacyContext };
  }

  return rest;
});

const json = JSON.stringify(migrated, null, 2);
fs.writeFileSync(outputPath, `${json}\n`, "utf8");
