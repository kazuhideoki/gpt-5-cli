#!/usr/bin/env bun
// ask.ts: 一問一答型の標準チャット CLI エントリーポイント。
import type { Tool as AgentsSdkTool } from "@openai/agents";
import { webSearchTool } from "@openai/agents-openai";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { z } from "zod";
import type { CliDefaults, CliOptions } from "../core/types.js";
import { createOpenAIClient } from "../session/openai-client.js";
import {
  expandLegacyShortFlags,
  parseEffortFlag,
  parseHistoryFlag,
  parseModelFlag,
  parseVerbosityFlag,
} from "../core/options.js";
import { deliverOutput } from "../core/output.js";
import { READ_FILE_TOOL, buildCliToolList } from "../core/tools.js";
import { computeContext } from "../session/conversation-context.js";
import { prepareImageData } from "../session/image-attachments.js";
import { buildRequest, performCompact } from "../session/responses-session.js";
import { runAgentConversation } from "../session/agent-session.js";
import { determineInput } from "./runtime/input.js";
import { bootstrapCli } from "./runtime/runner.js";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";

const askCliHistoryTaskSchema = z.object({
  mode: z.string().optional(),
  output: z
    .object({
      file: z.string().optional(),
      copy: z.boolean().optional(),
    })
    .optional(),
});

export type AskCliHistoryTask = z.infer<typeof askCliHistoryTaskSchema>;

const ASK_TOOL_REGISTRATIONS = [READ_FILE_TOOL] as const;

export function buildAskResponseTools(): ResponseCreateParamsNonStreaming["tools"] {
  const tools = buildCliToolList(ASK_TOOL_REGISTRATIONS) ?? [];
  return tools.filter((tool) => tool.type !== "web_search_preview");
}

