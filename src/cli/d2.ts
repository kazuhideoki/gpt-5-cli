#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import type { Tool as AgentsSdkTool } from "@openai/agents";
import { webSearchTool } from "@openai/agents-openai";
import { z } from "zod";
import type { CliDefaults, CliOptions, OpenAIInputMessage } from "../types.js";
import { createOpenAIClient } from "../pipeline/process/openai-client.js";
import {
  D2_CHECK_TOOL,
  D2_FMT_TOOL,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  buildConversationToolset,
  type ConversationToolset,
  type BuildAgentsToolListOptions,
} from "../pipeline/process/tools/index.js";
import {
  finalizeResult,
  generateDefaultOutputPath,
  buildFileHistoryContext,
  resolveResultOutput,
} from "../pipeline/finalize/index.js";
import { computeContext } from "../pipeline/process/conversation-context.js";
import { prepareImageData } from "../pipeline/process/image-attachments.js";
import { buildRequest, performCompact } from "../pipeline/process/responses.js";
import { runAgentConversation } from "../pipeline/process/agent-conversation.js";
import { resolveInputOrExecuteHistoryAction } from "../pipeline/input/cli-input.js";
import { bootstrapCli } from "../pipeline/input/cli-bootstrap.js";
import { createCliHistoryEntryFilter } from "../pipeline/input/history-filter.js";
import { buildCommonCommand, parseCommonOptions } from "./common/common-cli.js";

/** d2モードの解析済みCLIオプションを表す型。 */
export interface D2CliOptions extends CliOptions {
  artifactPath: string;
}

/**
 * d2ダイアグラム生成時に利用するファイル参照情報。
 */
interface D2ContextInfo {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
}

/**
 * ensureD2Context の実行結果をまとめた構造体。
 * context にはファイル情報を、normalizedOptions には正規化後の CLI オプションを保持する。
 */
