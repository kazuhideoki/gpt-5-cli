#!/usr/bin/env bun
// mermaid.ts: Mermaid 図のチェック・修正を行う CLI エントリーポイント。
import fs from "node:fs";
import path from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { z } from "zod";
import type { CliDefaults, CliOptions, OpenAIInputMessage } from "../types.js";
import { createOpenAIClient } from "../pipeline/process/openai-client.js";
import {
  expandLegacyShortFlags,
  parseEffortFlag,
  parseHistoryFlag,
  parseModelFlag,
  parseVerbosityFlag,
} from "../pipeline/input/options.js";
import {
  MERMAID_CHECK_TOOL,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
} from "../pipeline/process/tools/index.js";
import {
  finalizeResult,
  generateDefaultOutputPath,
  buildFileHistoryContext,
} from "../pipeline/finalize/index.js";
import { computeContext } from "../pipeline/process/conversation-context.js";
import { prepareImageData } from "../pipeline/process/image-attachments.js";
import { buildRequest, performCompact } from "../pipeline/process/responses.js";
import { runAgentConversation } from "../pipeline/process/agent-conversation.js";
import { determineInput } from "../pipeline/input/cli-input.js";
import { bootstrapCli } from "../pipeline/input/cli-bootstrap.js";
import { createCliHistoryEntryFilter } from "../pipeline/input/history-filter.js";

/** Mermaidモードの解析済みCLIオプションを表す型。 */
export interface MermaidCliOptions extends CliOptions {
  // TODO 単に filePath にすると、もう少し筋よく整理可能
  mermaidFilePath: string;
  maxIterations: number;
  maxIterationsExplicit: boolean;
}

/**
 * Mermaid ダイアグラム生成時に利用するファイル参照情報。
 */
interface MermaidContextInfo {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
}

const MERMAID_TOOL_REGISTRATIONS = [READ_FILE_TOOL, WRITE_FILE_TOOL, MERMAID_CHECK_TOOL] as const;

const mermaidCliHistoryContextStrictSchema = z.object({
  cli: z.literal("mermaid"),
  output: z
    .object({
      file: z.string(),
      copy: z.boolean().optional(),
    })
    .optional(),
  file_path: z.string().optional(),
});

const mermaidCliHistoryContextSchema = mermaidCliHistoryContextStrictSchema
  .or(z.object({}).passthrough())
  .or(z.null());

export type MermaidCliHistoryContext = z.infer<typeof mermaidCliHistoryContextStrictSchema>;
type MermaidCliHistoryStoreContext = z.infer<typeof mermaidCliHistoryContextSchema>;

function isMermaidHistoryContext(
  value: MermaidCliHistoryStoreContext | undefined,
): value is MermaidCliHistoryContext {
  return (
    !!value &&
    typeof value === "object" &&
    "cli" in value &&
    (value as { cli?: unknown }).cli === "mermaid"
  );
}

/**
 * CLIの利用方法を標準出力に表示する。
 *
 * @param defaults 現在の既定値セット。
 * @param options 解析済みのCLIオプション。
 */
