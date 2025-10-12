#!/usr/bin/env bun
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { z } from "zod";
import type { CliDefaults, CliOptions } from "./types.js";
import type { HistoryStore } from "../../core/history.js";
import { createOpenAIClient } from "../../core/openai.js";
import { expandLegacyShortFlags, parseHistoryFlag } from "../../core/cli/options.js";
import {
  buildRequest,
  computeContext,
  executeWithTools,
  extractResponseText,
  performCompact,
  prepareImageData,
} from "../../commands/conversation.js";
import { determineInput } from "../shared/input.js";
import { bootstrapCli } from "../shared/runner.js";

export const defaultCliHistoryTaskSchema = z.object({
  mode: z.string().optional(),
  d2: z
    .object({
      file_path: z.string().optional(),
    })
    .optional(),
});

export type DefaultCliHistoryTask = z.infer<typeof defaultCliHistoryTaskSchema>;

interface DefaultCliHistoryD2Context {
  absolutePath?: string;
}

interface DefaultCliHistoryTaskOptions {
  taskMode: CliOptions["taskMode"];
  taskModeExplicit: boolean;
  d2FilePath?: string;
  d2FileExplicit: boolean;
}

function buildDefaultCliHistoryTask(
  options: DefaultCliHistoryTaskOptions,
  previousTask?: DefaultCliHistoryTask,
  d2Context?: DefaultCliHistoryD2Context,
): DefaultCliHistoryTask | undefined {
  if (options.taskMode === "d2") {
    const task: DefaultCliHistoryTask = { mode: "d2" };
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

/**
 * CLIの利用方法を標準出力に表示する。
 *
 * @param defaults 現在の既定値セット。
 * @param options 解析済みのCLIオプション。
 */
function printHelp(defaults: CliDefaults, options: CliOptions): void {
  console.log("Usage:");
  console.log("  gpt-5-cli [-i <image>] [flag] <input>");
  console.log("  gpt-5-cli --compact <num>");
  console.log("");
  console.log("flag（種類+数字／連結可／ハイフン必須）:");
  console.log(
    `  -m0/-m1/-m2 : model => nano/mini/main(${defaults.modelNano}/${defaults.modelMini}/${defaults.modelMain})`,
  );
  console.log(`  -e0/-e1/-e2 : effort => low/medium/high (既定: ${options.effort})`);
  console.log(`  -v0/-v1/-v2 : verbosity => low/medium/high (既定: ${options.verbosity})`);
  console.log("  -c          : continue（直前の会話から継続）");
  console.log("  -r{num}     : 対応する履歴で対話を再開（例: -r2）");
  console.log("  -d{num}     : 対応する履歴を削除（例: -d2）");
  console.log("  -s{num}     : 対応する履歴の対話内容を表示（例: -s2）");
  console.log("");
  console.log(
    "  -i <image>   : 入力に画像を添付（$HOME 配下のフルパスまたは 'スクリーンショット *.png'）",
  );
  console.log("環境変数(.env):");
  console.log(
    "  GPT_5_CLI_HISTORY_INDEX_FILE : 履歴ファイルの保存先（例: ~/Library/Mobile Documents/com~apple~CloudDocs/gpt-5-cli/history_index.json）",
  );
  console.log(
    "  GPT_5_CLI_PROMPTS_DIR        : systemプロンプトテンプレートの配置ディレクトリ（例: ~/Library/Application Support/gpt-5-cli/prompts）",
  );
  console.log("");
  console.log(
    `既定: model=${defaults.modelNano}, effort=${options.effort}, verbosity=${options.verbosity}（フラグ未指定時）`,
  );
  console.log("");
  console.log("例:");
  console.log(
    "  gpt-5-cli -m1e2v2 もっと詳しく -> model=gpt-5-mini(m1), effort=high(e2), verbosity=high(v2)",
  );
  console.log(
    "  gpt-5-cli -m0e0v0 箇条書きで   -> model=gpt-5-nano(m0), effort=low(e0), verbosity=low(v0)",
  );
  console.log("  gpt-5-cli -r                 -> 履歴一覧のみ表示して終了");
  console.log("  gpt-5-cli -r2 続きをやろう   -> 2番目の履歴を使って継続");
}

/** CLI全体のオプションを統合的に検証するスキーマ。 */
const cliOptionsSchema: z.ZodType<CliOptions> = z
  .object({
    model: z.string(),
    effort: z.enum(["low", "medium", "high"]),
    verbosity: z.enum(["low", "medium", "high"]),
    continueConversation: z.boolean(),
    taskMode: z.literal("default"),
    resumeIndex: z.number().optional(),
    resumeListOnly: z.boolean(),
    deleteIndex: z.number().optional(),
    showIndex: z.number().optional(),
    imagePath: z.string().optional(),
    operation: z.union([z.literal("ask"), z.literal("compact")]),
    compactIndex: z.number().optional(),
    d2FilePath: z.string().min(1).optional(),
    d2MaxIterations: z.number(),
    d2MaxIterationsExplicit: z.boolean(),
    args: z.array(z.string()),
    modelExplicit: z.boolean(),
    effortExplicit: z.boolean(),
    verbosityExplicit: z.boolean(),
    taskModeExplicit: z.boolean(),
    d2FileExplicit: z.boolean(),
    hasExplicitHistory: z.boolean(),
    helpRequested: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (
      value.operation === "compact" &&
      (value.continueConversation ||
        value.resumeListOnly ||
        typeof value.resumeIndex === "number" ||
        typeof value.deleteIndex === "number" ||
        typeof value.showIndex === "number" ||
        value.args.length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Error: --compact と他のフラグは併用できません",
        path: ["operation"],
      });
    }
  });

/**
 * 指定された履歴操作が d2 モードの会話を対象にしているか判定する。
 *
 * @param options 現在のCLIオプション。
 * @param historyStore 履歴ストア。
 * @returns d2会話を扱う必要があればtrue。
 */
function shouldDelegateToD2(
  options: CliOptions,
  historyStore: HistoryStore<DefaultCliHistoryTask>,
): boolean {
  if (options.operation === "compact" && typeof options.compactIndex === "number") {
    const entry = historyStore.selectByNumber(options.compactIndex);
    return entry.task?.mode === "d2";
  }

  if (typeof options.resumeIndex === "number") {
    const entry = historyStore.selectByNumber(options.resumeIndex);
    return entry.task?.mode === "d2";
  }

  if (options.continueConversation && !options.hasExplicitHistory) {
    const latest = historyStore.findLatest();
    return latest?.task?.mode === "d2";
  }

  return false;
}

/**
 * CLI引数を解析し、正規化・検証済みのオプションを返す。
 *
 * @param argv `process.argv`から取得した引数（node部分除外）。
 * @param defaults 環境から取得した既定値。
 * @returns CLI全体で使用するオプション集合。
 */
export function parseArgs(argv: string[], defaults: CliDefaults): CliOptions {
  const program = new Command();

  const parseModelIndex = (value: string): string => {
    switch (value) {
      case "0":
        return defaults.modelNano;
      case "1":
        return defaults.modelMini;
      case "2":
        return defaults.modelMain;
      default:
        throw new InvalidArgumentError("Invalid option: -m には 0/1/2 を続けてください（例: -m1）");
    }
  };

  const parseEffortIndex = (value: string): CliOptions["effort"] => {
    switch (value) {
      case "0":
        return "low";
      case "1":
        return "medium";
      case "2":
        return "high";
      default:
        throw new InvalidArgumentError("Invalid option: -e には 0/1/2 を続けてください（例: -e2）");
    }
  };

  const parseVerbosityIndex = (value: string): CliOptions["verbosity"] => {
    switch (value) {
      case "0":
        return "low";
      case "1":
        return "medium";
      case "2":
        return "high";
      default:
        throw new InvalidArgumentError("Invalid option: -v には 0/1/2 を続けてください（例: -v0）");
    }
  };

  const parseCompactIndex = (value: string): number => {
    if (!/^\d+$/.test(value)) {
      throw new InvalidArgumentError("Error: --compact の履歴番号は正の整数で指定してください");
    }
    return Number.parseInt(value, 10);
  };

  program
    .exitOverride()
    .allowUnknownOption(false)
    .showSuggestionAfterError(false)
    .configureOutput({
      writeErr: (str) => {
        const trimmed = str.replace(/\s+$/u, "");
        if (trimmed.length > 0) {
          console.error(trimmed);
        }
      },
    });

  program.helpOption(false);
  program
    .option("-?, --help", "ヘルプを表示します")
    .option("-m, --model <index>", "モデルを選択 (0/1/2)", parseModelIndex, defaults.modelNano)
    .option("-e, --effort <index>", "effort を選択 (0/1/2)", parseEffortIndex, defaults.effort)
    .option(
      "-v, --verbosity <index>",
      "verbosity を選択 (0/1/2)",
      parseVerbosityIndex,
      defaults.verbosity,
    )
    .option("-c, --continue-conversation", "直前の会話から継続します")
    .option("-r, --resume [index]", "指定した番号の履歴から継続します")
    .option("-d, --delete [index]", "指定した番号の履歴を削除します")
    .option("-s, --show [index]", "指定した番号の履歴を表示します")
    .option("-i, --image <path>", "画像ファイルを添付します")
    .option("--compact <index>", "指定した履歴を要約します", parseCompactIndex);

  program.argument("[input...]", "ユーザー入力");

  const normalizedArgv = expandLegacyShortFlags(argv);

  try {
    program.parse(normalizedArgv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new Error(error.message);
    }
    throw error;
  }

  const opts = program.opts<{
    help?: boolean;
    model: string;
    effort: CliOptions["effort"];
    verbosity: CliOptions["verbosity"];
    continueConversation?: boolean;
    resume?: string | boolean;
    delete?: string | boolean;
    show?: string | boolean;
    image?: string;
    compact?: number;
  }>();

  const args = program.args as string[];

  const model = opts.model ?? defaults.modelNano;
  const effort = opts.effort ?? defaults.effort;
  const verbosity = opts.verbosity ?? defaults.verbosity;
  let continueConversation = Boolean(opts.continueConversation);
  let resumeIndex: number | undefined;
  let resumeListOnly = false;
  let deleteIndex: number | undefined;
  let showIndex: number | undefined;
  let hasExplicitHistory = false;
  const imagePath = opts.image;
  let operation: "ask" | "compact" = "ask";
  let compactIndex: number | undefined;
  const taskMode: CliOptions["taskMode"] = "default";
  const d2FilePath: CliOptions["d2FilePath"] = undefined;
  const d2MaxIterations = defaults.d2MaxIterations;

  const parsedResume = parseHistoryFlag(opts.resume);
  if (parsedResume.listOnly) {
    resumeListOnly = true;
  }
  if (typeof parsedResume.index === "number") {
    resumeIndex = parsedResume.index;
    continueConversation = true;
    hasExplicitHistory = true;
  }

  const parsedDelete = parseHistoryFlag(opts.delete);
  if (parsedDelete.listOnly) {
    resumeListOnly = true;
  }
  if (typeof parsedDelete.index === "number") {
    deleteIndex = parsedDelete.index;
  }

  const parsedShow = parseHistoryFlag(opts.show);
  if (parsedShow.listOnly) {
    resumeListOnly = true;
  }
  if (typeof parsedShow.index === "number") {
    showIndex = parsedShow.index;
  }

  if (typeof opts.compact === "number") {
    operation = "compact";
    compactIndex = opts.compact;
  }

  const modelExplicit = program.getOptionValueSource("model") === "cli";
  const effortExplicit = program.getOptionValueSource("effort") === "cli";
  const verbosityExplicit = program.getOptionValueSource("verbosity") === "cli";
  const taskModeExplicit = false;
  const d2FileExplicit = false;
  const d2MaxIterationsExplicit = false;
  const helpRequested = Boolean(opts.help);

  try {
    return cliOptionsSchema.parse({
      model,
      effort,
      verbosity,
      continueConversation,
      resumeIndex,
      resumeListOnly,
      deleteIndex,
      showIndex,
      imagePath,
      operation,
      compactIndex,
      taskMode,
      d2FilePath,
      args,
      modelExplicit,
      effortExplicit,
      verbosityExplicit,
      taskModeExplicit,
      d2FileExplicit,
      d2MaxIterations,
      d2MaxIterationsExplicit,
      hasExplicitHistory,
      helpRequested,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const firstIssue = error.issues[0];
      throw new Error(firstIssue?.message ?? error.message);
    }
    throw error;
  }
}

/**
 * CLIオプションから次の入力アクションを決定する。
 * 履歴操作が指定されている場合は該当処理を実行して終了する。
 *
 * @param options 解析済みオプション。
 * @param historyStore 履歴管理ストア。
 * @param defaults 既定値セット。
 * @returns 入力テキストまたは終了指示。
 */
/**
 * 履歴とオプションをもとに、今回の対話コンテキストを構築する。
 *
 * @param options CLIオプション（必要に応じて上書きされる）。
 * @param historyStore 履歴ストア。
 * @param inputText 現在のユーザー入力。
 * @param initialActiveEntry 既に選択された履歴エントリ。
 * @param explicitPrevId 明示的に指定されたレスポンスID。
 * @param explicitPrevTitle 明示的に指定されたタイトル。
 * @returns 対話に必要なコンテキスト。
 */
/**
 * CLIエントリーポイント。環境ロードからAPI呼び出しまでを統括する。
 */
async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    const hasD2Indicator = argv.some((arg) => {
      if (arg === "-D" || arg === "--d2-mode") {
        return true;
      }
      if (!arg.startsWith("--")) {
        if (arg.startsWith("-D")) {
          return true;
        }
        if (arg.startsWith("-F") || arg.startsWith("-I")) {
          return true;
        }
      }
      if (arg === "-F" || arg === "-I") {
        return true;
      }
      if (arg === "--d2-file" || arg.startsWith("--d2-file=")) {
        return true;
      }
      if (arg === "--d2-iterations" || arg.startsWith("--d2-iterations=")) {
        return true;
      }
      return false;
    });

    if (hasD2Indicator) {
      const { runD2Cli } = await import("../d2/cli.js");
      await runD2Cli(argv);
      return;
    }

    const bootstrap = bootstrapCli({
      argv,
      logLabel: "[gpt-5-cli]",
      parseArgs,
      printHelp,
      historyTaskSchema: defaultCliHistoryTaskSchema,
    });

    if (bootstrap.status === "help") {
      return;
    }

    const { defaults, options, historyStore, systemPrompt } = bootstrap;
    if (shouldDelegateToD2(options, historyStore)) {
      const { runD2Cli } = await import("../d2/cli.js");
      await runD2Cli(argv);
      return;
    }

    const client = createOpenAIClient();

    if (options.operation === "compact") {
      await performCompact(options, defaults, historyStore, client, "[gpt-5-cli]");
      return;
    }

    const determine = await determineInput(options, historyStore, defaults, {
      printHelp,
    });
    if (determine.kind === "exit") {
      process.exit(determine.code);
      return;
    }

    const context = computeContext(
      options,
      historyStore,
      determine.inputText,
      determine.activeEntry,
      determine.previousResponseId,
      determine.previousTitle,
      {
        logLabel: "[gpt-5-cli]",
        synchronizeWithHistory: ({ options: nextOptions }) => {
          nextOptions.taskMode = "default";
          nextOptions.d2FilePath = undefined;
        },
      },
    );

    const imageInfo = prepareImageData(options.imagePath, "[gpt-5-cli]");
    const request = buildRequest({
      options,
      context,
      inputText: determine.inputText,
      systemPrompt,
      imageDataUrl: imageInfo.dataUrl,
      defaults,
      logLabel: "[gpt-5-cli]",
    });
    const response = await executeWithTools(client, request, options, "[gpt-5-cli]");
    const content = extractResponseText(response);
    if (!content) {
      throw new Error("Error: Failed to parse response or empty content");
    }

    if (response.id) {
      const previousTask = context.activeEntry?.task as DefaultCliHistoryTask | undefined;
      const historyTask = buildDefaultCliHistoryTask(
        {
          taskMode: options.taskMode,
          taskModeExplicit: options.taskModeExplicit,
          d2FilePath: options.d2FilePath,
          d2FileExplicit: options.d2FileExplicit,
        },
        previousTask,
      );
      historyStore.upsertConversation({
        metadata: {
          model: options.model,
          effort: options.effort,
          verbosity: options.verbosity,
        },
        context: {
          isNewConversation: context.isNewConversation,
          titleToUse: context.titleToUse,
          previousResponseId: context.previousResponseId,
          activeLastResponseId: context.activeLastResponseId,
          resumeSummaryText: context.resumeSummaryText,
          resumeSummaryCreatedAt: context.resumeSummaryCreatedAt,
          previousTask,
        },
        responseId: response.id,
        userText: determine.inputText,
        assistantText: content,
        task: historyTask,
      });
    }

    process.stdout.write(`${content}\n`);
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
