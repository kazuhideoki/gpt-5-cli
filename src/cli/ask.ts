#!/usr/bin/env bun
// ask.ts: 一問一答型の標準チャット CLI エントリーポイント。
import type { Tool as AgentsSdkTool } from "@openai/agents";
import { webSearchTool } from "@openai/agents-openai";
import { z } from "zod";
import type { CliDefaults, CliOptions } from "../types.js";
import { createOpenAIClient } from "../pipeline/process/openai-client.js";
import { finalizeResult } from "../pipeline/finalize/index.js";
import { READ_FILE_TOOL, buildCliToolList } from "../pipeline/process/tools/index.js";
import { computeContext } from "../pipeline/process/conversation-context.js";
import { prepareImageData } from "../pipeline/process/image-attachments.js";
import { buildRequest, performCompact } from "../pipeline/process/responses.js";
import { runAgentConversation } from "../pipeline/process/agent-conversation.js";
import { determineInput } from "../pipeline/input/cli-input.js";
import { bootstrapCli } from "../pipeline/input/cli-bootstrap.js";
import { createCliHistoryEntryFilter } from "../pipeline/input/history-filter.js";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { buildCommonCommand, parseCommonOptions } from "./common/common-cli.js";

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

const askCliHistoryContextStrictSchema = z.object({
  cli: z.literal("ask"),
  output: z
    .object({
      file: z.string().optional(),
      copy: z.boolean().optional(),
    })
    .optional(),
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
  outputPath?: string;
  copyOutput: boolean;
}

/**
 * ask CLI が履歴へ保存するコンテキストを構築する。
 */
export function buildAskHistoryContext(params: BuildAskHistoryContextParams): AskCliHistoryContext {
  const { previousContext, outputPath, copyOutput } = params;
  const historyOutputFile = outputPath ?? previousContext?.output?.file;

  const nextContext: AskCliHistoryContext = {
    cli: "ask",
  };

  if (historyOutputFile !== undefined || copyOutput) {
    nextContext.output = {
      ...(historyOutputFile !== undefined ? { file: historyOutputFile } : {}),
      ...(copyOutput ? { copy: true } : {}),
    };
    return nextContext;
  }

  const previousFile = previousContext?.output?.file;
  if (previousFile !== undefined) {
    const previousCopy = previousContext?.output?.copy;
    nextContext.output = {
      file: previousFile,
      ...(previousCopy ? { copy: previousCopy } : {}),
    };
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
    maxIterations: z.number(),
    maxIterationsExplicit: z.boolean(),
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
  const program = createAskProgram(defaults);
  const { options: commonOptions } = parseCommonOptions(argv, defaults, program);
  try {
    return cliOptionsSchema.parse({
      ...commonOptions,
      taskMode: "ask",
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

    const bootstrap = bootstrapCli<CliOptions, AskCliHistoryStoreContext>({
      argv,
      logLabel: "[gpt-5-cli]",
      parseArgs,
      historyContextSchema: askCliHistoryContextSchema,
      historyEntryFilter: createCliHistoryEntryFilter("ask"),
      envFileSuffix: "ask",
    });

    if (bootstrap.status === "help") {
      return;
    }

    const { defaults, options, historyStore, systemPrompt } = bootstrap;

    const client = createOpenAIClient();

    if (options.operation === "compact") {
      await performCompact(options, defaults, historyStore, client, "[gpt-5-cli]");
      return;
    }

    const determine = await determineInput(options, historyStore, defaults, {
      printHelp: outputHelp,
    });
    if (determine.kind === "exit") {
      process.exit(determine.code);
      return;
    }

    // TODO(pipeline/input): ask モードの履歴出力設定を input 層で共有できるよう整理する。
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
          const historyContext = activeEntry.context as AskCliHistoryContext | undefined;
          if (!nextOptions.outputExplicit && historyContext?.output?.file) {
            nextOptions.outputPath = historyContext.output.file;
          }
          if (!nextOptions.copyExplicit && typeof historyContext?.output?.copy === "boolean") {
            nextOptions.copyOutput = historyContext.output.copy;
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

    const summaryOutputPath = options.outputPath;

    const previousContextRaw = context.activeEntry?.context as
      | AskCliHistoryStoreContext
      | undefined;
    const previousContext = isAskHistoryContext(previousContextRaw)
      ? previousContextRaw
      : undefined;

    const historyContext = buildAskHistoryContext({
      previousContext,
      outputPath: options.outputPath,
      copyOutput: options.copyOutput,
    });

    const finalizeOutcome = await finalizeResult<AskCliHistoryStoreContext>({
      content,
      userText: determine.inputText,
      summaryOutputPath,
      copyOutput: options.copyOutput,
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
