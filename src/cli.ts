#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import OpenAI from "openai";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseTextConfig,
} from "openai/resources/responses/responses";
import type {
  CliDefaults,
  CliOptions,
  ConversationContext,
  HistoryEntry,
  OpenAIInputMessage,
} from "./types.js";
import { formatModelValue, formatScaleValue } from "./utils.js";
import {
  ensureApiKey,
  loadDefaults,
  loadEnvironment,
  readSystemPrompt,
} from "./config.js";
import { formatTurnsForSummary, HistoryStore } from "./history.js";

type ResponseTextConfigWithVerbosity = ResponseTextConfig & {
  verbosity?: CliOptions["verbosity"];
};

interface DetermineInputExit {
  kind: "exit";
  code: number;
}

interface DetermineInputResult {
  kind: "input";
  inputText: string;
  activeEntry?: HistoryEntry;
  previousResponseId?: string;
  previousTitle?: string;
}

type DetermineResult = DetermineInputExit | DetermineInputResult;

function logError(message: string): void {
  console.error(message);
}

function printHelp(defaults: CliDefaults, options: CliOptions): void {
  console.log("Usage:");
  console.log("  gpt-5-cli [-i <image>] [flag] <input>");
  console.log("  gpt-5-cli --compact <num>");
  console.log("");
  console.log("flag（種類+数字／連結可／ハイフン必須）:");
  console.log(
    `  -m0/-m1/-m2 : model => nano/mini/main(${defaults.modelNano}/${defaults.modelMini}/${defaults.modelMain})`,
  );
  console.log(
    `  -e0/-e1/-e2 : effort => low/medium/high (既定: ${options.effort})`,
  );
  console.log(
    `  -v0/-v1/-v2 : verbosity => low/medium/high (既定: ${options.verbosity})`,
  );
  console.log("  -c          : continue（直前の会話から継続）");
  console.log("  -r{num}     : 対応する履歴で対話を再開（例: -r2）");
  console.log("  -d{num}     : 対応する履歴を削除（例: -d2）");
  console.log("  -s{num}     : 対応する履歴の対話内容を表示（例: -s2）");
  console.log("");
  console.log(
    "  -i <image>   : 入力に画像を添付（$HOME 配下のフルパスまたは 'スクリーンショット *.png'）",
  );
  console.log("");
  console.log("環境変数(.env):");
  console.log(
    "  OPENAI_HISTORY_INDEX_FILE : 履歴ファイルの保存先（例: ~/Library/Mobile Documents/com~apple~CloudDocs/gpt-5-cli/history_index.json）",
  );
  console.log("");
  console.log(
    `既定: model=${defaults.modelNano}, effort=${options.effort}, verbosity=${options.verbosity}（フラグ未指定時）`,
  );
  console.log("");
  console.log("例:");
  console.log(
    "  gpt-5-cli -m1e2v2 もっと詳しく -> model=gpt-5-mini(m1), effort=high(e2), verbosity=high(v2)",
  );
  console.log(
    "  gpt-5-cli -m0e0v0 箇条書きで   -> model=gpt-5-nano(m0), effort=low(e0), verbosity=low(v0)",
  );
  console.log("  gpt-5-cli -r                 -> 履歴一覧のみ表示して終了");
  console.log("  gpt-5-cli -r2 続きをやろう   -> 2番目の履歴を使って継続");
}

function coerceNumber(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("Error: 履歴番号は正の整数で指定してください");
  }
  return Number.parseInt(value, 10);
}

