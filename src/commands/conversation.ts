import fs from "node:fs";
import path from "node:path";
import type OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseTextConfig,
} from "openai/resources/responses/responses";
import { formatModelValue, formatScaleValue } from "../core/formatting.js";
import type { HistoryEntry, HistoryStore } from "../core/history.js";
import { formatTurnsForSummary } from "../core/history.js";
import type { ToolRuntime } from "../core/tools.js";
import { buildCliToolList } from "../core/tools.js";
import type {
  CliDefaults,
  CliOptions,
  ConversationContext,
  OpenAIInputMessage,
} from "../cli/types.js";

interface SynchronizeHistoryParams<TOptions extends CliOptions, THistoryTask = unknown> {
  options: TOptions;
  activeEntry: HistoryEntry<THistoryTask>;
  logWarning: (message: string) => void;
}

interface ComputeContextConfig<TOptions extends CliOptions, THistoryTask = unknown> {
  logLabel: string;
  synchronizeWithHistory?: (params: SynchronizeHistoryParams<TOptions, THistoryTask>) => void;
}

export function computeContext<TOptions extends CliOptions, THistoryTask = unknown>(
  options: TOptions,
  historyStore: HistoryStore<THistoryTask>,
  inputText: string,
  initialActiveEntry?: HistoryEntry<THistoryTask>,
  explicitPrevId?: string,
  explicitPrevTitle?: string,
  config?: ComputeContextConfig<TOptions, THistoryTask>,
): ConversationContext {
  const logLabel = config?.logLabel ?? "[gpt-5-cli]";
  const logWarning = (message: string): void => {
    console.error(`${logLabel} ${message}`);
  };

  let activeEntry = initialActiveEntry;
  let previousResponseId = explicitPrevId;
  let previousTitle = explicitPrevTitle;

  if (!options.hasExplicitHistory && options.continueConversation) {
    const latest = historyStore.findLatest();
    if (latest) {
      activeEntry = latest;
      previousResponseId = latest.last_response_id ?? previousResponseId;
      previousTitle = latest.title ?? previousTitle;
    } else {
      logWarning("warn: 継続できる履歴が見つかりません（新規開始）。");
    }
  }

  let resumeSummaryText: string | undefined;
  let resumeSummaryCreatedAt: string | undefined;
  let resumeMode = "";
  let resumePrev = "";
  const resumeBaseMessages: OpenAIInputMessage[] = [];

  if (activeEntry) {
    if (options.continueConversation) {
      if (!options.modelExplicit && typeof activeEntry.model === "string" && activeEntry.model) {
        options.model = activeEntry.model;
      }
      if (!options.effortExplicit && typeof activeEntry.effort === "string" && activeEntry.effort) {
        const lower = String(activeEntry.effort).toLowerCase();
        if (lower === "low" || lower === "medium" || lower === "high") {
          options.effort = lower as CliOptions["effort"];
        }
      }
      if (
        !options.verbosityExplicit &&
        typeof activeEntry.verbosity === "string" &&
        activeEntry.verbosity
      ) {
        const lower = String(activeEntry.verbosity).toLowerCase();
        if (lower === "low" || lower === "medium" || lower === "high") {
          options.verbosity = lower as CliOptions["verbosity"];
        }
      }
    }

    config?.synchronizeWithHistory?.({
      options,
      activeEntry,
      logWarning,
    });

    resumeMode = activeEntry.resume?.mode ?? "";
    resumePrev = activeEntry.resume?.previous_response_id ?? "";
    resumeSummaryText = activeEntry.resume?.summary?.text ?? undefined;
    resumeSummaryCreatedAt = activeEntry.resume?.summary?.created_at ?? undefined;

    if (resumeSummaryText) {
      resumeBaseMessages.push({
        role: "system",
        content: [{ type: "input_text", text: resumeSummaryText }],
      });
    }

    if (resumePrev) {
      previousResponseId = resumePrev;
    }

    if (!previousTitle && activeEntry.title) {
      previousTitle = activeEntry.title;
    }

    if (resumeMode === "new_request") {
      previousResponseId = undefined;
    }
  }

  let isNewConversation = true;
  if (options.continueConversation) {
    if (previousResponseId) {
      isNewConversation = false;
    } else if (activeEntry && resumeMode === "new_request") {
      isNewConversation = false;
    }
  }

  const titleCandidate = inputText.replace(/\s+/g, " ").slice(0, 50);
  let titleToUse = titleCandidate;
  if (isNewConversation) {
    if (options.continueConversation && previousTitle) {
      titleToUse = previousTitle;
    }
  } else {
    titleToUse = previousTitle ?? "";
  }

  return {
    isNewConversation,
    previousResponseId,
    previousTitle,
    titleToUse,
    resumeBaseMessages,
    resumeSummaryText,
    resumeSummaryCreatedAt,
    activeEntry,
    activeLastResponseId: activeEntry?.last_response_id ?? undefined,
  };
}

