// agent-conversation.ts: Agents SDK を利用して CLI からの会話処理を実行するラッパー。
import {
  Agent,
  MaxTurnsExceededError,
  RunResult,
  Runner,
  extractAllTextOutput,
  setTraceProcessors,
  user,
} from "@openai/agents";
import type { RunState } from "@openai/agents";
import type { Tool as AgentsSdkTool } from "@openai/agents";
import type { AgentInputItem, ModelSettings } from "@openai/agents";
import { OpenAIResponsesModel } from "@openai/agents-openai";
import type OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { CliLoggerConfig } from "../../foundation/logger/types.js";
import type { AgentConversationOutcome, CliOptions, OpenAIInputMessage } from "../../types.js";
const RESPONSES_OUTPUT_PATCHED = Symbol("gpt-5-cli.responsesOutputPatched");
setTraceProcessors([]);

type AnyAgent = Agent<unknown, any>;
type AnyRunResult = RunResult<unknown, AnyAgent>;
type AnyRunState = RunState<unknown, AnyAgent>;

/**
 * runAgentConversation が必要とする実行パラメータ群。
 */
interface RunAgentConversationParams<TOptions extends CliOptions> {
  /** OpenAI API クライアント。 */
  client: OpenAI;
  /** Responses API へ送信するリクエスト。 */
  request: ResponseCreateParamsNonStreaming;
  /** CLI で解析済みのオプション。 */
  options: TOptions;
  /** CLI 層から注入されるロガー設定。 */
  loggerConfig: CliLoggerConfig;
  /** Agents SDK で利用するツール配列。 */
  agentTools: AgentsSdkTool[];
  /** エージェント実行の最大ターン数。 */
  maxTurns: number | undefined;
}

/**
 * Agents SDK を介してエージェント実行を行い、最終または途中応答とレスポンス ID を取得する。
 *
 * maxTurns を超過した場合でも {@link AgentConversationOutcome.reachedMaxIterations} を true に設定し、
 * 可能な限りテキストを抽出して返す。
 */
export async function runAgentConversation<TOptions extends CliOptions>(
  params: RunAgentConversationParams<TOptions>,
): Promise<AgentConversationOutcome> {
  const { client, request, loggerConfig, agentTools, maxTurns } = params;
  const logLabel = loggerConfig.logLabel;
  const messages = normalizeMessages(request.input);
  const instructions = buildInstructions(messages);
  const userInputs = buildUserInputs(messages);
  if (userInputs.length === 0) {
    throw new Error("Error: No user input found for agent execution");
  }

  ensureResponsesOutputCompatibility(client);

  const modelSettings = buildModelSettings(request);
  const previousResponseId =
    typeof request.previous_response_id === "string" && request.previous_response_id.length > 0
      ? request.previous_response_id
      : undefined;

  const agent = new Agent({
    name: logLabel,
    instructions: instructions.length > 0 ? instructions : undefined,
    model: new OpenAIResponsesModel(client as unknown as any, request.model),
    modelSettings,
    tools: agentTools,
    outputType: "text",
  });

  if (loggerConfig.debugEnabled) {
    loggerConfig.logger.debug(
      `agent_max_turns=${maxTurns ?? "auto"} instructions_len=${instructions.length}`,
    );
  }
  const runner = new Runner({ tracingDisabled: true });
  let reachedMaxIterations = false;
  let result: AnyRunResult;
  try {
    result = (await runner.run(agent, userInputs, {
      maxTurns,
      previousResponseId,
    })) as AnyRunResult;
  } catch (error) {
    if (isMaxTurnsExceededError(error)) {
      reachedMaxIterations = true;
      result = new RunResult<unknown, AnyAgent>(error.state as AnyRunState);
    } else {
      throw error;
    }
  }

  const responseText = resolveAssistantText(result);
  if (!responseText || responseText.length === 0) {
    throw new Error("Error: Failed to resolve agent response text");
  }

  return {
    assistantText: responseText,
    responseId: result.lastResponseId,
    reachedMaxIterations,
  };
}

function ensureResponsesOutputCompatibility(client: OpenAI): void {
  const responsesAny = client.responses as unknown as Record<string | symbol, unknown>;
  if (responsesAny[RESPONSES_OUTPUT_PATCHED]) {
    return;
  }
  const originalCreate = (responsesAny.create as (...args: any[]) => Promise<unknown>).bind(
    responsesAny,
  );
  responsesAny.create = async (...args: unknown[]) => {
    const response = (await originalCreate(...args)) as Record<string, unknown>;
    if (response && typeof response === "object") {
      const outputText = response.output_text;
      if (!Array.isArray(response.output) && Array.isArray(outputText) && outputText.length > 0) {
        const content = outputText.map((entry: unknown) => ({
          type: "output_text",
          text: typeof entry === "string" ? entry : JSON.stringify(entry),
        }));
        response.output = [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            id: typeof response.id === "string" ? `${response.id}-assistant` : undefined,
            content,
          },
        ];
      }
    }
    return response;
  };
  responsesAny[RESPONSES_OUTPUT_PATCHED] = true;
}

function normalizeMessages(input: ResponseCreateParamsNonStreaming["input"]): OpenAIInputMessage[] {
  if (Array.isArray(input)) {
    return input.filter(isOpenAIInputMessage);
  }
  if (isOpenAIInputMessage(input)) {
    return [input];
  }
  return [];
}

function isOpenAIInputMessage(value: unknown): value is OpenAIInputMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  return "role" in value && "content" in value;
}