function expandLegacyShortFlags(argv: string[]): string[] {
  const result: string[] = [];
  let passThrough = false;

  const errorForUnknown = (flag: string): Error =>
    new Error(
      `Invalid option: -${flag} は無効です。-m0/1/2, -e0/1/2, -v0/1/2, -c, -r, -d/-d{num}, -s/-s{num} を使用してください。`,
    );

  for (const arg of argv) {
    if (passThrough) {
      result.push(arg);
      continue;
    }
    if (arg === "--") {
      result.push(arg);
      passThrough = true;
      continue;
    }
    if (arg === "-m") {
      throw new Error("Invalid option: -m には 0/1/2 を続けてください（例: -m1）");
    }
    if (arg === "-e") {
      throw new Error("Invalid option: -e には 0/1/2 を続けてください（例: -e2）");
    }
    if (arg === "-v") {
      throw new Error("Invalid option: -v には 0/1/2 を続けてください（例: -v0）");
    }
    if (!arg.startsWith("-") || arg === "-" || arg.startsWith("--") || arg === "-?" || arg === "-i") {
      result.push(arg);
      continue;
    }

    const cluster = arg.slice(1);
    if (cluster.length <= 1) {
      result.push(arg);
      continue;
    }

    let index = 0;
    let recognized = false;
    const append = (flag: string, value?: string) => {
      result.push(flag);
      if (typeof value === "string") {
        result.push(value);
      }
      recognized = true;
    };

    while (index < cluster.length) {
      const ch = cluster[index]!;
      switch (ch) {
        case "m":
        case "e":
        case "v": {
          const value = cluster[index + 1];
          if (!value) {
            throw new Error(`Invalid option: -${ch} には 0/1/2 を続けてください（例: -${ch}1）`);
          }
          append(`-${ch}`, value);
          index += 2;
          break;
        }
        case "c": {
          append(`-${ch}`);
          index += 1;
          break;
        }
        case "r":
        case "d":
        case "s": {
          index += 1;
          let digits = "";
          while (index < cluster.length && /\d/.test(cluster[index]!)) {
            digits += cluster[index]!;
            index += 1;
          }
          append(`-${ch}`, digits.length > 0 ? digits : undefined);
          break;
        }
        default:
          throw errorForUnknown(ch);
      }
    }

    if (!recognized) {
      result.push(arg);
    }
  }
  return result;
}