function resolveImagePath(raw: string): string {
  const home = process.env.HOME;
  if (!home || home.trim().length === 0) {
    throw new Error("HOME environment variable must be set to use image attachments.");
  }
  if (path.isAbsolute(raw)) {
    if (!raw.startsWith(home)) {
      throw new Error(`Error: -i で指定できるフルパスは ${home || "$HOME"} 配下のみです: ${raw}`);
    }
    if (!fs.existsSync(raw) || !fs.statSync(raw).isFile()) {
      throw new Error(`Error: 画像ファイルが見つかりません: ${raw}`);
    }
    return raw;
  }
  if (raw.startsWith("スクリーンショット ") && raw.endsWith(".png")) {
    const resolved = path.join(home, "Desktop", raw);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`Error: 画像ファイルが見つかりません: ${resolved}`);
    }
    return resolved;
  }
  throw new Error(
    `Error: -i には ${home || "$HOME"} 配下のフルパスか 'スクリーンショット *.png' のみ指定できます: ${raw}`,
  );
}

function detectImageMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".heic":
    case ".heif":
      return "image/heic";
    default:
      throw new Error(`Error: 未対応の画像拡張子です: ${filePath}`);
  }
}

interface ImageInfo {
  dataUrl?: string;
  mime?: string;
  resolvedPath?: string;
}

export function prepareImageData(imagePath: string | undefined, logLabel: string): ImageInfo {
  if (!imagePath) {
    return {};
  }
  const resolved = resolveImagePath(imagePath);
  const mime = detectImageMime(resolved);
  const data = fs.readFileSync(resolved);
  const base64 = data.toString("base64");
  if (!base64) {
    throw new Error(`Error: 画像ファイルの base64 エンコードに失敗しました: ${resolved}`);
  }
  const dataUrl = `data:${mime};base64,${base64}`;
  console.log(`${logLabel} image_attached: ${resolved} (${mime})`);
  return { dataUrl, mime, resolvedPath: resolved };
}

function collectFunctionToolCalls(response: Response): ResponseFunctionToolCall[] {
  const calls: ResponseFunctionToolCall[] = [];
  if (!Array.isArray(response.output)) {
    return calls;
  }
  for (const item of response.output) {
    if (item?.type === "function_call") {
      calls.push(item as ResponseFunctionToolCall);
    }
  }
  return calls;
}

