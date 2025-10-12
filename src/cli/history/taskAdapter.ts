import { z } from "zod";
import type { TaskMode } from "../../core/types.js";

export const cliHistoryTaskSchema = z.object({
  mode: z.string().optional(),
  d2: z
    .object({
      file_path: z.string().optional(),
    })
    .optional(),
});

export type CliHistoryTask = z.infer<typeof cliHistoryTaskSchema>;

export interface CliHistoryD2Context {
  absolutePath?: string;
}

export interface CliHistoryTaskOptions {
  taskMode: TaskMode;
  taskModeExplicit: boolean;
  d2FilePath?: string;
  d2FileExplicit: boolean;
}

export function buildCliHistoryTask(
  options: CliHistoryTaskOptions,
  previousTask?: CliHistoryTask,
  d2Context?: CliHistoryD2Context,
): CliHistoryTask | undefined {
  if (options.taskMode === "d2") {
    const task: CliHistoryTask = { mode: "d2" };
    let d2Meta = previousTask?.d2 ? { ...previousTask.d2 } : undefined;
    const contextPath = d2Context?.absolutePath;
    let filePath = contextPath ?? options.d2FilePath;
    if (!filePath && !options.d2FileExplicit) {
      filePath = d2Meta?.file_path;
    }
    if (contextPath) {
      d2Meta = { ...d2Meta, file_path: contextPath };
    } else if (filePath) {
      d2Meta = { ...d2Meta, file_path: filePath };
    }
    if (d2Meta && Object.keys(d2Meta).length > 0) {
      task.d2 = d2Meta;
    }
    return task;
  }

  if (options.taskModeExplicit) {
    return { mode: options.taskMode };
  }

  return previousTask;
}