export function parseArgs(argv: string[], defaults: CliDefaults): CliOptions {
  const program = new Command();

  const parseModelIndex = (value: string): string => {
    switch (value) {
      case "0":
        return defaults.modelNano;
      case "1":
        return defaults.modelMini;
      case "2":
        return defaults.modelMain;
      default:
        throw new InvalidArgumentError(
          "Invalid option: -m には 0/1/2 を続けてください（例: -m1）",
        );
    }
  };

  const parseEffortIndex = (value: string): CliOptions["effort"] => {
    switch (value) {
      case "0":
        return "low";
      case "1":
        return "medium";
      case "2":
        return "high";
      default:
        throw new InvalidArgumentError(
          "Invalid option: -e には 0/1/2 を続けてください（例: -e2）",
        );
    }
  };

  const parseVerbosityIndex = (value: string): CliOptions["verbosity"] => {
    switch (value) {
      case "0":
        return "low";
      case "1":
        return "medium";
      case "2":
        return "high";
      default:
        throw new InvalidArgumentError(
          "Invalid option: -v には 0/1/2 を続けてください（例: -v0）",
        );
    }
  };

  const parseCompactIndex = (value: string): number => {
    if (!/^\d+$/.test(value)) {
      throw new InvalidArgumentError(
        "Error: --compact の履歴番号は正の整数で指定してください",
      );
    }
    return Number.parseInt(value, 10);
  };

  program
    .exitOverride()
    .allowUnknownOption(false)
    .showSuggestionAfterError(false)
    .configureOutput({
      writeErr: (str) => {
        const trimmed = str.replace(/\s+$/u, "");
        if (trimmed.length > 0) {
          logError(trimmed);
        }
      },
    });

  program.helpOption(false);
  program
    .option("-?, --help", "ヘルプを表示します")
    .option(
      "-m, --model <index>",
      "モデルを選択 (0/1/2)",
      parseModelIndex,
      defaults.modelNano,
    )
    .option(
      "-e, --effort <index>",
      "effort を選択 (0/1/2)",
      parseEffortIndex,
      defaults.effort,
    )
    .option(
      "-v, --verbosity <index>",
      "verbosity を選択 (0/1/2)",
      parseVerbosityIndex,
      defaults.verbosity,
    )
    .option("-c, --continue-conversation", "直前の会話から継続します")
    .option("-r, --resume [index]", "指定した番号の履歴から継続します")
    .option("-d, --delete [index]", "指定した番号の履歴を削除します")
    .option("-s, --show [index]", "指定した番号の履歴を表示します")
    .option("-i, --image <path>", "画像ファイルを添付します")
    .option("--compact <index>", "指定した履歴を要約します", parseCompactIndex);

  program.argument("[input...]", "ユーザー入力");

  const normalizedArgv = expandLegacyShortFlags(argv);

  try {
    program.parse(normalizedArgv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new Error(error.message);
    }
    throw error;
  }

  const opts = program.opts<{
    help?: boolean;
    model: string;
    effort: CliOptions["effort"];
    verbosity: CliOptions["verbosity"];
    continueConversation?: boolean;
    resume?: string | boolean;
    delete?: string | boolean;
    show?: string | boolean;
    image?: string;
    compact?: number;
  }>();

  const args = program.args as string[];

  const model = opts.model ?? defaults.modelNano;
  const effort = opts.effort ?? defaults.effort;
  const verbosity = opts.verbosity ?? defaults.verbosity;
  let continueConversation = Boolean(opts.continueConversation);
  let resumeIndex: number | undefined;
  let resumeListOnly = false;
  let deleteIndex: number | undefined;
  let showIndex: number | undefined;
  let hasExplicitHistory = false;
  const imagePath = opts.image;
  let operation: "ask" | "compact" = "ask";
  let compactIndex: number | undefined;

  if (typeof opts.resume !== "undefined") {
    if (opts.resume === true) {
      resumeListOnly = true;
    } else if (typeof opts.resume === "string") {
      resumeIndex = coerceNumber(opts.resume);
      continueConversation = true;
      hasExplicitHistory = true;
    }
  }

  if (typeof opts.delete !== "undefined") {
    if (opts.delete === true) {
      resumeListOnly = true;
    } else if (typeof opts.delete === "string") {
      deleteIndex = coerceNumber(opts.delete);
    }
  }

  if (typeof opts.show !== "undefined") {
    if (opts.show === true) {
      resumeListOnly = true;
    } else if (typeof opts.show === "string") {
      showIndex = coerceNumber(opts.show);
    }
  }

  if (typeof opts.compact === "number") {
    operation = "compact";
    compactIndex = opts.compact;
  }

  const modelExplicit = program.getOptionValueSource("model") === "cli";
  const effortExplicit = program.getOptionValueSource("effort") === "cli";
  const verbosityExplicit = program.getOptionValueSource("verbosity") === "cli";
  const helpRequested = Boolean(opts.help);

  return {
    model,
    effort,
    verbosity,
    continueConversation,
    resumeIndex,
    resumeListOnly,
    deleteIndex,
    showIndex,
    imagePath,
    operation,
    compactIndex,
    args,
    modelExplicit,
    effortExplicit,
    verbosityExplicit,
    hasExplicitHistory,
    helpRequested,
  };
}