export async function executeWithTools(
  client: OpenAI,
  initialRequest: ResponseCreateParamsNonStreaming,
  options: CliOptions,
  logLabel: string,
  toolRuntime: ToolRuntime,
): Promise<Response> {
  const executeFunctionToolCall = toolRuntime.execute;
  const debugLog = options.debug
    ? (message: string) => {
        console.error(`${logLabel} debug: ${message}`);
      }
    : undefined;

  const formatJsonSnippet = (raw: string, limit = 600): string => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return "";
    }
    try {
      const pretty = JSON.stringify(JSON.parse(trimmed), null, 2);
      if (pretty.length <= limit) {
        return pretty;
      }
      return `${pretty.slice(0, limit)}…(+${pretty.length - limit} chars)`;
    } catch {
      if (trimmed.length <= limit) {
        return trimmed;
      }
      return `${trimmed.slice(0, limit)}…(+${trimmed.length - limit} chars)`;
    }
  };

  const formatPlainSnippet = (raw: string, limit = 600): string => {
    const text = raw.trim();
    if (text.length === 0) {
      return "";
    }
    if (text.length <= limit) {
      return text;
    }
    return `${text.slice(0, limit)}…(+${text.length - limit} chars)`;
  };

  let response = await client.responses.create(initialRequest);
  if (debugLog) {
    debugLog(`initial response_id=${response.id ?? "unknown"}`);
  }

  let iteration = 0;
  const defaultMaxIterations = 8;
  const maxIterations = (() => {
    if (options.taskMode === "d2" && "d2MaxIterations" in options) {
      return (options as { d2MaxIterations: number }).d2MaxIterations;
    }
    if (options.taskMode === "sql" && "sqlMaxIterations" in options) {
      return (options as { sqlMaxIterations: number }).sqlMaxIterations;
    }
    return defaultMaxIterations;
  })();

  while (true) {
    const toolCalls = collectFunctionToolCalls(response);
    const cycle = iteration + 1;
    if (debugLog) {
      debugLog(
        `cycle=${cycle} response_id=${response.id ?? "unknown"} tool_calls=${toolCalls.length}`,
      );
    }
    if (toolCalls.length === 0) {
      if (debugLog) {
        debugLog(`cycle=${cycle} no tool calls found; returning response`);
      }
      return response;
    }
    if (iteration >= maxIterations) {
      throw new Error("Error: Tool call iteration limit exceeded");
    }

    const toolOutputs = await Promise.all(
      toolCalls.map(async (call) => {
        const callId = call.call_id ?? call.id ?? "";
        console.log(`${logLabel} tool handling ${call.name} (${callId})`);
        if (debugLog) {
          const argsSnippet = formatJsonSnippet(call.arguments);
          const argsMessage = argsSnippet.length > 0 ? `\n${argsSnippet}` : " <empty>";
          debugLog(`cycle=${cycle} tool_call ${call.name} (${callId}) arguments:${argsMessage}`);
        }
        const output = await executeFunctionToolCall(call, {
          cwd: process.cwd(),
          log: console.error,
        });
        if (debugLog) {
          const outputSnippet = formatPlainSnippet(output);
          const outputMessage = outputSnippet.length > 0 ? `\n${outputSnippet}` : " <empty>";
          debugLog(`cycle=${cycle} tool_call ${call.name} (${callId}) output:${outputMessage}`);
        }
        return {
          type: "function_call_output" as const,
          call_id: call.call_id,
          output,
        };
      }),
    );

    const followupRequest: ResponseCreateParamsNonStreaming = {
      model: initialRequest.model,
      reasoning: initialRequest.reasoning,
      text: initialRequest.text,
      tools: initialRequest.tools,
      input: toolOutputs,
      previous_response_id: response.id,
    };
    if (debugLog) {
      debugLog(
        `cycle=${cycle} submitting follow-up request with ${toolOutputs.length} tool output(s)`,
      );
    }
    response = await client.responses.create(followupRequest);
    if (debugLog) {
      debugLog(`cycle=${cycle} follow-up response_id=${response.id ?? "unknown"}`);
    }
    iteration += 1;
  }
}

interface BuildRequestParams {
  options: CliOptions;
  context: ConversationContext;
  inputText: string;
  systemPrompt?: string;
  imageDataUrl?: string;
  defaults?: CliDefaults;
  logLabel: string;
  additionalSystemMessages?: OpenAIInputMessage[];
  tools?: ResponseCreateParamsNonStreaming["tools"];
}

export function buildRequest({
  options,
  context,
  inputText,
  systemPrompt,
  imageDataUrl,
  defaults,
  logLabel,
  additionalSystemMessages,
  tools,
}: BuildRequestParams): ResponseCreateParamsNonStreaming {
  const modelLog = formatModelValue(
    options.model,
    defaults?.modelMain ?? "",
    defaults?.modelMini ?? "",
    defaults?.modelNano ?? "",
  );
  const effortLog = formatScaleValue(options.effort);
  const verbosityLog = formatScaleValue(options.verbosity);

  console.log(
    `${logLabel} model=${modelLog}, effort=${effortLog}, verbosity=${verbosityLog}, continue=${options.continueConversation}`,
  );
  console.log(
    `${logLabel} resume_index=${options.resumeIndex ?? ""}, resume_list_only=${options.resumeListOnly}, delete_index=${
      options.deleteIndex ?? ""
    }`,
  );

  const inputMessages: OpenAIInputMessage[] = [];

  if (context.isNewConversation && systemPrompt) {
    inputMessages.push({
      role: "system",
      content: [{ type: "input_text", text: systemPrompt }],
    });
  }

  if (additionalSystemMessages && additionalSystemMessages.length > 0) {
    inputMessages.push(...additionalSystemMessages);
  }

  if (context.resumeBaseMessages.length > 0) {
    inputMessages.push(...context.resumeBaseMessages);
  }

  const userContent: OpenAIInputMessage["content"] = [{ type: "input_text", text: inputText }];
  if (imageDataUrl) {
    userContent.push({
      type: "input_image",
      image_url: imageDataUrl,
      detail: "auto",
    });
  }

  inputMessages.push({ role: "user", content: userContent });

  const textConfig: ResponseTextConfig & { verbosity?: CliOptions["verbosity"] } = {
    verbosity: options.verbosity,
  };
  const inputForRequest = inputMessages as ResponseCreateParamsNonStreaming["input"];

  const request: ResponseCreateParamsNonStreaming = {
    model: options.model,
    reasoning: { effort: options.effort },
    text: textConfig,
    tools: tools ?? buildCliToolList([]),
    input: inputForRequest,
  };

  if (options.continueConversation && context.previousResponseId) {
    request.previous_response_id = context.previousResponseId;
  } else if (
    options.continueConversation &&
    !context.previousResponseId &&
    !context.resumeSummaryText
  ) {
    console.error(
      `${logLabel} warn: 直前の response.id が見つからないため、新規会話として開始します`,
    );
  }

  return request;
}

