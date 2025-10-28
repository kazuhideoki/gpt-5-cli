// responses.ts: Responses API 向けのリクエスト構築と履歴圧縮処理をまとめたユーティリティ。
// NOTE(pipeline/process): finalize 層との責務分割を進行中。履歴保存などの副作用には TODO を付与している。
import type OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseTextConfig,
} from "openai/resources/responses/responses";
import { formatModelValue, formatScaleValue } from "./log-format.js";
import { formatTurnsForSummary } from "./history-summary.js";
import type { HistoryStore } from "../history/store.js";
import type { ConversationToolset } from "./tools/index.js";
import type {
  CliDefaults,
  CliOptions,
  ConfigEnvironment,
  ConversationContext,
  OpenAIInputMessage,
} from "../../types.js";

/**
 * Responses API へ送るペイロードを構築する際に必要となる入力一式。
 */
interface BuildRequestParams {
  /** CLI から引き継いだ実行設定。履歴継続時に `previous_response_id` を利用する。 */
  options: CliOptions;
  /** 履歴検索やタイトル継承を反映済みの会話コンテキスト。 */
  context: ConversationContext;
  /** ユーザーが今回送信するプロンプト文字列。 */
  inputText: string;
  /** 初回会話でのみ付与されるシステムプロンプト（CLI 側で任意設定）。 */
  systemPrompt?: string;
  /** CLI が許可した画像添付の Data URL。未指定時はテキストのみ。 */
  imageDataUrl?: string;
  /** 既定モデルや推論スケールのログ出力に使用する環境値。 */
  defaults?: CliDefaults;
  /** ログ出力に利用する CLI 固有ラベル。 */
  logLabel: string;
  /** カラー設定などログ整形に利用する環境スナップショット。 */
  configEnv: ConfigEnvironment;
  /** モード固有の追加システムメッセージ群。 */
  additionalSystemMessages?: OpenAIInputMessage[];
  /** CLI 固有のツールセット。Responses API 用と Agents SDK 用をまとめて受け取る。 */
  toolset: ConversationToolset;
}

/**
 * buildRequest が組み立てたリクエストと、エージェント実行時に必要なツール配列。
 */
export interface BuildRequestArtifacts {
  /** Responses API へ送信する完成済みペイロード。 */
  request: ResponseCreateParamsNonStreaming;
  /** Agents SDK 実行に利用するツール配列。 */
  agentTools: ConversationToolset["agents"];
}

/**
 * Responses API へ送るペイロードを構築し、履歴指定や追加システムメッセージを詰め替える。
 */
export function buildRequest({
  options,
  context,
  inputText,
  systemPrompt,
  imageDataUrl,
  defaults,
  logLabel,
  additionalSystemMessages,
  toolset,
  configEnv,
}: BuildRequestParams): BuildRequestArtifacts {
  const modelLog = formatModelValue(
    options.model,
    defaults?.modelMain ?? "",
    defaults?.modelMini ?? "",
    defaults?.modelNano ?? "",
    configEnv,
  );
  const effortLog = formatScaleValue(options.effort, configEnv);
  const verbosityLog = formatScaleValue(options.verbosity, configEnv);

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
    tools: toolset.response,
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

  return {
    request,
    agentTools: toolset.agents,
  };
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

/**
 * @TODO finalize 層へ performCompact の副作用部分を移すことを検討
 */
export async function performCompact<THistoryTask = unknown>(
  options: CliOptions,
  defaults: CliDefaults,
  historyStore: HistoryStore<THistoryTask>,
  client: OpenAI,
  logLabel: string,
): Promise<void> {
  // TODO(pipeline/finalize): 履歴の保存と標準出力書き込みは finalize 層へ移す。
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

  // TODO(pipeline/finalize): この履歴保存以降の副作用は finalize 層へ委譲する。
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
