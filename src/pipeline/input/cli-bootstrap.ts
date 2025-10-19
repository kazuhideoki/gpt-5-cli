// cli-bootstrap.ts: 各 CLI で共通となる初期化と履歴ストア準備をまとめたユーティリティ。
// NOTE(pipeline/input): 将来的には Input パイプラインのエントリポイントから呼び出す想定。
import type { HistoryEntry } from "../../core/history.js";
import { HistoryStore } from "../../core/history.js";
import { loadDefaults, loadEnvironment } from "../../core/config.js";
import { loadPrompt, resolvePromptPath } from "../../core/prompts.js";
import type { CliDefaults, CliOptions } from "../../core/types.js";
import type { z } from "zod";

interface CliBootstrapParams<TOptions extends CliOptions, THistoryContext> {
  argv: string[];
  logLabel: string;
  parseArgs: (argv: string[], defaults: CliDefaults) => TOptions;
  historyContextSchema: z.ZodType<THistoryContext>;
  historyEntryFilter?: (entry: HistoryEntry<THistoryContext>) => boolean;
  envFileSuffix?: string;
}

interface CliBootstrapHelpResult<TOptions extends CliOptions> {
  status: "help";
  defaults: CliDefaults;
  options: TOptions;
  systemPrompt?: string;
  promptPath: string;
}

interface CliBootstrapReadyResult<TOptions extends CliOptions, THistoryContext> {
  status: "ready";
  defaults: CliDefaults;
  options: TOptions;
  systemPrompt?: string;
  promptPath: string;
  historyStore: HistoryStore<THistoryContext>;
}

type CliBootstrapResult<TOptions extends CliOptions, THistoryContext> =
  | CliBootstrapHelpResult<TOptions>
  | CliBootstrapReadyResult<TOptions, THistoryContext>;

/**
 * CLIエントリーポイントで共通となる初期化処理を実行する。
 */
export function bootstrapCli<TOptions extends CliOptions, THistoryContext = unknown>(
  params: CliBootstrapParams<TOptions, THistoryContext>,
): CliBootstrapResult<TOptions, THistoryContext> {
  loadEnvironment({ envSuffix: params.envFileSuffix });
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
    return {
      status: "help",
      defaults,
      options,
      systemPrompt,
      promptPath,
    };
  }

  const historyStore = new HistoryStore<THistoryContext>(defaults.historyIndexPath, {
    contextSchema: params.historyContextSchema,
    entryFilter: params.historyEntryFilter,
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
