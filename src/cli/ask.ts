#!/usr/bin/env bun
// ask.ts: 一問一答型の標準チャット CLI エントリーポイント。
import type { Tool as AgentsSdkTool } from "@openai/agents";
import { webSearchTool } from "@openai/agents-openai";
import { z } from "zod";
import type { CliDefaults, CliOptions, ConfigEnvironment } from "../types.js";
import { createOpenAIClient } from "../pipeline/process/openai-client.js";
import {
  finalizeResult,
  createClipboardAction,
  type FinalizeActionList,
} from "../pipeline/finalize/index.js";
import {
  READ_FILE_TOOL,
  buildConversationToolset,
  type ConversationToolset,
} from "../pipeline/process/tools/index.js";
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

const ASK_TOOL_REGISTRATIONS = [READ_FILE_TOOL] as const;
const ASK_LOG_LABEL = "[gpt-5-cli]";

interface BuildAskToolsetParams {
  loggerConfig: CliLoggerConfig;
}

export function buildAskConversationToolset(params: BuildAskToolsetParams): ConversationToolset {
  const agentOptions = createCliToolLoggerOptions(params.loggerConfig);
  return buildConversationToolset(ASK_TOOL_REGISTRATIONS, {
    cli: { appendWebSearchPreview: false },
    agents: agentOptions,
    additionalAgentTools: [createAskWebSearchTool()],
  });
}

export function createAskWebSearchTool(): AgentsSdkTool {
  return webSearchTool({
    name: "web_search",
    searchContextSize: "medium",
  });
}

const askCliHistoryContextStrictSchema = z.object({
  cli: z.literal("ask"),
  relative_path: z.string().optional(),
  absolute_path: z.string().optional(),
  copy: z.boolean().optional(),
});

const askCliHistoryContextSchema = askCliHistoryContextStrictSchema
  .or(z.object({}).passthrough())
  .or(z.null());

export type AskCliHistoryContext = z.infer<typeof askCliHistoryContextStrictSchema>;
type AskCliHistoryStoreContext = z.infer<typeof askCliHistoryContextSchema>;

function isAskHistoryContext(value: unknown): value is AskCliHistoryContext {
  return askCliHistoryContextStrictSchema.safeParse(value).success;
}

interface BuildAskHistoryContextParams {
  previousContext?: AskCliHistoryContext;
  responseOutputPath?: string;
  copyOutput: boolean;
}

/**
 * ask CLI が履歴へ保存するコンテキストを構築する。
 */
export function buildAskHistoryContext(params: BuildAskHistoryContextParams): AskCliHistoryContext {
  const { previousContext, responseOutputPath, copyOutput } = params;
  const resolvedPath = responseOutputPath ?? previousContext?.relative_path;

  const nextContext: AskCliHistoryContext = {
    cli: "ask",
  };

  if (resolvedPath !== undefined) {
    nextContext.relative_path = resolvedPath;
  } else if (previousContext?.relative_path !== undefined) {
    nextContext.relative_path = previousContext.relative_path;
  }

  if (copyOutput || previousContext?.copy) {
    nextContext.copy = true;
  }

  return nextContext;
}

function createAskProgram(defaults: CliDefaults) {
  return buildCommonCommand({
    defaults,
    mode: "ask",
    argument: { tokens: "[input...]", description: "ユーザー入力" },
    extraOptionRegistrars: [],
  });
}

function outputHelp(defaults: CliDefaults, _options: CliOptions): void {
  const program = createAskProgram(defaults);
  program.outputHelp();
}