function buildInstructions(messages: OpenAIInputMessage[]): string {
  const chunks: string[] = [];
  for (const message of messages) {
    if (message.role !== "system" || !Array.isArray(message.content)) {
      continue;
    }
    const textParts = message.content
      .filter(
        (part): part is { type: "input_text"; text: string } =>
          typeof part === "object" && part?.type === "input_text" && "text" in part,
      )
      .map((part) => part.text.trim())
      .filter((text) => text.length > 0);
    if (textParts.length > 0) {
      chunks.push(textParts.join("\n"));
    }
  }
  return chunks.join("\n\n").trim();
}

function buildUserInputs(messages: OpenAIInputMessage[]): AgentInputItem[] {
  const items: AgentInputItem[] = [];
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) {
      continue;
    }
    const content = convertUserContent(message.content);
    if (content) {
      items.push(content);
    }
  }
  return items;
}

type AgentUserContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image: string | { id: string } }
  | { type: "input_file"; file: { id: string } | string };

function convertUserContent(parts: OpenAIInputMessage["content"]): AgentInputItem | undefined {
  const entries: AgentUserContent[] = [];

  for (const part of parts ?? []) {
    if (!part || typeof part !== "object" || typeof part.type !== "string") {
      continue;
    }
    if (part.type === "input_text" && "text" in part && typeof part.text === "string") {
      entries.push({ type: "input_text", text: part.text });
      continue;
    }
    if (part.type === "input_image") {
      const imagePart = part as unknown as {
        image: unknown | undefined;
        image_url: unknown | undefined;
      };
      const imageValue =
        (typeof imagePart.image === "string" ? imagePart.image : undefined) ??
        (typeof imagePart.image_url === "string" ? imagePart.image_url : undefined);
      if (typeof imageValue === "string" && imageValue.length > 0) {
        entries.push({ type: "input_image", image: imageValue });
      }
      continue;
    }
    if (part.type === "input_file") {
      const raw = part as unknown as {
        file: unknown | undefined;
        file_id: unknown | undefined;
      };
      const fileValue =
        typeof raw.file === "string"
          ? raw.file
          : typeof raw.file === "object" && raw.file && "id" in raw.file
            ? (raw.file as { id: string }).id
            : typeof raw.file_id === "string"
              ? raw.file_id
              : undefined;
      if (fileValue) {
        entries.push({ type: "input_file", file: { id: fileValue } });
      }
    }
  }

  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1 && entries[0]?.type === "input_text") {
    return user(entries[0].text);
  }
  return user(entries);
}

function buildModelSettings(request: ResponseCreateParamsNonStreaming): ModelSettings | undefined {
  const settings: ModelSettings = {};
  const reasoning = request.reasoning as
    | { effort: string | null | undefined; summary: string | null | undefined }
    | undefined;
  if (reasoning) {
    const effortCandidates = ["minimal", "low", "medium", "high"] as const;
    const summaryCandidates = ["auto", "concise", "detailed"] as const;
    const effort =
      typeof reasoning.effort === "string" && effortCandidates.includes(reasoning.effort as any)
        ? (reasoning.effort as (typeof effortCandidates)[number])
        : undefined;
    const summary =
      typeof reasoning.summary === "string" && summaryCandidates.includes(reasoning.summary as any)
        ? (reasoning.summary as (typeof summaryCandidates)[number])
        : undefined;
    if (effort || summary) {
      settings.reasoning = {};
      if (effort) {
        settings.reasoning.effort = effort;
      }
      if (summary) {
        settings.reasoning.summary = summary;
      }
    }
  }

  const textConfig = request.text as { verbosity: string | undefined } | undefined;
  if (textConfig && typeof textConfig.verbosity === "string") {
    const verbosityCandidates = ["low", "medium", "high"] as const;
    if (verbosityCandidates.includes(textConfig.verbosity as any)) {
      settings.text = { verbosity: textConfig.verbosity as (typeof verbosityCandidates)[number] };
    }
  }

  return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * Agents SDK の RunResult からテキストを抽出する。
 *
 * 1. 正常終了時にのみアクセス可能な finalOutput を最優先で利用する。
 * 2. 未完成の場合は message_output_item から連結済みテキストを構築する。
 * 3. それでも得られない場合は providerData.output_text をフォールバックとして採用する。
 */
function resolveAssistantText(result: AnyRunResult): string | undefined {
  if (hasFinalOutput(result)) {
    const finalOutput = result.finalOutput;
    if (typeof finalOutput === "string" && finalOutput.length > 0) {
      return finalOutput;
    }
  }

  // concatenated: 実行途中で積み上がった message_output_item を連結し、途中結果でも自然な文章を再構築する。
  const concatenated = extractAllTextOutput(result.newItems);
  if (typeof concatenated === "string" && concatenated.length > 0) {
    return concatenated;
  }

  const latestProviderData = result.rawResponses.at(-1)?.providerData as
    | { output_text: string | string[] | undefined }
    | undefined;
  const fallbackText = latestProviderData?.output_text;
  if (typeof fallbackText === "string" && fallbackText.length > 0) {
    return fallbackText;
  }
  if (Array.isArray(fallbackText) && fallbackText.length > 0) {
    return fallbackText.join("\n");
  }
  return undefined;
}

/** MaxTurnsExceededError かつ状態オブジェクトを保持しているか判定する。 */
function isMaxTurnsExceededError(
  error: unknown,
): error is MaxTurnsExceededError & { state: AnyRunState } {
  return (
    error instanceof MaxTurnsExceededError &&
    typeof (error as MaxTurnsExceededError).state === "object" &&
    (error as MaxTurnsExceededError).state !== null
  );
}

/** 正常終了時にのみ finalOutput が安全に読み取れる状態かを判定する。 */
function hasFinalOutput(result: AnyRunResult): boolean {
  const state = (
    result as unknown as {
      state?: { _currentStep?: { type?: string } | undefined };
    }
  ).state;
  return state?._currentStep?.type === "next_step_final_output";
}
