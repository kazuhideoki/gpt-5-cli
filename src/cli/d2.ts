#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { z } from "zod";
import type { CliDefaults, D2CliOptions, OpenAIInputMessage } from "./default-types.js";
import { createOpenAIClient } from "../core/openai.js";
import {
  expandLegacyShortFlags,
  parseEffortFlag,
  parseHistoryFlag,
  parseModelFlag,
  parseVerbosityFlag,
} from "../core/options.js";
import {
  buildRequest,
  computeContext,
  executeWithTools,
  extractResponseText,
  performCompact,
  prepareImageData,
} from "../commands/conversation.js";
import { determineInput } from "./shared/input.js";
import { bootstrapCli } from "./shared/runner.js";

/**
 * d2ダイアグラム生成時に利用するファイル参照情報。
 */
interface D2ContextInfo {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
}

export const d2CliHistoryTaskSchema = z.object({
  mode: z.string().optional(),
  d2: z
    .object({
      file_path: z.string().optional(),
    })
    .optional(),
});

export type D2CliHistoryTask = z.infer<typeof d2CliHistoryTaskSchema>;

interface D2CliHistoryD2Context {
  absolutePath?: string;
}

interface D2CliHistoryTaskOptions {
  taskMode: D2CliOptions["taskMode"];
  taskModeExplicit: boolean;
  d2FilePath?: string;
  d2FileExplicit: boolean;
}