interface D2ContextResolution {
  context: D2ContextInfo;
  normalizedOptions: D2CliOptions;
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

interface BuildD2ToolsetParams {
  logLabel: string;
  debug: boolean;
}

/**
 * d2 モードで使用するツールセットを生成する。
 */
export function buildD2ConversationToolset(params: BuildD2ToolsetParams): ConversationToolset {
  const agentOptions: BuildAgentsToolListOptions = {
    logLabel: params.logLabel,
    createExecutionContext: () => ({
      cwd: process.cwd(),
      log: (message: string) => {
        console.log(`${params.logLabel} ${message}`);
      },
    }),
  };

  if (params.debug) {
    agentOptions.debugLog = (message: string) => {
      console.error(`${params.logLabel} debug: ${message}`);
    };
  }

  return buildConversationToolset(D2_TOOL_REGISTRATIONS, {
    cli: { appendWebSearchPreview: false },
    agents: agentOptions,
    additionalAgentTools: [createD2WebSearchTool()],
  });
}

const d2CliHistoryContextStrictSchema = z.object({
  cli: z.literal("d2"),
  relative_path: z.string().optional(),
  copy: z.boolean().optional(),
  absolute_path: z.string().optional(),
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
  return buildCommonCommand({
    defaults,
    mode: "d2",
    argument: { tokens: "[input...]", description: "ユーザー入力" },
    extraOptionRegistrars: [],
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
    responseOutputPath: z.string().min(1).optional(),
    responseOutputExplicit: z.boolean(),
    copyOutput: z.boolean(),
    copyExplicit: z.boolean(),
    operation: z.union([z.literal("ask"), z.literal("compact")]),
    compactIndex: z.number().optional(),
    artifactPath: z.string().min(1),
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
  const resolvedResponseOutputPath =
    commonOptions.responseOutputPath ??
    generateDefaultOutputPath({ mode: "d2", extension: "d2" }).relativePath;
  try {
    return cliOptionsSchema.parse({
      ...commonOptions,
      taskMode: "d2",
      responseOutputPath: resolvedResponseOutputPath,
      artifactPath: resolvedResponseOutputPath,
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
export function ensureD2Context(options: D2CliOptions): D2ContextResolution {
  if (options.taskMode !== "d2") {
    throw new Error("Invariant violation: ensureD2Context は d2 モード専用です");
  }
  const cwd = process.cwd();
  const rawPath = options.artifactPath;
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
  const normalizedOptions: D2CliOptions = {
    ...options,
    artifactPath: relativePath,
    responseOutputPath: relativePath,
  };
  const exists = fs.existsSync(absolutePath);
  return {
    context: { relativePath, absolutePath, exists },
    normalizedOptions,
  };
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

    const determine = await resolveInputOrExecuteHistoryAction(options, historyStore, defaults, {
      printHelp: outputHelp,
    });
    if (determine.kind === "exit") {
      process.exit(determine.code);
      return;
    }

    // TODO(pipeline/input): d2 固有の履歴継承やパス初期化を input 層で共通化できないか検討する。
    const context = computeContext({
      options,
      historyStore,
      inputText: determine.inputText,
      initialActiveEntry: determine.activeEntry,
      explicitPrevId: determine.previousResponseId,
      explicitPrevTitle: determine.previousTitle,
      config: {
        logLabel: "[gpt-5-cli-d2]",
        synchronizeWithHistory: ({ options: nextOptions, activeEntry }) => {
          nextOptions.taskMode = "d2";
          const historyContext = activeEntry.context as D2CliHistoryContext | undefined;

          if (!nextOptions.responseOutputExplicit) {
            const historyFile = historyContext?.relative_path ?? historyContext?.absolute_path;
            if (historyFile) {
              nextOptions.responseOutputPath = historyFile;
              nextOptions.artifactPath = historyFile;
            }
          }
          if (!nextOptions.copyExplicit && typeof historyContext?.copy === "boolean") {
            nextOptions.copyOutput = historyContext.copy;
          }
        },
      },
    });

    const { context: d2Context, normalizedOptions } = ensureD2Context(options);

    const resolvedOptions = normalizedOptions;

    const imageDataUrl = prepareImageData(resolvedOptions.imagePath, "[gpt-5-cli-d2]");
    const toolset = buildD2ConversationToolset({
      logLabel: "[gpt-5-cli-d2]",
      debug: resolvedOptions.debug,
    });
    const { request, agentTools } = buildRequest({
      options: resolvedOptions,
      context,
      inputText: determine.inputText,
      systemPrompt,
      imageDataUrl,
      defaults,
      logLabel: "[gpt-5-cli-d2]",
      additionalSystemMessages: buildD2InstructionMessages(d2Context),
      toolset,
    });
    const agentResult = await runAgentConversation({
      client,
      request,
      options: resolvedOptions,
      logLabel: "[gpt-5-cli-d2]",
      agentTools,
      maxTurns: resolvedOptions.maxIterations,
    });
    const content = agentResult.assistantText;
    if (!content) {
      throw new Error("Error: Failed to parse response or empty content");
    }

    const outputResolution = resolveResultOutput({
      responseOutputExplicit: resolvedOptions.responseOutputExplicit,
      responseOutputPath: resolvedOptions.responseOutputPath,
      artifactPath: resolvedOptions.artifactPath,
    });

    const previousContextRaw = context.activeEntry?.context as D2CliHistoryStoreContext | undefined;
    const previousContext = isD2HistoryContext(previousContextRaw) ? previousContextRaw : undefined;
    const historyContext = buildFileHistoryContext<D2CliHistoryContext>({
      base: { cli: "d2" },
      contextPath: d2Context.absolutePath,
      defaultFilePath: resolvedOptions.artifactPath,
      previousContext,
      historyArtifactPath: outputResolution.artifactReferencePath,
      copyOutput: resolvedOptions.copyOutput,
    });
    const finalizeOutcome = await finalizeResult<D2CliHistoryStoreContext>({
      content,
      userText: determine.inputText,
      textOutputPath: outputResolution.textOutputPath ?? undefined,
      copyOutput: resolvedOptions.copyOutput,
      copySourceFilePath: resolvedOptions.artifactPath,
      history: agentResult.responseId
        ? {
            responseId: agentResult.responseId,
            store: historyStore,
            conversation: context,
            metadata: {
              model: resolvedOptions.model,
              effort: resolvedOptions.effort,
              verbosity: resolvedOptions.verbosity,
            },
            previousContextRaw,
            contextData: historyContext,
          }
        : undefined,
    });

    const artifactAbsolutePath = d2Context.absolutePath;
    if (fs.existsSync(artifactAbsolutePath)) {
      console.log(`[gpt-5-cli-d2] artifact file: ${resolvedOptions.artifactPath}`);
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
