#!/usr/bin/env bun
// mermaid.ts: Mermaid 図のチェック・修正を行う CLI エントリーポイント。
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CliDefaults, CliOptions, ConfigEnvironment, OpenAIInputMessage } from "../types.js";
import { createOpenAIClient } from "../pipeline/process/openai-client.js";
import {
  MERMAID_CHECK_TOOL,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  buildConversationToolset,
  type ConversationToolset,
} from "../pipeline/process/tools/index.js";
import {
  finalizeResult,
  generateDefaultOutputPath,
  buildFileHistoryContext,
  resolveResultOutput,
  createClipboardAction,
  type FinalizeActionList,
  type FileHistoryContext,
} from "../pipeline/finalize/index.js";
import { computeContext } from "../pipeline/process/conversation-context.js";
import { prepareImageData } from "../pipeline/process/image-attachments.js";
import { buildRequest, performCompact } from "../pipeline/process/responses.js";
import { runAgentConversation } from "../pipeline/process/agent-conversation.js";
import { resolveInputOrExecuteHistoryAction } from "../pipeline/input/cli-input.js";
import { bootstrapCli } from "../pipeline/input/cli-bootstrap.js";
import { createCliHistoryEntryFilter } from "../pipeline/input/history-filter.js";
import { buildCommonCommand, parseCommonOptions } from "./common/common-cli.js";
import type { CliLoggerConfig } from "./common/types.js";
import { createCliToolLoggerOptions, updateCliLoggerLevel } from "./common/logger.js";
import { createCliLogger } from "../foundation/logger/create-cli-logger.js";

/** Mermaidモードの解析済みCLIオプションを表す型。 */
export interface MermaidCliOptions extends CliOptions {
  artifactPath: string;
}

/**
 * Mermaid ダイアグラム生成時に利用するファイル参照情報。
 */
interface MermaidContextInfo {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
}

/**
 * ensureMermaidContext の実行結果。context にファイル情報、normalizedOptions に正規化済みオプションを保持する。
 */
interface MermaidContextResolution {
  context: MermaidContextInfo;
  normalizedOptions: MermaidCliOptions;
}

const MERMAID_TOOL_REGISTRATIONS = [READ_FILE_TOOL, WRITE_FILE_TOOL, MERMAID_CHECK_TOOL] as const;
const MERMAID_LOG_LABEL = "[gpt-5-cli-mermaid]";

interface BuildMermaidToolsetParams {
  loggerConfig: CliLoggerConfig;
}

export function buildMermaidConversationToolset(
  params: BuildMermaidToolsetParams,
): ConversationToolset {
  const agentOptions = createCliToolLoggerOptions(params.loggerConfig);
  return buildConversationToolset(MERMAID_TOOL_REGISTRATIONS, {
    cli: { appendWebSearchPreview: true },
    agents: agentOptions,
    additionalAgentTools: [],
  });
}

const mermaidCliHistoryContextStrictSchema = z.object({
  cli: z.literal("mermaid"),
  relative_path: z.string().optional(),
  copy: z.boolean().optional(),
  absolute_path: z.string().optional(),
});

const mermaidCliHistoryContextSchema = mermaidCliHistoryContextStrictSchema
  .or(z.object({}).passthrough())
  .or(z.null());
type MermaidCliHistoryContextRaw = z.infer<typeof mermaidCliHistoryContextStrictSchema>;
export type MermaidCliHistoryContext = FileHistoryContext & { cli: "mermaid" };
type MermaidCliHistoryStoreContext = z.infer<typeof mermaidCliHistoryContextSchema>;

function toMermaidHistoryContext(
  value: MermaidCliHistoryStoreContext | undefined,
): MermaidCliHistoryContext | undefined {
  if (!value || typeof value !== "object" || (value as { cli?: unknown }).cli !== "mermaid") {
    return undefined;
  }
  const raw = value as MermaidCliHistoryContextRaw;
  return {
    cli: "mermaid",
    absolute_path: typeof raw.absolute_path === "string" ? raw.absolute_path : undefined,
    relative_path: typeof raw.relative_path === "string" ? raw.relative_path : undefined,
    copy: typeof raw.copy === "boolean" ? raw.copy : undefined,
  };
}