function buildD2CliHistoryTask(
  options: D2CliHistoryTaskOptions,
  previousTask?: D2CliHistoryTask,
  d2Context?: D2CliHistoryD2Context,
): D2CliHistoryTask | undefined {
  if (options.taskMode === "d2") {
    const task: D2CliHistoryTask = { mode: "d2" };
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
function printHelp(defaults: CliDefaults, options: D2CliOptions): void {
  console.log("Usage:");
  console.log("  gpt-5-cli-d2 [-i <image>] [flag] <input>");
  console.log("  gpt-5-cli-d2 --compact <num>");
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
  console.log("  -D          : d2モードを明示（互換フラグ） (--d2-mode)");
  console.log("  -F <path>   : d2出力ファイルパスを指定 (--d2-file)");
  console.log("  -I <count>  : d2モード時のツール呼び出し上限 (--d2-iterations)");
  console.log("");
  console.log("環境変数(.env):");
  console.log(
    "  GPT_5_CLI_HISTORY_INDEX_FILE : 履歴ファイルの保存先（例: ~/Library/Mobile Documents/com~apple~CloudDocs/gpt-5-cli/history_index.json）",
  );
  console.log(
    "  GPT_5_CLI_PROMPTS_DIR        : systemプロンプトテンプレートの配置ディレクトリ（例: ~/Library/Application Support/gpt-5-cli/prompts）",
  );
  console.log(
    `  GPT_5_CLI_D2_MAX_ITERATIONS  : d2モードのツール呼び出し上限（正の整数、既定: ${defaults.d2MaxIterations})`,
  );
  console.log("");
  console.log(
    `既定: model=${defaults.modelNano}, effort=${options.effort}, verbosity=${options.verbosity}（フラグ未指定時）`,
  );
  console.log("");
  console.log("例:");
  console.log(
    "  gpt-5-cli-d2 -m1e2v2 もっと詳しく -> model=gpt-5-mini(m1), effort=high(e2), verbosity=high(v2)",
  );
  console.log(
    "  gpt-5-cli-d2 -m0e0v0 箇条書きで   -> model=gpt-5-nano(m0), effort=low(e0), verbosity=low(v0)",
  );
  console.log("  gpt-5-cli-d2 -r                 -> 履歴一覧のみ表示して終了");
  console.log("  gpt-5-cli-d2 -r2 続きをやろう   -> 2番目の履歴を使って継続");
}

/** CLI全体のオプションを統合的に検証するスキーマ。 */
const cliOptionsSchema: z.ZodType<D2CliOptions> = z
  .object({
    model: z.string(),
    effort: z.enum(["low", "medium", "high"]),
    verbosity: z.enum(["low", "medium", "high"]),
    continueConversation: z.boolean(),
    taskMode: z.literal("d2"),
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
 * CLI引数を解析し、正規化・検証済みのオプションを返す。
 *
 * @param argv `process.argv`から取得した引数（node部分除外）。
 * @param defaults 環境から取得した既定値。
 * @returns CLI全体で使用するオプション集合。
 */
export function parseArgs(argv: string[], defaults: CliDefaults): D2CliOptions {
  const program = new Command();

  const parseCompactIndex = (value: string): number => {
    if (!/^\d+$/.test(value)) {
      throw new InvalidArgumentError("Error: --compact の履歴番号は正の整数で指定してください");
    }
    return Number.parseInt(value, 10);
  };

  const parseD2Iterations = (value: string): number => {
    if (!/^\d+$/u.test(value)) {
      throw new InvalidArgumentError("Error: --d2-iterations の値は正の整数で指定してください");
    }
    const parsed = Number.parseInt(value, 10);
    if (parsed <= 0) {
      throw new InvalidArgumentError("Error: --d2-iterations の値は 1 以上で指定してください");
    }
    return parsed;
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
    .option("-i, --image <path>", "画像ファイルを添付します")
    .option("-D, --d2-mode", "d2形式の生成モードを有効にします")
    .option("-F, --d2-file <path>", "d2出力を保存するファイルパスを指定します")
    .option(
      "-I, --d2-iterations <count>",
      "d2モード時のツール呼び出し上限を指定します",
      parseD2Iterations,
      defaults.d2MaxIterations,
    )
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
    effort: D2CliOptions["effort"];
    verbosity: D2CliOptions["verbosity"];
    continueConversation?: boolean;
    resume?: string | boolean;
    delete?: string | boolean;
    show?: string | boolean;
    image?: string;
    d2Mode?: boolean;
    d2File?: string;
    d2Iterations?: number;
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
  const taskMode: D2CliOptions["taskMode"] = "d2";
  const d2FilePath =
    typeof opts.d2File === "string" && opts.d2File.length > 0 ? opts.d2File : undefined;
  const d2MaxIterations =
    typeof opts.d2Iterations === "number" ? opts.d2Iterations : defaults.d2MaxIterations;

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
  const taskModeExplicit = program.getOptionValueSource("d2Mode") === "cli";
  const d2FileExplicit = program.getOptionValueSource("d2File") === "cli";
  const d2MaxIterationsExplicit = program.getOptionValueSource("d2Iterations") === "cli";
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
 * d2モードで使用するファイルパスを検証し、コンテキスト情報を構築する。
 *
 * @param options CLIオプション。
 * @returns d2ファイルの存在情報。非d2モード時はundefined。
 */
function ensureD2Context(options: D2CliOptions): D2ContextInfo | undefined {
  if (options.taskMode !== "d2") {
    return undefined;
  }
  const cwd = process.cwd();
  const rawPath =
    options.d2FilePath && options.d2FilePath.trim().length > 0 ? options.d2FilePath : "diagram.d2";
  const absolutePath = path.resolve(cwd, rawPath);
  const normalizedRoot = path.resolve(cwd);
  if (!absolutePath.startsWith(`${normalizedRoot}${path.sep}`) && absolutePath !== normalizedRoot) {
    throw new Error(
      `Error: d2出力の保存先はカレントディレクトリ配下に指定してください: ${rawPath}`,
    );
  }
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) {
    throw new Error(`Error: 指定した d2 ファイルパスはディレクトリです: ${rawPath}`);
  }
  const relativePath = path.relative(normalizedRoot, absolutePath) || path.basename(absolutePath);
  options.d2FilePath = relativePath;
  const exists = fs.existsSync(absolutePath);
  return { relativePath, absolutePath, exists };
}

/**
 * d2モード用の追加システムメッセージを生成する。
 *
 * @param d2Context 対象ファイルのコンテキスト。
 * @returns Responses APIへ渡すシステムメッセージ配列。
 */
function buildD2InstructionMessages(d2Context: D2ContextInfo): OpenAIInputMessage[] {
  const pathHint = d2Context.relativePath;
  const existenceNote = d2Context.exists
    ? "必要に応じて read_file で既存の内容を確認し、変更範囲を決定してください。"
    : "ファイルが存在しない場合は write_file で新規作成してください。";

  const toolSummary = [
    "- read_file: 指定ファイルを読み取り現在の内容を確認する",
    "- write_file: 指定ファイルを UTF-8 テキストで上書きする（diffは自分で計画する）",
    "- d2_check: D2の構文を検証してエラーが無いことを確認する",
    "- d2_fmt: D2ファイルを整形してフォーマットを揃える",
  ].join("\n");

  const workflow = [
    "作業手順:",
    `1. ${existenceNote}`,
    "2. 変更後は必ず d2_check を実行し、構文エラーを確認する",
    "3. エラーが無いことを確認したら d2_fmt を実行し、整形結果を確認する",
    "4. エラーが続く場合は修正しつつ 2〜3 を繰り返す",
    "5. 最終応答では、日本語で変更内容・ファイルパス・d2_check/d2_fmt の結果を要約し、D2コード全文は回答に貼らない",
  ].join("\n");

  const systemText = [
    "あなたは D2 ダイアグラムを作成・更新するアシスタントです。",
    "ローカルワークスペース内のファイルのみ操作し、許可されたツール以外は使用しないでください。",
    `対象ファイル: ${pathHint}`,
    toolSummary,
    workflow,
  ].join("\n\n");

  return [
    {
      role: "system",
      content: [{ type: "input_text", text: systemText }],
    },
  ];
}

/**
 * CLIエントリーポイント。環境ロードからAPI呼び出しまでを統括する。
 */
export async function runD2Cli(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    const bootstrap = bootstrapCli({
      argv,
      logLabel: "[gpt-5-cli-d2]",
      parseArgs,
      printHelp,
      historyTaskSchema: d2CliHistoryTaskSchema,
    });

    if (bootstrap.status === "help") {
      return;
    }

    const { defaults, options, historyStore, systemPrompt } = bootstrap;
    const client = createOpenAIClient();

    if (options.operation === "compact") {
      await performCompact(options, defaults, historyStore, client, "[gpt-5-cli-d2]");
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
        logLabel: "[gpt-5-cli-d2]",
        synchronizeWithHistory: ({ options: nextOptions, activeEntry, logWarning }) => {
          if (!nextOptions.taskModeExplicit) {
            const historyMode = activeEntry.task?.mode;
            if (historyMode && historyMode !== "d2") {
              logWarning("warn: 選択した履歴は d2 モードではありません (新規開始)");
            }
            nextOptions.taskMode = "d2";
          }

          if (!nextOptions.d2FileExplicit) {
            const historyFile = activeEntry.task?.d2?.file_path;
            nextOptions.d2FilePath = historyFile ?? nextOptions.d2FilePath;
          }
        },
      },
    );

    const d2Context = ensureD2Context(options);

    const imageInfo = prepareImageData(options.imagePath, "[gpt-5-cli-d2]");
    const request = buildRequest({
      options,
      context,
      inputText: determine.inputText,
      systemPrompt,
      imageDataUrl: imageInfo.dataUrl,
      defaults,
      logLabel: "[gpt-5-cli-d2]",
      additionalSystemMessages:
        options.taskMode === "d2" && d2Context ? buildD2InstructionMessages(d2Context) : undefined,
    });
    const response = await executeWithTools(client, request, options, "[gpt-5-cli-d2]");
    const content = extractResponseText(response);
    if (!content) {
      throw new Error("Error: Failed to parse response or empty content");
    }

    if (response.id) {
      const previousTask = context.activeEntry?.task as D2CliHistoryTask | undefined;
      const historyTask = buildD2CliHistoryTask(
        {
          taskMode: options.taskMode,
          taskModeExplicit: options.taskModeExplicit,
          d2FilePath: options.d2FilePath,
          d2FileExplicit: options.d2FileExplicit,
        },
        previousTask,
        d2Context ? { absolutePath: d2Context.absolutePath } : undefined,
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
  await runD2Cli();
}
