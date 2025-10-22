#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import type { Tool as AgentsSdkTool } from "@openai/agents";
import { webSearchTool } from "@openai/agents-openai";
import { InvalidArgumentError } from "commander";
import { z } from "zod";
import type { CliDefaults, CliOptions, OpenAIInputMessage } from "../types.js";
import { createOpenAIClient } from "../pipeline/process/openai-client.js";
import {
  D2_CHECK_TOOL,
  D2_FMT_TOOL,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  buildCliToolList,
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
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { buildCommonCommand, parseCommonOptions } from "./common/common-cli.js";

/** d2モードの解析済みCLIオプションを表す型。 */
export interface D2CliOptions extends CliOptions {
  filePath: string;
  maxIterations: number;
  maxIterationsExplicit: boolean;
}

/**
 * d2ダイアグラム生成時に利用するファイル参照情報。
 */
interface D2ContextInfo {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
}

const D2_TOOL_REGISTRATIONS = [
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  D2_CHECK_TOOL,
  D2_FMT_TOOL,
] as const;

const D2_WEB_SEARCH_ALLOWED_DOMAINS = ["d2lang.com"] as const;
const D2_TOUR_URL = "https://d2lang.com/tour";

/**
 * d2 モードで利用する web_search ツール定義を生成する。
 */
export function createD2WebSearchTool(): AgentsSdkTool {
  return webSearchTool({
    filters: { allowedDomains: [...D2_WEB_SEARCH_ALLOWED_DOMAINS] },
    searchContextSize: "medium",
    name: "web_search",
  });
}

/**
 * d2 モードで Responses API へ渡すツール配列を生成する。
 */
export function buildD2ResponseTools(): ResponseCreateParamsNonStreaming["tools"] {
  const tools = buildCliToolList(D2_TOOL_REGISTRATIONS) ?? [];
  return tools.filter((tool) => tool.type !== "web_search_preview");
}

const d2CliHistoryContextStrictSchema = z.object({
  cli: z.literal("d2"),
  output: z
    .object({
      file: z.string(),
      copy: z.boolean().optional(),
    })
    .optional(),
  file_path: z.string().optional(),
});

const d2CliHistoryContextSchema = d2CliHistoryContextStrictSchema
  .or(z.object({}).passthrough())
  .or(z.null());

export type D2CliHistoryContext = z.infer<typeof d2CliHistoryContextStrictSchema>;
type D2CliHistoryStoreContext = z.infer<typeof d2CliHistoryContextSchema>;

function isD2HistoryContext(
  value: D2CliHistoryStoreContext | undefined,
): value is D2CliHistoryContext {
  return (
    !!value &&
    typeof value === "object" &&
    "cli" in value &&
    (value as { cli?: unknown }).cli === "d2"
  );
}

/**
 * CLIの利用方法を標準出力に表示する。
 *
 * @param defaults 現在の既定値セット。
 * @param options 解析済みのCLIオプション。
 */
function createD2Program(defaults: CliDefaults) {
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

  return buildCommonCommand({
    defaults,
    mode: "d2",
    argument: { tokens: "[input...]", description: "ユーザー入力" },
    extraOptionRegistrars: [
      (program) =>
        program.option(
          "-I, --iterations <count>",
          "イテレーション上限を指定します",
          parseIterations,
          defaults.maxIterations,
        ),
    ],
  });
}

function outputHelp(defaults: CliDefaults, _options: D2CliOptions): void {
  const program = createD2Program(defaults);
  program.outputHelp();
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
    debug: z.boolean(),
    outputPath: z.string().min(1).optional(),
    outputExplicit: z.boolean(),
    copyOutput: z.boolean(),
    copyExplicit: z.boolean(),
    operation: z.union([z.literal("ask"), z.literal("compact")]),
    compactIndex: z.number().optional(),
    filePath: z.string().min(1),
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
export function parseArgs(argv: string[], defaults: CliDefaults): D2CliOptions {
  const program = createD2Program(defaults);
  const { options: commonOptions } = parseCommonOptions(argv, defaults, program);
  const programOptions = program.opts<{ iterations?: number }>();
  const resolvedOutputPath =
    commonOptions.outputPath ??
    generateDefaultOutputPath({ mode: "d2", extension: "d2" }).relativePath;
  const maxIterations = programOptions.iterations ?? defaults.maxIterations;
  const maxIterationsExplicit = program.getOptionValueSource("iterations") === "cli";
  try {
    return cliOptionsSchema.parse({
      ...commonOptions,
      taskMode: "d2",
      outputPath: resolvedOutputPath,
      filePath: resolvedOutputPath,
      maxIterations,
      maxIterationsExplicit,
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
 * @returns d2ファイルの存在情報。
 */
function ensureD2Context(options: D2CliOptions): D2ContextInfo {
  if (options.taskMode !== "d2") {
    throw new Error("Invariant violation: ensureD2Context は d2 モード専用です");
  }
  const cwd = process.cwd();
  const rawPath = options.filePath;
  const absolutePath = path.resolve(cwd, rawPath);
  const normalizedRoot = path.resolve(cwd);
  const relative = path.relative(normalizedRoot, absolutePath);
  const isInsideWorkspace =
    relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!isInsideWorkspace) {
    throw new Error(
      `Error: d2出力の保存先はカレントディレクトリ配下に指定してください: ${rawPath}`,
    );
  }
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) {
    throw new Error(`Error: 指定した d2 ファイルパスはディレクトリです: ${rawPath}`);
  }
  const relativePath = path.relative(normalizedRoot, absolutePath) || path.basename(absolutePath);
  options.filePath = relativePath;
  options.outputPath = relativePath;
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
    "- web_search: d2lang.com/tour の公式ドキュメントを検索し参照する",
  ].join("\n");

  const workflow = [
    "作業手順:",
    `1. ${existenceNote}`,
    "2. 変更後は必ず d2_check を実行し、構文エラーを確認する",
    "3. エラーが無いことを確認したら d2_fmt を実行し、整形結果を確認する",
    "4. オンライン情報が必要な場合は web_search で d2lang.com/tour の内容のみを確認する",
    "5. エラーが続く場合は修正しつつ 2〜4 を繰り返す",
    "6. 最終応答では、日本語で変更内容・ファイルパス・d2_check/d2_fmt の結果を要約し、D2コード全文は回答に貼らない",
  ].join("\n");

  const searchGuidelines = [
    "Web検索ガイドライン:",
    `- web_search で参照できるのは ${D2_TOUR_URL} 配下の情報のみです。`,
    "- d2lang.com 以外の出典は利用・引用しないでください。",
  ].join("\n");

  const systemText = [
    "あなたは D2 ダイアグラムを作成・更新するアシスタントです。",
    "ローカルワークスペース内のファイルのみ操作し、許可されたツール以外は使用しないでください。",
    `対象ファイル: ${pathHint}`,
    toolSummary,
    workflow,
    searchGuidelines,
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
    const bootstrap = bootstrapCli<D2CliOptions, D2CliHistoryStoreContext>({
      argv,
      logLabel: "[gpt-5-cli-d2]",
      parseArgs,
      historyContextSchema: d2CliHistoryContextSchema,
      historyEntryFilter: createCliHistoryEntryFilter("d2"),
      envFileSuffix: "d2",
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
      printHelp: outputHelp,
    });
    if (determine.kind === "exit") {
      process.exit(determine.code);
      return;
    }

    // TODO(pipeline/input): d2 固有の履歴継承やパス初期化を input 層で共通化できないか検討する。
    const context = computeContext(
      options,
      historyStore,
      determine.inputText,
      determine.activeEntry,
      determine.previousResponseId,
      determine.previousTitle,
      {
        logLabel: "[gpt-5-cli-d2]",
        synchronizeWithHistory: ({ options: nextOptions, activeEntry }) => {
          nextOptions.taskMode = "d2";
          const historyContext = activeEntry.context as D2CliHistoryContext | undefined;

          if (!nextOptions.outputExplicit) {
            const historyFile = historyContext?.file_path ?? historyContext?.output?.file;
            if (historyFile) {
              nextOptions.outputPath = historyFile;
              nextOptions.filePath = historyFile;
            }
          }
          if (!nextOptions.copyExplicit && typeof historyContext?.output?.copy === "boolean") {
            nextOptions.copyOutput = historyContext.output.copy;
          }
        },
      },
    );

    const d2Context = ensureD2Context(options);

    const imageDataUrl = prepareImageData(options.imagePath, "[gpt-5-cli-d2]");
    const request = buildRequest({
      options,
      context,
      inputText: determine.inputText,
      systemPrompt,
      imageDataUrl,
      defaults,
      logLabel: "[gpt-5-cli-d2]",
      additionalSystemMessages: buildD2InstructionMessages(d2Context),
      tools: buildD2ResponseTools(),
    });
    const agentResult = await runAgentConversation({
      client,
      request,
      options,
      logLabel: "[gpt-5-cli-d2]",
      toolRegistrations: D2_TOOL_REGISTRATIONS,
      maxTurns: options.maxIterations,
      additionalAgentTools: [createD2WebSearchTool()],
    });
    const content = agentResult.assistantText;
    if (!content) {
      throw new Error("Error: Failed to parse response or empty content");
    }

    const summaryOutputPath =
      options.outputExplicit && options.outputPath && options.outputPath !== options.filePath
        ? options.outputPath
        : undefined;

    const previousContextRaw = context.activeEntry?.context as D2CliHistoryStoreContext | undefined;
    const previousContext = isD2HistoryContext(previousContextRaw) ? previousContextRaw : undefined;
    const historyContext = buildFileHistoryContext<D2CliHistoryContext>({
      base: { cli: "d2" },
      contextPath: d2Context.absolutePath,
      defaultFilePath: options.filePath,
      previousContext,
      historyOutputFile: summaryOutputPath ?? options.filePath,
      copyOutput: options.copyOutput,
    });
    const finalizeOutcome = await finalizeResult<D2CliHistoryStoreContext>({
      content,
      userText: determine.inputText,
      summaryOutputPath,
      copyOutput: options.copyOutput,
      copySourceFilePath: options.filePath,
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

    const artifactAbsolutePath = d2Context.absolutePath;
    if (fs.existsSync(artifactAbsolutePath)) {
      console.log(`[gpt-5-cli-d2] output file: ${options.filePath}`);
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