function resolveImagePath(raw: string): string {
  const home = process.env.HOME;
  if (!home || home.trim().length === 0) {
    throw new Error(
      "HOME environment variable must be set to use image attachments.",
    );
  }
  if (path.isAbsolute(raw)) {
    if (!raw.startsWith(home)) {
      throw new Error(
        `Error: -i で指定できるフルパスは ${home || "$HOME"} 配下のみです: ${raw}`,
      );
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

export async function determineInput(
  options: CliOptions,
  historyStore: HistoryStore,
  defaults: CliDefaults,
): Promise<DetermineResult> {
  if (typeof options.deleteIndex === "number") {
    const { removedTitle } = historyStore.deleteByNumber(options.deleteIndex);
    console.log(`削除しました: ${options.deleteIndex}) ${removedTitle}`);
    return { kind: "exit", code: 0 };
  }
  if (typeof options.showIndex === "number") {
    historyStore.showByNumber(options.showIndex, Boolean(process.env.NO_COLOR));
    return { kind: "exit", code: 0 };
  }
  if (options.resumeListOnly) {
    historyStore.listHistory();
    return { kind: "exit", code: 0 };
  }

  if (typeof options.resumeIndex === "number") {
    const entry = historyStore.selectByNumber(options.resumeIndex);
    const inputText =
      options.args.length > 0 ? options.args.join(" ") : await promptForInput();
    if (!inputText.trim()) {
      throw new Error("プロンプトが空です。");
    }
    return {
      kind: "input",
      inputText,
      activeEntry: entry,
      previousResponseId: entry.last_response_id ?? undefined,
      previousTitle: entry.title ?? undefined,
    };
  }

  if (options.args.length === 0) {
    printHelp(defaults, options);
    return { kind: "exit", code: 1 };
  }

  return { kind: "input", inputText: options.args.join(" ") };
}

async function promptForInput(): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("プロンプト > ");
    return answer;
  } finally {
    rl.close();
  }
}

function computeContext(
  options: CliOptions,
  historyStore: HistoryStore,
  inputText: string,
  initialActiveEntry?: HistoryEntry,
  explicitPrevId?: string,
  explicitPrevTitle?: string,
): ConversationContext {
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
      logError(
        "[openai_api] warn: 継続できる履歴が見つかりません（新規開始）。",
      );
    }
  }

  let resumeSummaryText: string | undefined;
  let resumeSummaryCreatedAt: string | undefined;
  let resumeMode = "";
  let resumePrev = "";
  const resumeBaseMessages: OpenAIInputMessage[] = [];

  if (activeEntry) {
    if (options.continueConversation) {
      if (
        !options.modelExplicit &&
        typeof activeEntry.model === "string" &&
        activeEntry.model
      ) {
        options.model = activeEntry.model;
      }
      if (
        !options.effortExplicit &&
        typeof activeEntry.effort === "string" &&
        activeEntry.effort
      ) {
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

    resumeMode = activeEntry.resume?.mode ?? "";
    resumePrev = activeEntry.resume?.previous_response_id ?? "";
    resumeSummaryText = activeEntry.resume?.summary?.text ?? undefined;
    resumeSummaryCreatedAt =
      activeEntry.resume?.summary?.created_at ?? undefined;

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

function prepareImageData(imagePath?: string): {
  dataUrl?: string;
  mime?: string;
  resolvedPath?: string;
} {
  if (!imagePath) {
    return {};
  }
  const resolved = resolveImagePath(imagePath);
  const mime = detectImageMime(resolved);
  const data = fs.readFileSync(resolved);
  const base64 = data.toString("base64");
  if (!base64) {
    throw new Error(
      `Error: 画像ファイルの base64 エンコードに失敗しました: ${resolved}`,
    );
  }
  const dataUrl = `data:${mime};base64,${base64}`;
  logError(`[openai_api] image_attached: ${resolved} (${mime})`);
  return { dataUrl, mime, resolvedPath: resolved };
}

function buildRequest(
  options: CliOptions,
  context: ConversationContext,
  inputText: string,
  systemPrompt?: string,
  imageDataUrl?: string,
  defaults?: CliDefaults,
): ResponseCreateParamsNonStreaming {
  const modelLog = formatModelValue(
    options.model,
    defaults?.modelMain ?? "",
    defaults?.modelMini ?? "",
    defaults?.modelNano ?? "",
  );
  const effortLog = formatScaleValue(options.effort);
  const verbosityLog = formatScaleValue(options.verbosity);

  logError(
    `[openai_api] model=${modelLog}, effort=${effortLog}, verbosity=${verbosityLog}, continue=${options.continueConversation}`,
  );
  logError(
    `             resume_index=${options.resumeIndex ?? ""}, resume_list_only=${options.resumeListOnly}, delete_index=${
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

  if (context.resumeBaseMessages.length > 0) {
    inputMessages.push(...context.resumeBaseMessages);
  }

  const userContent: OpenAIInputMessage["content"] = [
    { type: "input_text", text: inputText },
  ];
  if (imageDataUrl) {
    userContent.push({
      type: "input_image",
      image_url: imageDataUrl,
      detail: "auto",
    });
  }

  inputMessages.push({ role: "user", content: userContent });

  const textConfig: ResponseTextConfigWithVerbosity = {
    verbosity: options.verbosity,
  };
  const inputForRequest =
    inputMessages as ResponseCreateParamsNonStreaming["input"];

  const request: ResponseCreateParamsNonStreaming = {
    model: options.model,
    reasoning: { effort: options.effort },
    text: textConfig,
    tools: [{ type: "web_search_preview" }],
    input: inputForRequest,
  };

  if (options.continueConversation && context.previousResponseId) {
    request.previous_response_id = context.previousResponseId;
  } else if (
    options.continueConversation &&
    !context.previousResponseId &&
    !context.resumeSummaryText
  ) {
    logError(
      "[openai_api] warn: 直前の response.id が見つからないため、新規会話として開始します",
    );
  }

  return request;
}

function extractResponseText(response: any): string | null {
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

function historyUpsert(
  options: CliOptions,
  context: ConversationContext,
  historyStore: HistoryStore,
  responseId: string,
  userText: string,
  assistantText: string,
): void {
  historyStore.ensureInitialized();
  const entries = historyStore.loadEntries();
  const tsNow = new Date().toISOString();
  let targetLastId = context.previousResponseId;
  if (!targetLastId && context.activeLastResponseId) {
    targetLastId = context.activeLastResponseId;
  }

  const resumeSummaryText = context.resumeSummaryText ?? "";
  let resumeSummaryCreated = context.resumeSummaryCreatedAt ?? "";
  if (resumeSummaryText && !resumeSummaryCreated) {
    resumeSummaryCreated = tsNow;
  }

  const resume = resumeSummaryText
    ? {
        mode: "response_id",
        previous_response_id: responseId,
        summary: {
          text: resumeSummaryText,
          created_at: resumeSummaryCreated,
        },
      }
    : {
        mode: "response_id",
        previous_response_id: responseId,
      };

  const userTurn = { role: "user", text: userText, at: tsNow };
  const assistantTurn = {
    role: "assistant",
    text: assistantText,
    at: tsNow,
    response_id: responseId,
  };

  if (context.isNewConversation && !targetLastId) {
    const newEntry: HistoryEntry = {
      title: context.titleToUse,
      model: options.model,
      effort: options.effort,
      verbosity: options.verbosity,
      created_at: tsNow,
      updated_at: tsNow,
      first_response_id: responseId,
      last_response_id: responseId,
      request_count: 1,
      resume,
      turns: [userTurn, assistantTurn],
    };
    entries.push(newEntry);
    historyStore.saveEntries(entries);
    return;
  }

  let updated = false;
  const nextEntries = entries.map((entry) => {
    if ((entry.last_response_id ?? "") === (targetLastId ?? "")) {
      updated = true;
      const turns = [...(entry.turns ?? []), userTurn, assistantTurn];
      const nextResume = resumeSummaryText
        ? {
            ...(entry.resume ?? {}),
            mode: "response_id",
            previous_response_id: responseId,
            summary: {
              text: resumeSummaryText,
              created_at:
                resumeSummaryCreated ||
                entry.resume?.summary?.created_at ||
                entry.created_at ||
                tsNow,
            },
          }
        : {
            ...(entry.resume ?? {}),
            mode: "response_id",
            previous_response_id: responseId,
          };
      if (!resumeSummaryText && nextResume.summary) {
        delete nextResume.summary;
      }
      return {
        ...entry,
        updated_at: tsNow,
        last_response_id: responseId,
        model: options.model,
        effort: options.effort,
        verbosity: options.verbosity,
        request_count: (entry.request_count ?? 0) + 1,
        turns,
        resume: nextResume,
      };
    }
    return entry;
  });

  if (updated) {
    historyStore.saveEntries(nextEntries);
    return;
  }

  const fallbackEntry: HistoryEntry = {
    title: context.titleToUse,
    model: options.model,
    effort: options.effort,
    verbosity: options.verbosity,
    created_at: tsNow,
    updated_at: tsNow,
    first_response_id: responseId,
    last_response_id: responseId,
    request_count: 1,
    resume,
    turns: [userTurn, assistantTurn],
  };
  nextEntries.push(fallbackEntry);
  historyStore.saveEntries(nextEntries);
}

async function performCompact(
  options: CliOptions,
  defaults: CliDefaults,
  historyStore: HistoryStore,
  client: OpenAI,
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
  const header =
    "以下はこれまでの会話ログです。全てのメッセージを読んで要約に反映してください。";
  const userPrompt = `${header}\n---\n${conversationText}\n---\n\n出力条件:\n- 内容をシンプルに要約する\n- 箇条書きでも短い段落でもよい`;

  const compactTextConfig: ResponseTextConfigWithVerbosity = {
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
  logError(
    `[openai_api] compact: history=${options.compactIndex}, summarized=${turns.length}`,
  );
  process.stdout.write(`${summaryText}\n`);
}

async function main(): Promise<void> {
  try {
    loadEnvironment();
    const defaults = loadDefaults();
    logError(`[openai_api] history_index: ${defaults.historyIndexPath}`);
    const systemPrompt = readSystemPrompt(defaults.systemPromptPath);
    if (systemPrompt) {
      const bytes = Buffer.byteLength(systemPrompt, "utf8");
      logError(`[openai_api] system_prompt: loaded (${bytes} bytes)`);
    }

    const options = parseArgs(process.argv.slice(2), defaults);
    if (options.helpRequested) {
      printHelp(defaults, options);
      return;
    }

    if (
      options.operation === "compact" &&
      (options.continueConversation ||
        options.resumeListOnly ||
        options.resumeIndex !== undefined ||
        options.deleteIndex !== undefined ||
        options.showIndex !== undefined ||
        options.args.length > 0)
    ) {
      throw new Error("Error: --compact と他のフラグは併用できません");
    }

    const apiKey = ensureApiKey();
    const client = new OpenAI({ apiKey });
    const historyStore = new HistoryStore(defaults.historyIndexPath);

    if (options.operation === "compact") {
      await performCompact(options, defaults, historyStore, client);
      return;
    }

    const determine = await determineInput(options, historyStore, defaults);
    if (determine.kind === "exit") {
      process.exit(determine.code);
      return;
    }

    const context = computeContext(
      options,
      historyStore,
      determine.inputText,
      determine.activeEntry,
      determine.previousResponseId,
      determine.previousTitle,
    );

    const imageInfo = prepareImageData(options.imagePath);
    const request = buildRequest(
      options,
      context,
      determine.inputText,
      systemPrompt,
      imageInfo.dataUrl,
      defaults,
    );
    const response = await client.responses.create(request);
    const content = extractResponseText(response);
    if (!content) {
      throw new Error("Error: Failed to parse response or empty content");
    }

    if (response.id) {
      historyUpsert(
        options,
        context,
        historyStore,
        response.id,
        determine.inputText,
        content,
      );
    }

    process.stdout.write(`${content}\n`);
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