/**
 * CLIの利用方法を標準出力に表示する。
 *
 * @param defaults 現在の既定値セット。
 * @param options 解析済みのCLIオプション。
 */
function createMermaidProgram(defaults: CliDefaults) {
  return buildCommonCommand({
    defaults,
    mode: "mermaid",
    argument: { tokens: "[input...]", description: "ユーザー入力" },
    extraOptionRegistrars: [],
  });
}

function outputHelp(defaults: CliDefaults, _options: MermaidCliOptions): void {
  const program = createMermaidProgram(defaults);
  program.outputHelp();
}

/** CLI全体のオプションを統合的に検証するスキーマ。 */
const cliOptionsSchema = z
  .object({
    model: z.string(),
    effort: z.enum(["low", "medium", "high"]),
    verbosity: z.enum(["low", "medium", "high"]),
    continueConversation: z.boolean(),
    taskMode: z.literal("mermaid"),
    resumeIndex: z.union([z.number(), z.undefined()]),
    resumeListOnly: z.boolean(),
    deleteIndex: z.union([z.number(), z.undefined()]),
    showIndex: z.union([z.number(), z.undefined()]),
    imagePath: z.union([z.string(), z.undefined()]),
    debug: z.boolean(),
    responseOutputPath: z.union([z.string().min(1), z.undefined()]),
    responseOutputExplicit: z.boolean(),
    copyOutput: z.boolean(),
    copyExplicit: z.boolean(),
    operation: z.union([z.literal("ask"), z.literal("compact")]),
    compactIndex: z.union([z.number(), z.undefined()]),
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
export function parseArgs(
  argv: string[],
  defaults: CliDefaults,
  configEnv: ConfigEnvironment,
): MermaidCliOptions {
  const program = createMermaidProgram(defaults);
  const { options: commonOptions } = parseCommonOptions(argv, defaults, program);
  const resolvedResponseOutputPath =
    commonOptions.responseOutputPath ??
    generateDefaultOutputPath({
      mode: "mermaid",
      extension: "mmd",
      cwd: undefined,
      configEnv,
    }).relativePath;
  try {
    const optionsInput = {
      ...commonOptions,
      taskMode: "mermaid",
      responseOutputPath: resolvedResponseOutputPath,
      artifactPath: resolvedResponseOutputPath,
    } satisfies Record<keyof MermaidCliOptions, unknown>;
    return cliOptionsSchema.parse(optionsInput) as MermaidCliOptions;
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
export function ensureMermaidContext(options: MermaidCliOptions): MermaidContextResolution {
  if (options.taskMode !== "mermaid") {
    throw new Error("Invariant violation: ensureMermaidContext は mermaid モード専用です");
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
      `Error: Mermaid出力の保存先はカレントディレクトリ配下に指定してください: ${rawPath}`,
    );
  }
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) {
    throw new Error(`Error: 指定した Mermaid ファイルパスはディレクトリです: ${rawPath}`);
  }
  const relativePath = path.relative(normalizedRoot, absolutePath) || path.basename(absolutePath);
  const normalizedOptions: MermaidCliOptions = {
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
  const logger = createCliLogger({
    task: "mermaid",
    label: MERMAID_LOG_LABEL,
    debug: false,
  });
  try {
    const argv = process.argv.slice(2);
    const bootstrap = await bootstrapCli<MermaidCliOptions, MermaidCliHistoryStoreContext>({
      argv,
      logLabel: MERMAID_LOG_LABEL,
      parseArgs,
      historyContextSchema: mermaidCliHistoryContextSchema,
      historyEntryFilter: createCliHistoryEntryFilter("mermaid"),
      envFileSuffix: "mermaid",
    });

    if (bootstrap.status === "help") {
      return;
    }

    const { defaults, options, historyStore, systemPrompt, configEnv } = bootstrap;
    const loggerConfig: CliLoggerConfig = {
      logger,
      logLabel: MERMAID_LOG_LABEL,
      debugEnabled: options.debug,
    };
    updateCliLoggerLevel(logger, options.debug ? "debug" : "info");
    const client = createOpenAIClient({ configEnv });

    if (options.operation === "compact") {
      await performCompact(options, defaults, historyStore, client, loggerConfig);
      return;
    }

    const determine = await resolveInputOrExecuteHistoryAction(
      options,
      historyStore,
      defaults,
      {
        printHelp: outputHelp,
      },
      configEnv,
    );
    if (determine.kind === "exit") {
      process.exit(determine.code);
      return;
    }

    // TODO(pipeline/input): mermaid モード特有のファイル推論も将来的に input 層へ寄せる。
    const context = computeContext({
      options,
      historyStore,
      inputText: determine.inputText,
      initialActiveEntry: determine.activeEntry,
      explicitPrevId: determine.previousResponseId,
      explicitPrevTitle: determine.previousTitle,
      config: {
        logLabel: MERMAID_LOG_LABEL,
        synchronizeWithHistory: ({ options: nextOptions, activeEntry }) => {
          nextOptions.taskMode = "mermaid";
          const historyContext = toMermaidHistoryContext(
            activeEntry.context as MermaidCliHistoryStoreContext | undefined,
          );

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
      loggerConfig,
    });

    const { context: mermaidContext, normalizedOptions } = ensureMermaidContext(options);
    const resolvedOptions = normalizedOptions;
    loggerConfig.debugEnabled = resolvedOptions.debug;
    updateCliLoggerLevel(logger, resolvedOptions.debug ? "debug" : "info");

    const imageDataUrl = prepareImageData(resolvedOptions.imagePath, loggerConfig, configEnv);
    const toolset = buildMermaidConversationToolset({
      loggerConfig,
    });
    const { request, agentTools } = buildRequest({
      options: resolvedOptions,
      context,
      inputText: determine.inputText,
      systemPrompt,
      imageDataUrl,
      defaults,
      configEnv,
      additionalSystemMessages: buildMermaidInstructionMessages(mermaidContext),
      toolset,
      loggerConfig,
    });
    const agentResult = await runAgentConversation({
      client,
      request,
      options: resolvedOptions,
      loggerConfig,
      agentTools,
      maxTurns: resolvedOptions.maxIterations,
    });
    if (agentResult.reachedMaxIterations) {
      logger.warn("指定したイテレーション上限に達したため途中結果を出力して処理を終了します");
    }
    const content = agentResult.assistantText;
    if (!content) {
      throw new Error("Error: Failed to parse response or empty content");
    }

    const outputResolution = resolveResultOutput({
      responseOutputExplicit: resolvedOptions.responseOutputExplicit,
      responseOutputPath: resolvedOptions.responseOutputPath,
      artifactPath: resolvedOptions.artifactPath,
    });

    const previousContextRaw = context.activeEntry?.context as
      | MermaidCliHistoryStoreContext
      | undefined;
    const previousContext = toMermaidHistoryContext(previousContextRaw);
    const historyContext = buildFileHistoryContext<MermaidCliHistoryContext>({
      base: { cli: "mermaid", absolute_path: undefined, relative_path: undefined, copy: undefined },
      contextPath: mermaidContext.absolutePath,
      defaultFilePath: resolvedOptions.artifactPath,
      previousContext,
      historyArtifactPath: outputResolution.artifactReferencePath,
      copyOutput: resolvedOptions.copyOutput,
    });
    const actions: FinalizeActionList = [];
    if (resolvedOptions.copyOutput) {
      actions.push(
        createClipboardAction({
          source: {
            type: "file",
            filePath: resolvedOptions.artifactPath,
          },
          workingDirectory: process.cwd(),
          priority: 100,
        }),
      );
    }

    const finalizeOutcome = await finalizeResult<MermaidCliHistoryStoreContext>({
      content,
      userText: determine.inputText,
      actions,
      textOutputPath: outputResolution.textOutputPath ?? undefined,
      configEnv,
      stdout: undefined,
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

    const artifactAbsolutePath = mermaidContext.absolutePath;
    if (fs.existsSync(artifactAbsolutePath)) {
      logger.info(`artifact file: ${resolvedOptions.artifactPath}`);
    }

    process.stdout.write(`${finalizeOutcome.stdout}\n`);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error(String(error));
    }
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
