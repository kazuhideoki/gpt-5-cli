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

const transformOutput = (legacyOutput: LegacyTask["output"]) => {
  if (!legacyOutput) {
    return undefined;
  }
  const next: { file?: string; copy?: boolean } = {};
  if (typeof legacyOutput.file === "string" && legacyOutput.file.trim().length > 0) {
    next.file = legacyOutput.file;
  }
  if (typeof legacyOutput.copy === "boolean") {
    next.copy = legacyOutput.copy;
  }
  return Object.keys(next).length > 0 ? next : undefined;
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
    return {
      cli: "ask",
      output: transformOutput(task.output),
    };
  }
  if (mode === "d2") {
    return {
      cli: "d2" as const,
      file_path: task.d2?.file_path,
      output: transformOutput(task.output),
    };
  }
  if (mode === "mermaid") {
    return {
      cli: "mermaid" as const,
      file_path: task.mermaid?.file_path,
      output: transformOutput(task.output),
    };
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
    const context: Record<string, unknown> = {
      cli: "sql" as const,
      engine,
      dsn_hash: dsnHash,
    };
    const output = transformOutput(task.output);
    if (output) {
      context.output = output;
    }
    if (task.sql?.dsn) {
      context.dsn = task.sql.dsn;
    }
    if (normalizedConnection && Object.keys(normalizedConnection).length > 0) {
      context.connection = normalizedConnection;
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

const migrated = history.map((entry: LegacyEntry) => {
  if ("context" in entry && entry.context !== undefined) {
    return entry;
  }
  if (!entry.task) {
    const { task: _unused, ...rest } = entry;
    return rest;
  }
  const context = migrateTask(entry.task);
  const { task: _unused, ...rest } = entry;
  if (context) {
    return { ...rest, context };
  }
  return rest;
});

const json = JSON.stringify(migrated, null, 2);
fs.writeFileSync(outputPath, `${json}\n`, "utf8");
