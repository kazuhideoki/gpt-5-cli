#!/usr/bin/env bun
// mermaid.ts: Mermaid 図のチェック・修正を行う CLI エントリーポイント。
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CliDefaults, CliOptions, OpenAIInputMessage } from "../types.js";
import { createOpenAIClient } from "../pipeline/process/openai-client.js";
import {
  MERMAID_CHECK_TOOL,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
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

const mermaidCliHistoryContextStrictSchema = z.object({
  cli: z.literal("mermaid"),
  relative_path: z.string().optional(),
  copy: z.boolean().optional(),
  absolute_path: z.string().optional(),
});

const mermaidCliHistoryContextSchema = mermaidCliHistoryContextStrictSchema
  .or(z.object({}).passthrough())
  .or(z.null());

export type MermaidCliHistoryContext = z.infer<typeof mermaidCliHistoryContextStrictSchema>;
type MermaidCliHistoryStoreContext = z.infer<typeof mermaidCliHistoryContextSchema>;

// TODO History ファイルを共有しないことを前提とし、シンプルにする。そうすればこれは不要
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
export function parseArgs(argv: string[], defaults: CliDefaults): MermaidCliOptions {
  const program = createMermaidProgram(defaults);
  const { options: commonOptions } = parseCommonOptions(argv, defaults, program);
  const resolvedResponseOutputPath =
    commonOptions.responseOutputPath ??
    generateDefaultOutputPath({ mode: "mermaid", extension: "mmd" }).relativePath;
  try {
    return cliOptionsSchema.parse({
      ...commonOptions,
      taskMode: "mermaid",
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

    const determine = await resolveInputOrExecuteHistoryAction(options, historyStore, defaults, {
      printHelp: outputHelp,
    });
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
        logLabel: "[gpt-5-cli-mermaid]",
        synchronizeWithHistory: ({ options: nextOptions, activeEntry }) => {
          nextOptions.taskMode = "mermaid";
          const historyContext = activeEntry.context as MermaidCliHistoryContext | undefined;

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

    const { context: mermaidContext, normalizedOptions } = ensureMermaidContext(options);
    const resolvedOptions = normalizedOptions;

    const imageDataUrl = prepareImageData(resolvedOptions.imagePath, "[gpt-5-cli-mermaid]");
    const request = buildRequest({
      options: resolvedOptions,
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
      options: resolvedOptions,
      logLabel: "[gpt-5-cli-mermaid]",
      toolRegistrations: MERMAID_TOOL_REGISTRATIONS,
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

    const previousContextRaw = context.activeEntry?.context as
      | MermaidCliHistoryStoreContext
      | undefined;
    const previousContext = isMermaidHistoryContext(previousContextRaw)
      ? previousContextRaw
      : undefined;
    const historyContext = buildFileHistoryContext<MermaidCliHistoryContext>({
      base: { cli: "mermaid" },
      contextPath: mermaidContext.absolutePath,
      defaultFilePath: resolvedOptions.artifactPath,
      previousContext,
      historyArtifactPath: outputResolution.artifactReferencePath,
      copyOutput: resolvedOptions.copyOutput,
    });
    const finalizeOutcome = await finalizeResult<MermaidCliHistoryStoreContext>({
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

    const artifactAbsolutePath = mermaidContext.absolutePath;
    if (fs.existsSync(artifactAbsolutePath)) {
      console.log(`[gpt-5-cli-mermaid] artifact file: ${resolvedOptions.artifactPath}`);
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