function createMermaidCommand(defaults: CliDefaults): Command {
  const program = new Command();

  const parseCompactIndex = (value: string): number => {
    if (!/^\d+$/.test(value)) {
      throw new InvalidArgumentError("Error: --compact の履歴番号は正の整数で指定してください");
    }
    return Number.parseInt(value, 10);
  };

  const parseIterations = (value: string): number => {
    if (!/^\d+$/u.test(value)) {
      throw new InvalidArgumentError("Error: --iterations の値は正の整数で指定してください");
    }
    const parsed = Number.parseInt(value, 10);
    if (parsed <= 0) {
      throw new InvalidArgumentError("Error: --iterations の値は 1 以上で指定してください");
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

  program.helpOption("-?, --help", "ヘルプを表示します");
  program
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
    .option(
      "-I, --iterations <count>",
      "イテレーション上限を指定します",
      parseIterations,
      defaults.maxIterations,
    )
    .option("--compact <index>", "指定した履歴を要約します", parseCompactIndex);

  program.argument("[input...]", "ユーザー入力");

  return program;
}

function outputHelp(defaults: CliDefaults, _options: MermaidCliOptions): void {
  const program = createMermaidCommand(defaults);
  program.outputHelp();
}

/** CLI全体のオプションを統合的に検証するスキーマ。 */
const cliOptionsSchema: z.ZodType<MermaidCliOptions> = z
  .object({
    model: z.string(),
    effort: z.enum(["low", "medium", "high"]),
    verbosity: z.enum(["low", "medium", "high"]),
    continueConversation: z.boolean(),
    taskMode: z.literal("mermaid"),
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
    mermaidFilePath: z.string().min(1),
    maxIterations: z.number(),
    maxIterationsExplicit: z.boolean(),
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
export function parseArgs(argv: string[], defaults: CliDefaults): MermaidCliOptions {
  const program = createMermaidCommand(defaults);

  const normalizedArgv = expandLegacyShortFlags(argv);
  let helpRequested = false;
  try {
    program.parse(normalizedArgv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed") {
        helpRequested = true;
      } else {
        throw new Error(error.message);
      }
    } else {
      throw error;
    }
  }

  const opts = program.opts<{
    model: string;
    effort: MermaidCliOptions["effort"];
    verbosity: MermaidCliOptions["verbosity"];
    continueConversation?: boolean;
    resume?: string | boolean;
    delete?: string | boolean;
    show?: string | boolean;
    debug?: boolean;
    image?: string;
    output?: string;
    copy?: boolean;
    iterations?: number;
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
  let operation: "ask" | "compact" = "ask";
  let compactIndex: number | undefined;
  const taskMode: MermaidCliOptions["taskMode"] = "mermaid";
  let outputPath = typeof opts.output === "string" ? opts.output.trim() : undefined;
  if (outputPath && outputPath.length === 0) {
    outputPath = undefined;
  }
  const copyOutput = Boolean(opts.copy);
  const maxIterations =
    typeof opts.iterations === "number" ? opts.iterations : defaults.maxIterations;
  if (!outputPath) {
    outputPath = generateDefaultOutputPath({ mode: "mermaid", extension: "mmd" }).relativePath;
  }
  const mermaidFilePath = outputPath;

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
  const maxIterationsExplicit = program.getOptionValueSource("iterations") === "cli";

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
      mermaidFilePath,
      args,
      modelExplicit,
      effortExplicit,
      verbosityExplicit,
      maxIterations,
      maxIterationsExplicit,
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
 * Mermaid モードで使用するファイルパスを検証し、コンテキスト情報を構築する。
 *
 * @param options CLIオプション。
 * @returns Mermaidファイルの存在情報。
 */
function ensureMermaidContext(options: MermaidCliOptions): MermaidContextInfo {
  if (options.taskMode !== "mermaid") {
    throw new Error("Invariant violation: ensureMermaidContext は mermaid モード専用です");
  }
  const cwd = process.cwd();
  const rawPath = options.mermaidFilePath;
  const absolutePath = path.resolve(cwd, rawPath);
  const normalizedRoot = path.resolve(cwd);
  const relative = path.relative(normalizedRoot, absolutePath);
  const isInsideWorkspace =
    relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!isInsideWorkspace) {
    throw new Error(
      `Error: Mermaid出力の保存先はカレントディレクトリ配下に指定してください: ${rawPath}`,
    );
  }
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) {
    throw new Error(`Error: 指定した Mermaid ファイルパスはディレクトリです: ${rawPath}`);
  }
  const relativePath = path.relative(normalizedRoot, absolutePath) || path.basename(absolutePath);
  options.mermaidFilePath = relativePath;
  options.outputPath = relativePath;
  const exists = fs.existsSync(absolutePath);
  return { relativePath, absolutePath, exists };
}

/**
 * Mermaidモード用の追加システムメッセージを生成する。
 *
 * @param mermaidContext 対象ファイルのコンテキスト。
 * @returns Responses APIへ渡すシステムメッセージ配列。
 */
function buildMermaidInstructionMessages(mermaidContext: MermaidContextInfo): OpenAIInputMessage[] {
  const pathHint = mermaidContext.relativePath;
  const existenceNote = mermaidContext.exists
    ? "必要に応じて read_file で既存の内容を確認し、変更範囲を決定してください。"
    : "ファイルが存在しない場合は write_file で新規作成してください。";

  const toolSummary = [
    "- read_file: 指定ファイルを読み取り現在の内容を確認する",
    "- write_file: 指定ファイルを UTF-8 テキストで上書きする（diffは自分で計画する）",
    "- mermaid_check: Mermaid の構文を検証してエラーが無いことを確認する",
  ].join("\n");

  const workflow = [
    "作業手順:",
    `1. ${existenceNote}（Markdown に記述する場合は必ず \`\`\`mermaid\`\`\` ブロック内にコードを書く）`,
    "2. 変更後は必ず mermaid_check を実行し、構文エラーを確認する",
    "3. エラーが続く場合は修正しつつ 2 を繰り返す",
    "4. 最終応答では、日本語で変更内容・ファイルパス・mermaid_check の結果を要約し、Mermaidコード全文は回答に貼らない",
  ].join("\n");

  const systemText = [
    "あなたは Mermaid ダイアグラムを作成・更新するアシスタントです。",
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
async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    const bootstrap = bootstrapCli<MermaidCliOptions, MermaidCliHistoryStoreContext>({
      argv,
      logLabel: "[gpt-5-cli-mermaid]",
      parseArgs,
      historyContextSchema: mermaidCliHistoryContextSchema,
      historyEntryFilter: createCliHistoryEntryFilter("mermaid"),
      envFileSuffix: "mermaid",
    });

    if (bootstrap.status === "help") {
      return;
    }

    const { defaults, options, historyStore, systemPrompt } = bootstrap;
    const client = createOpenAIClient();

    if (options.operation === "compact") {
      await performCompact(options, defaults, historyStore, client, "[gpt-5-cli-mermaid]");
      return;
    }

    const determine = await determineInput(options, historyStore, defaults, {
      printHelp: outputHelp,
    });
    if (determine.kind === "exit") {
      process.exit(determine.code);
      return;
    }

    // TODO(pipeline/input): mermaid モード特有のファイル推論も将来的に input 層へ寄せる。
    const context = computeContext(
      options,
      historyStore,
      determine.inputText,
      determine.activeEntry,
      determine.previousResponseId,
      determine.previousTitle,
      {
        logLabel: "[gpt-5-cli-mermaid]",
        synchronizeWithHistory: ({ options: nextOptions, activeEntry }) => {
          nextOptions.taskMode = "mermaid";
          const historyContext = activeEntry.context as MermaidCliHistoryContext | undefined;

          if (!nextOptions.outputExplicit) {
            const historyFile = historyContext?.file_path ?? historyContext?.output?.file;
            if (historyFile) {
              nextOptions.outputPath = historyFile;
              nextOptions.mermaidFilePath = historyFile;
            }
          }
          if (!nextOptions.copyExplicit && typeof historyContext?.output?.copy === "boolean") {
            nextOptions.copyOutput = historyContext.output.copy;
          }
        },
      },
    );

    const mermaidContext = ensureMermaidContext(options);

    const imageDataUrl = prepareImageData(options.imagePath, "[gpt-5-cli-mermaid]");
    const request = buildRequest({
      options,
      context,
      inputText: determine.inputText,
      systemPrompt,
      imageDataUrl,
      defaults,
      logLabel: "[gpt-5-cli-mermaid]",
      additionalSystemMessages: buildMermaidInstructionMessages(mermaidContext),
    });
    const agentResult = await runAgentConversation({
      client,
      request,
      options,
      logLabel: "[gpt-5-cli-mermaid]",
      toolRegistrations: MERMAID_TOOL_REGISTRATIONS,
      maxTurns: options.maxIterations,
    });
    const content = agentResult.assistantText;
    if (!content) {
      throw new Error("Error: Failed to parse response or empty content");
    }

    const summaryOutputPath =
      options.outputExplicit && options.outputPath && options.outputPath !== options.mermaidFilePath
        ? options.outputPath
        : undefined;

    const previousContextRaw = context.activeEntry?.context as
      | MermaidCliHistoryStoreContext
      | undefined;
    const previousContext = isMermaidHistoryContext(previousContextRaw)
      ? previousContextRaw
      : undefined;
    const historyContext = buildFileHistoryContext<MermaidCliHistoryContext>({
      base: { cli: "mermaid" },
      contextPath: mermaidContext.absolutePath,
      defaultFilePath: options.mermaidFilePath,
      previousContext,
      historyOutputFile: summaryOutputPath ?? options.mermaidFilePath,
      copyOutput: options.copyOutput,
    });
    const finalizeOutcome = await finalizeResult<MermaidCliHistoryStoreContext>({
      content,
      userText: determine.inputText,
      summaryOutputPath,
      copyOutput: options.copyOutput,
      copySourceFilePath: options.mermaidFilePath,
      history: agentResult.responseId
        ? {
            responseId: agentResult.responseId,
            store: historyStore,
            conversation: context,
            metadata: {
              model: options.model,
              effort: options.effort,
              verbosity: options.verbosity,
            },
            previousContextRaw,
            contextData: historyContext,
          }
        : undefined,
    });

    const artifactAbsolutePath = mermaidContext.absolutePath;
    if (fs.existsSync(artifactAbsolutePath)) {
      console.log(`[gpt-5-cli-mermaid] output file: ${options.mermaidFilePath}`);
    }

    process.stdout.write(`${finalizeOutcome.stdout}\n`);
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