export function extractResponseText(response: Response): string | null {
  const anyResponse = response as any;
  const outputText = anyResponse.output_text;
  if (Array.isArray(outputText) && outputText.length > 0) {
    return outputText.join("");
  }
  if (typeof outputText === "string" && outputText.trim().length > 0) {
    return outputText;
  }
  if (Array.isArray(anyResponse.output)) {
    for (const item of anyResponse.output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const content of item.content) {
          if (content?.type === "output_text" && content.text) {
            return content.text;
          }
          if (content?.type === "text" && content.text) {
            return content.text;
          }
        }
      }
    }
  }
  const outputMessage = anyResponse.output_message;
  if (outputMessage?.content) {
    for (const content of outputMessage.content) {
      if (content?.type === "output_text" && content.text) {
        return content.text;
      }
      if (content?.type === "text" && content.text) {
        return content.text;
      }
    }
  }
  return null;
}

export async function performCompact<THistoryTask = unknown>(
  options: CliOptions,
  defaults: CliDefaults,
  historyStore: HistoryStore<THistoryTask>,
  client: OpenAI,
  logLabel: string,
): Promise<void> {
  if (typeof options.compactIndex !== "number") {
    throw new Error("Error: --compact の履歴番号は正の整数で指定してください");
  }
  const entry = historyStore.selectByNumber(options.compactIndex);
  const turns = entry.turns ?? [];
  if (turns.length === 0) {
    throw new Error("Error: この履歴には要約対象のメッセージがありません");
  }
  const conversationText = formatTurnsForSummary(turns);
  if (!conversationText) {
    throw new Error("Error: 要約対象のメッセージがありません");
  }

  const instruction =
    "あなたは会話ログを要約するアシスタントです。論点を漏らさず日本語で簡潔にまとめてください。";
  const header = "以下はこれまでの会話ログです。全てのメッセージを読んで要約に反映してください。";
  const userPrompt = `${header}\n---\n${conversationText}\n---\n\n出力条件:\n- 内容をシンプルに要約する\n- 箇条書きでも短い段落でもよい`;

  const compactTextConfig: ResponseTextConfig & { verbosity?: CliOptions["verbosity"] } = {
    verbosity: "medium",
  };
  const request: ResponseCreateParamsNonStreaming = {
    model: defaults.modelMini,
    reasoning: { effort: "medium" },
    text: compactTextConfig,
    input: [
      { role: "system", content: [{ type: "input_text", text: instruction }] },
      { role: "user", content: [{ type: "input_text", text: userPrompt }] },
    ],
  };

  const response = await client.responses.create(request);
  const summaryText = extractResponseText(response);
  if (!summaryText) {
    throw new Error("Error: 要約の生成に失敗しました");
  }

  const tsNow = new Date().toISOString();
  const summaryTurn = {
    role: "system",
    kind: "summary",
    text: summaryText,
    at: tsNow,
  };
  const resume = {
    mode: "new_request",
    previous_response_id: "",
    summary: { text: summaryText, created_at: tsNow },
  };

  const targetId = entry.last_response_id;
  if (!targetId) {
    throw new Error("Error: 選択した履歴の last_response_id が無効です。");
  }

  const entries = historyStore.loadEntries();
  const nextEntries = entries.map((item) => {
    if ((item.last_response_id ?? "") === targetId) {
      return {
        ...item,
        updated_at: tsNow,
        resume,
        turns: [summaryTurn],
      };
    }
    return item;
  });
  historyStore.saveEntries(nextEntries);
  console.log(`${logLabel} compact: history=${options.compactIndex}, summarized=${turns.length}`);
  process.stdout.write(`${summaryText}\n`);
}