export function createAskWebSearchTool(): AgentsSdkTool {
  return webSearchTool({
    name: "web_search",
    searchContextSize: "medium",
  });
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
  console.log("  --debug     : デバッグログを有効化");
  console.log("  -o, --output <path> : 結果を指定ファイルに保存");
  console.log("  --copy      : 結果をクリップボードにコピー");
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
    taskMode: z.literal("ask"),
    resumeIndex: z.number().optional(),
    resumeListOnly: z.boolean(),
    deleteIndex: z.number().optional(),
    showIndex: z.number().optional(),
    imagePath: z.string().optional(),
    debug: z.boolean(),
    outputPath: z.string().min(1).optional(),
    outputExplicit: z.boolean(),
    copyOutput: z.boolean(),
    copyExplicit: z.boolean(),
    operation: z.union([z.literal("ask"), z.literal("compact")]),
    compactIndex: z.number().optional(),
    args: z.array(z.string()),
    modelExplicit: z.boolean(),
    effortExplicit: z.boolean(),
    verbosityExplicit: z.boolean(),
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
 * CLI引数を解析し、正規化・検証済みのオプションを返す。
 *
 * @param argv `process.argv`から取得した引数（node部分除外）。
 * @param defaults 環境から取得した既定値。
 * @returns CLI全体で使用するオプション集合。
 */
export function parseArgs(argv: string[], defaults: CliDefaults): CliOptions {
  const program = new Command();

  /** `--compact` フラグの文字列値を履歴番号として検証する。 */
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
    .option(
      "-m, --model <index>",
      "モデルを選択 (0/1/2)",
      (value) => parseModelFlag(value, defaults),
      defaults.modelNano,
    )
    .option("-e, --effort <index>", "effort を選択 (0/1/2)", parseEffortFlag, defaults.effort)
    .option(
      "-v, --verbosity <index>",
      "verbosity を選択 (0/1/2)",
      parseVerbosityFlag,
      defaults.verbosity,
    )
    .option("-c, --continue-conversation", "直前の会話から継続します")
    .option("-r, --resume [index]", "指定した番号の履歴から継続します")
    .option("-d, --delete [index]", "指定した番号の履歴を削除します")
    .option("-s, --show [index]", "指定した番号の履歴を表示します")
    .option("--debug", "デバッグログを有効化します")
    .option("-i, --image <path>", "画像ファイルを添付します")
    .option("-o, --output <path>", "結果を保存するファイルパスを指定します")
    .option("--copy", "結果をクリップボードにコピーします")
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
    debug?: boolean;
    output?: string;
    copy?: boolean;
    image?: string;
    compact?: number;
  }>();

  const args = program.args as string[];

  const model = opts.model ?? defaults.modelNano;
  const effort = opts.effort ?? defaults.effort;
  const verbosity = opts.verbosity ?? defaults.verbosity;
  const debug = Boolean(opts.debug);
  let continueConversation = Boolean(opts.continueConversation);
  let resumeIndex: number | undefined;
  let resumeListOnly = false;
  let deleteIndex: number | undefined;
  let showIndex: number | undefined;
  let hasExplicitHistory = false;
  const imagePath = opts.image;
  let outputPath = typeof opts.output === "string" ? opts.output.trim() : undefined;
  if (outputPath && outputPath.length === 0) {
    outputPath = undefined;
  }
  const copyOutput = Boolean(opts.copy);
  let operation: "ask" | "compact" = "ask";
  let compactIndex: number | undefined;
  const taskMode: CliOptions["taskMode"] = "ask";

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
  const outputExplicit = program.getOptionValueSource("output") === "cli";
  const copyExplicit = program.getOptionValueSource("copy") === "cli";
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
      debug,
      outputPath,
      outputExplicit,
      copyOutput,
      copyExplicit,
      operation,
      compactIndex,
      taskMode,
      args,
      modelExplicit,
      effortExplicit,
      verbosityExplicit,
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
 * ask CLI のメイン処理。環境初期化からAPI呼び出し・履歴更新までを統括する。
 */
async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);

    const bootstrap = bootstrapCli({
      argv,
      logLabel: "[gpt-5-cli]",
      parseArgs,
      historyTaskSchema: askCliHistoryTaskSchema,
      envFileSuffix: "ask",
    });

    if (bootstrap.status === "help") {
      printHelp(bootstrap.defaults, bootstrap.options);
      return;
    }

    const { defaults, options, historyStore, systemPrompt } = bootstrap;

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
        synchronizeWithHistory: ({ options: nextOptions, activeEntry }) => {
          nextOptions.taskMode = "ask";
          const historyTask = activeEntry.task as AskCliHistoryTask | undefined;
          if (!nextOptions.outputExplicit && historyTask?.output?.file) {
            nextOptions.outputPath = historyTask.output.file;
          }
          if (!nextOptions.copyExplicit && typeof historyTask?.output?.copy === "boolean") {
            nextOptions.copyOutput = historyTask.output.copy;
          }
        },
      },
    );

    const imageDataUrl = prepareImageData(options.imagePath, "[gpt-5-cli]");
    const request = buildRequest({
      options,
      context,
      inputText: determine.inputText,
      systemPrompt,
      imageDataUrl,
      defaults,
      logLabel: "[gpt-5-cli]",
      tools: buildAskResponseTools(),
    });
    const agentResult = await runAgentConversation({
      client,
      request,
      options,
      logLabel: "[gpt-5-cli]",
      toolRegistrations: ASK_TOOL_REGISTRATIONS,
      maxTurns: defaults.maxIterations,
      additionalAgentTools: [createAskWebSearchTool()],
    });
    const content = agentResult.assistantText;
    if (!content) {
      throw new Error("Error: Failed to parse response or empty content");
    }

    await deliverOutput({
      content,
      filePath: options.outputPath,
      copy: options.copyOutput,
    });

    if (agentResult.responseId) {
      const previousTask = context.activeEntry?.task as AskCliHistoryTask | undefined;
      const historyTask: AskCliHistoryTask = {
        ...(previousTask ?? {}),
        mode: options.taskMode,
      };
      const historyOutputFile = options.outputPath ?? previousTask?.output?.file;
      const historyOutputCopy = options.copyOutput ? true : undefined;
      if (historyOutputFile || historyOutputCopy) {
        historyTask.output = {
          file: historyOutputFile,
          copy: historyOutputCopy,
        };
      } else if (historyTask.output) {
        delete historyTask.output;
      }
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
        responseId: agentResult.responseId,
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
