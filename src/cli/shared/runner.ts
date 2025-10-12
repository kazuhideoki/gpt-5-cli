import { HistoryStore } from "../../core/history.js";
import { loadDefaults, loadEnvironment } from "../../core/config.js";
import { loadPrompt, resolvePromptPath } from "../../core/prompts.js";
import type { CliDefaults, CliOptions } from "../default/types.js";
import { cliHistoryTaskSchema, type CliHistoryTask } from "../history/taskAdapter.js";

export interface CliBootstrapParams<TOptions extends CliOptions> {
  argv: string[];
  logLabel: string;
  parseArgs: (argv: string[], defaults: CliDefaults) => TOptions;
  printHelp: (defaults: CliDefaults, options: TOptions) => void;
}

export interface CliBootstrapHelpResult<TOptions extends CliOptions> {
  status: "help";
  defaults: CliDefaults;
  options: TOptions;
  systemPrompt?: string;
  promptPath: string;
}

export interface CliBootstrapReadyResult<TOptions extends CliOptions> {
  status: "ready";
  defaults: CliDefaults;
  options: TOptions;
  systemPrompt?: string;
  promptPath: string;
  historyStore: HistoryStore<CliHistoryTask>;
}

export type CliBootstrapResult<TOptions extends CliOptions> =
  | CliBootstrapHelpResult<TOptions>
  | CliBootstrapReadyResult<TOptions>;

/**
 * CLIエントリーポイントで共通となる初期化処理を実行する。
 */
export function bootstrapCli<TOptions extends CliOptions>(
  params: CliBootstrapParams<TOptions>,
): CliBootstrapResult<TOptions> {
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

  const historyStore = new HistoryStore<CliHistoryTask>(defaults.historyIndexPath, {
    taskSchema: cliHistoryTaskSchema,
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
