// agent-conversation.ts: Agents SDK を利用して CLI からの会話処理を実行するラッパー。
import { Agent, Runner, extractAllTextOutput, setTraceProcessors, user } from "@openai/agents";
import type { Tool as AgentsSdkTool } from "@openai/agents";
import type { AgentInputItem, ModelSettings } from "@openai/agents";
import { OpenAIResponsesModel } from "@openai/agents-openai";
import type OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { CliOptions, OpenAIInputMessage } from "../../types.js";
const RESPONSES_OUTPUT_PATCHED = Symbol("gpt-5-cli.responsesOutputPatched");
setTraceProcessors([]);

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
  /** ログ出力に使用する CLI 固有ラベル。 */
  logLabel: string;
  /** Agents SDK で利用するツール配列。 */
  agentTools: AgentsSdkTool[];
  /** エージェント実行の最大ターン数。 */
  maxTurns: number | undefined;
}

/**
 * runAgentConversation が返す応答結果。
 */
interface AgentConversationResult {
  /** 最終的に得られたアシスタントのテキスト。 */
  assistantText: string;
  /** 最後に取得した Responses API のレスポンス ID。 */
  responseId: string | undefined;
}

/**
 * Agents SDK を利用してリクエストを実行し、最終応答テキストとレスポンス ID を返す。
 */
export async function runAgentConversation<TOptions extends CliOptions>(
  params: RunAgentConversationParams<TOptions>,
): Promise<AgentConversationResult> {
  const { client, request, options, logLabel, agentTools, maxTurns } = params;
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

  if (options.debug) {
    console.error(
      `${logLabel} debug: agent_max_turns=${maxTurns ?? "auto"} instructions_len=${instructions.length}`,
    );
  }
  const runner = new Runner({ tracingDisabled: true });
  const result = await runner.run(agent, userInputs, {
    maxTurns,
    previousResponseId,
  });

  let responseText =
    typeof result.finalOutput === "string" && result.finalOutput.length > 0
      ? result.finalOutput
      : extractAllTextOutput(result.newItems);

  if (!responseText || responseText.length === 0) {
    const latestProviderData = result.rawResponses.at(-1)?.providerData as
      | { output_text: string | string[] | undefined }
      | undefined;
    const fallbackText = latestProviderData?.output_text;
    if (typeof fallbackText === "string" && fallbackText.length > 0) {
      responseText = fallbackText;
    } else if (Array.isArray(fallbackText) && fallbackText.length > 0) {
      responseText = fallbackText.join("\n");
    }
  }

  if (!responseText || responseText.length === 0) {
    throw new Error("Error: Failed to resolve agent response text");
  }

  return {
    assistantText: responseText,
    responseId: result.lastResponseId,
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
