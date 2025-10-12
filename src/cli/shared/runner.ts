import { HistoryStore } from "../../core/history.js";
import { loadDefaults, loadEnvironment } from "../../core/config.js";
import { loadPrompt, resolvePromptPath } from "../../core/prompts.js";
import type { CliDefaults, CliOptions } from "../default/types.js";
import type { z } from "zod";

export interface CliBootstrapParams<TOptions extends CliOptions, THistoryTask> {
  argv: string[];
  logLabel: string;
  parseArgs: (argv: string[], defaults: CliDefaults) => TOptions;
  printHelp: (defaults: CliDefaults, options: TOptions) => void;
  historyTaskSchema: z.ZodType<THistoryTask>;
}

export interface CliBootstrapHelpResult<TOptions extends CliOptions> {
  status: "help";
  defaults: CliDefaults;
  options: TOptions;
  systemPrompt?: string;
  promptPath: string;
}

export interface CliBootstrapReadyResult<TOptions extends CliOptions, THistoryTask> {
  status: "ready";
  defaults: CliDefaults;
  options: TOptions;
  systemPrompt?: string;
  promptPath: string;
  historyStore: HistoryStore<THistoryTask>;
}

export type CliBootstrapResult<TOptions extends CliOptions, THistoryTask> =
  | CliBootstrapHelpResult<TOptions>
  | CliBootstrapReadyResult<TOptions, THistoryTask>;

/**
 * CLIエントリーポイントで共通となる初期化処理を実行する。
 */
export function bootstrapCli<TOptions extends CliOptions, THistoryTask = unknown>(
  params: CliBootstrapParams<TOptions, THistoryTask>,
): CliBootstrapResult<TOptions, THistoryTask> {
  loadEnvironment();
  const defaults = loadDefaults();
  console.log(`${params.logLabel} history_index: ${defaults.historyIndexPath}`);

  const options = params.parseArgs(params.argv, defaults);
  const promptPath = resolvePromptPath(options.taskMode, defaults.promptsDir);
  const systemPrompt = loadPrompt(options.taskMode, defaults.promptsDir);
  if (systemPrompt) {
    const bytes = Buffer.byteLength(systemPrompt, "utf8");
    console.log(`${params.logLabel} system_prompt: loaded (${bytes} bytes) path=${promptPath}`);
  } else {
    console.error(`${params.logLabel} system_prompt: not found or empty path=${promptPath}`);
  }

  if (options.helpRequested) {
    params.printHelp(defaults, options);
    return {
      status: "help",
      defaults,
      options,
      systemPrompt,
      promptPath,
    };
  }

  const historyStore = new HistoryStore<THistoryTask>(defaults.historyIndexPath, {
    taskSchema: params.historyTaskSchema,
  });

  return {
    status: "ready",
    defaults,
    options,
    systemPrompt,
    promptPath,
    historyStore,
  };
}
