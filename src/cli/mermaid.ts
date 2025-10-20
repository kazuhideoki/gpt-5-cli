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
  handleResult,
  generateDefaultOutputPath,
  type FinalizeDeliveryInstruction,
  type FinalizeHistoryEffect,
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
function printHelp(defaults: CliDefaults, options: MermaidCliOptions): void {
  console.log("Usage:");
  console.log("  gpt-5-cli-mermaid [-i <image>] [flag] <input>");
  console.log("  gpt-5-cli-mermaid --compact <num>");
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
  console.log("");
  console.log(
    "  -i <image>   : 入力に画像を添付（$HOME 配下のフルパスまたは 'スクリーンショット *.png'）",
  );
  console.log("  -o, --output <path> : 結果を指定ファイルに保存");
  console.log("  --copy      : 結果をクリップボードにコピー");
  console.log("  -I <count>  : Mermaidモード時のツール呼び出し上限 (--mermaid-iterations)");
  console.log(
    "  ※ `.mmd` など純粋な Mermaid ファイルを推奨。Markdown に埋め込む場合は必ず ```mermaid``` ブロック内に記述してください。",
  );
  console.log("");
  console.log("環境変数(.env):");
  console.log(
    "  GPT_5_CLI_HISTORY_INDEX_FILE : 履歴ファイルの保存先（例: ~/Library/Mobile Documents/com~apple~CloudDocs/gpt-5-cli/history_index.json）",
  );
  console.log(
    "  GPT_5_CLI_PROMPTS_DIR        : systemプロンプトテンプレートの配置ディレクトリ（例: ~/Library/Application Support/gpt-5-cli/prompts）",
  );
  console.log(
    `  GPT_5_CLI_MAX_ITERATIONS     : エージェントのツール呼び出し上限（正の整数、既定: ${defaults.maxIterations})`,
  );
  console.log("");
  console.log(
    `既定: model=${defaults.modelNano}, effort=${options.effort}, verbosity=${options.verbosity}（フラグ未指定時）`,
  );
  console.log("");
  console.log("例:");
  console.log(
    "  gpt-5-cli-mermaid -m1e2v2 もっと詳しく -> model=gpt-5-mini(m1), effort=high(e2), verbosity=high(v2)",
  );
  console.log(
    "  gpt-5-cli-mermaid -m0e0v0 箇条書きで   -> model=gpt-5-nano(m0), effort=low(e0), verbosity=low(v0)",
  );
  console.log("  gpt-5-cli-mermaid -r                 -> 履歴一覧のみ表示して終了");
  console.log("  gpt-5-cli-mermaid -r2 続きをやろう   -> 2番目の履歴を使って継続");
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
  const program = new Command();

  /** `--compact` フラグの文字列値を履歴番号として検証する。 */
  const parseCompactIndex = (value: string): number => {
    if (!/^\d+$/.test(value)) {
      throw new InvalidArgumentError("Error: --compact の履歴番号は正の整数で指定してください");
    }
    return Number.parseInt(value, 10);
  };

  /** Mermaidモードのツール呼び出し上限値を検証し、正の整数として解釈する。 */
  const parseMermaidIterations = (value: string): number => {
    if (!/^\d+$/u.test(value)) {
      throw new InvalidArgumentError(
        "Error: --mermaid-iterations の値は正の整数で指定してください",
      );
    }
    const parsed = Number.parseInt(value, 10);
    if (parsed <= 0) {
      throw new InvalidArgumentError("Error: --mermaid-iterations の値は 1 以上で指定してください");
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
    .option("--debug", "デバッグログを有効化します")
    .option("-i, --image <path>", "画像ファイルを添付します")
    .option("-o, --output <path>", "結果を保存するファイルパスを指定します")
    .option("--copy", "結果をクリップボードにコピーします")
    .option(
      "-I, --mermaid-iterations <count>",
      "Mermaidモード時のツール呼び出し上限を指定します",
      parseMermaidIterations,
      defaults.maxIterations,
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
    mermaidIterations?: number;
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
    typeof opts.mermaidIterations === "number" ? opts.mermaidIterations : defaults.maxIterations;
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
  const maxIterationsExplicit = program.getOptionValueSource("mermaidIterations") === "cli";
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
 * @returns Mermaidファイルの存在情報。非Mermaidモード時はundefined。
 */
function ensureMermaidContext(options: MermaidCliOptions): MermaidContextInfo | undefined {
  if (options.taskMode !== "mermaid") {
    return undefined;
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
export async function runMermaidCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    const bootstrap = bootstrapCli<MermaidCliOptions, MermaidCliHistoryStoreContext>({
      argv,
      logLabel: "[gpt-5-cli-mermaid]",
      parseArgs,
      historyContextSchema: mermaidCliHistoryContextSchema,
      historyEntryFilter: createCliHistoryEntryFilter("mermaid"),
      envFileSuffix: "mermaid",
    });

    if (bootstrap.status === "help") {
      printHelp(bootstrap.defaults, bootstrap.options);
      return;
    }

    const { defaults, options, historyStore, systemPrompt } = bootstrap;
    const client = createOpenAIClient();

    if (options.operation === "compact") {
      await performCompact(options, defaults, historyStore, client, "[gpt-5-cli-mermaid]");
      return;
    }

    const determine = await determineInput(options, historyStore, defaults, {
      printHelp,
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
      additionalSystemMessages:
        options.taskMode === "mermaid" && mermaidContext
          ? buildMermaidInstructionMessages(mermaidContext)
          : undefined,
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

    let finalizeHistoryEffect: FinalizeHistoryEffect | undefined;
    if (agentResult.responseId) {
      const responseId = agentResult.responseId;
      const previousContextRaw = context.activeEntry?.context as
        | MermaidCliHistoryStoreContext
        | undefined;
      const previousContext = isMermaidHistoryContext(previousContextRaw)
        ? previousContextRaw
        : undefined;
      const historyContext: MermaidCliHistoryContext = { cli: "mermaid" };
      const contextPath = mermaidContext?.absolutePath;
      const filePath = contextPath ?? options.mermaidFilePath ?? previousContext?.file_path;
      if (contextPath) {
        historyContext.file_path = contextPath;
      } else if (filePath) {
        historyContext.file_path = filePath;
      }
      const historyOutputFile = summaryOutputPath ?? options.mermaidFilePath;
      if (historyOutputFile || options.copyOutput) {
        historyContext.output = { file: historyOutputFile };
        if (options.copyOutput) {
          historyContext.output.copy = true;
        }
      }
      finalizeHistoryEffect = {
        run: () =>
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
              previousContext: previousContextRaw,
            },
            responseId,
            userText: determine.inputText,
            assistantText: content,
            contextData: historyContext,
          }),
      };
    }

    const hasSummaryOutputPath = typeof summaryOutputPath === "string";
    const finalizeOutputInstruction =
      hasSummaryOutputPath || options.copyOutput
        ? ({
            params: {
              ...(hasSummaryOutputPath ? { filePath: summaryOutputPath! } : {}),
              ...(options.copyOutput
                ? {
                    copy: true,
                    ...(options.mermaidFilePath
                      ? {
                          copySource: {
                            type: "file" as const,
                            filePath: options.mermaidFilePath,
                          },
                        }
                      : {}),
                  }
                : {}),
            },
          } satisfies FinalizeDeliveryInstruction)
        : undefined;

    const finalizeOutcome = await handleResult({
      content,
      output: finalizeOutputInstruction,
      history: finalizeHistoryEffect,
    });

    const artifactAbsolutePath =
      mermaidContext?.absolutePath ?? path.resolve(process.cwd(), options.mermaidFilePath);
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
  await runMermaidCli();
}