/** CLI全体のオプションを統合的に検証するスキーマ。 */
const cliOptionsSchema = z
  .object({
    model: z.string(),
    effort: z.enum(["low", "medium", "high"]),
    verbosity: z.enum(["low", "medium", "high"]),
    continueConversation: z.boolean(),
    taskMode: z.literal("ask"),
    resumeIndex: z.union([z.number(), z.undefined()]),
    resumeListOnly: z.boolean(),
    deleteIndex: z.union([z.number(), z.undefined()]),
    showIndex: z.union([z.number(), z.undefined()]),
    imagePath: z.union([z.string(), z.undefined()]),
    debug: z.boolean(),
    maxIterations: z.number(),
    maxIterationsExplicit: z.boolean(),
    responseOutputPath: z.union([z.string().min(1), z.undefined()]),
    responseOutputExplicit: z.boolean(),
    copyOutput: z.boolean(),
    copyExplicit: z.boolean(),
    operation: z.union([z.literal("ask"), z.literal("compact")]),
    compactIndex: z.union([z.number(), z.undefined()]),
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
  _configEnv: ConfigEnvironment,
): CliOptions {
  const program = createAskProgram(defaults);
  const { options: commonOptions } = parseCommonOptions(argv, defaults, program);
  try {
    const optionsInput = {
      ...commonOptions,
      taskMode: "ask",
    } satisfies Record<keyof CliOptions, unknown>;
    return cliOptionsSchema.parse(optionsInput) as CliOptions;
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
  const logger = createCliLogger({
    task: "ask",
    label: ASK_LOG_LABEL,
    debug: false,
  });
  try {
    const argv = process.argv.slice(2);

    const bootstrap = await bootstrapCli<CliOptions, AskCliHistoryStoreContext>({
      argv,
      logger,
      logLabel: ASK_LOG_LABEL,
      parseArgs,
      historyContextSchema: askCliHistoryContextSchema,
      historyEntryFilter: createCliHistoryEntryFilter("ask"),
      envFileSuffix: "ask",
    });

    if (bootstrap.status === "help") {
      return;
    }

    const { defaults, options, historyStore, systemPrompt, configEnv } = bootstrap;
    updateCliLoggerLevel(logger, options.debug ? "debug" : "info");
    const loggerConfig: CliLoggerConfig = {
      logger,
      logLabel: ASK_LOG_LABEL,
      debugEnabled: options.debug,
    };

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
        logger,
      },
      configEnv,
    );
    if (determine.kind === "exit") {
      process.exit(determine.code);
      return;
    }

    // TODO(pipeline/input): ask モードの履歴出力設定を input 層で共有できるよう整理する。
    const context = computeContext({
      options,
      historyStore,
      inputText: determine.inputText,
      initialActiveEntry: determine.activeEntry,
      explicitPrevId: determine.previousResponseId,
      explicitPrevTitle: determine.previousTitle,
      config: {
        logLabel: ASK_LOG_LABEL,
        synchronizeWithHistory: ({ options: nextOptions, activeEntry }) => {
          nextOptions.taskMode = "ask";
          const historyContext = activeEntry.context as AskCliHistoryContext | undefined;
          if (!nextOptions.responseOutputExplicit) {
            const historyPath = historyContext?.relative_path ?? historyContext?.absolute_path;
            if (historyPath) {
              nextOptions.responseOutputPath = historyPath;
            }
          }
          if (!nextOptions.copyExplicit && typeof historyContext?.copy === "boolean") {
            nextOptions.copyOutput = historyContext.copy;
          }
        },
      },
      loggerConfig,
    });

    const imageDataUrl = prepareImageData(options.imagePath, loggerConfig, configEnv);
    const toolset = buildAskConversationToolset({
      loggerConfig,
    });

    const { request, agentTools } = buildRequest({
      options,
      context,
      inputText: determine.inputText,
      systemPrompt,
      imageDataUrl,
      defaults,
      configEnv,
      additionalSystemMessages: undefined,
      toolset,
      loggerConfig,
    });
    const agentResult = await runAgentConversation({
      client,
      request,
      options,
      loggerConfig,
      agentTools,
      maxTurns: options.maxIterations,
    });
    if (agentResult.reachedMaxIterations) {
      logger.warn("指定したイテレーション上限に達したため途中結果を出力して処理を終了します");
    }
    const content = agentResult.assistantText;
    if (!content) {
      throw new Error("Error: Failed to parse response or empty content");
    }

    const textOutputPath = options.responseOutputPath;

    const previousContextRaw = context.activeEntry?.context as
      | AskCliHistoryStoreContext
      | undefined;
    const previousContext = isAskHistoryContext(previousContextRaw)
      ? previousContextRaw
      : undefined;

    const historyContext = buildAskHistoryContext({
      previousContext,
      responseOutputPath: options.responseOutputPath,
      copyOutput: options.copyOutput,
    });

    const actions: FinalizeActionList = [];
    if (options.copyOutput) {
      const source = options.responseOutputPath
        ? {
            type: "file" as const,
            filePath: options.responseOutputPath,
          }
        : { type: "content" as const, value: content };
      actions.push(
        createClipboardAction({
          source,
          workingDirectory: process.cwd(),
          priority: 100,
        }),
      );
    }

    const finalizeOutcome = await finalizeResult<AskCliHistoryStoreContext>({
      content,
      logger,
      userText: determine.inputText,
      actions,
      textOutputPath,
      configEnv,
      stdout: undefined,
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
