#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import OpenAI from "openai";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { z } from "zod";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseTextConfig,
  Response,
  ResponseFunctionToolCall,
} from "openai/resources/responses/responses";
import type { CliDefaults, CliOptions, ConversationContext, OpenAIInputMessage } from "./types.js";
import type { HistoryEntry, HistoryTask } from "../../core/history.js";
import { formatModelValue, formatScaleValue } from "./utils.js";
import { ensureApiKey, loadDefaults, loadEnvironment } from "../../core/config.js";
import { formatTurnsForSummary, HistoryStore } from "../../core/history.js";
import { FUNCTION_TOOLS, executeFunctionToolCall } from "./tools.js";
import { loadPrompt, resolvePromptPath } from "./prompts.js";

/**
 * OpenAIレスポンス設定にCLI固有のverbosity指定を付加したラッパー型。
 */
type ResponseTextConfigWithVerbosity = ResponseTextConfig & {
  verbosity?: CliOptions["verbosity"];
};

/**
 * ユーザーフローを即時終了させるための結果型。
 */
interface DetermineInputExit {
  kind: "exit";
  code: number;
}

/**
 * 対話継続に必要な入力情報をまとめた結果型。
 */
interface DetermineInputResult {
  kind: "input";
  inputText: string;
  activeEntry?: HistoryEntry;
  previousResponseId?: string;
  previousTitle?: string;
}

/**
 * 入力判定の戻り値。終了か継続かを表す。
 */
type DetermineResult = DetermineInputExit | DetermineInputResult;

/**
 * d2ダイアグラム生成時に利用するファイル参照情報。
 */
interface D2ContextInfo {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
}

/**
 * CLIの利用方法を標準出力に表示する。
 *
 * @param defaults 現在の既定値セット。
 * @param options 解析済みのCLIオプション。
 */
function printHelp(defaults: CliDefaults, options: CliOptions): void {
  console.log("Usage:");
  console.log("  gpt-5-cli [-i <image>] [flag] <input>");
  console.log("  gpt-5-cli --compact <num>");
  console.log("");
  console.log("flag（種類+数字／連結可／ハイフン必須）:");
  console.log(
    `  -m0/-m1/-m2 : model => nano/mini/main(${defaults.modelNano}/${defaults.modelMini}/${defaults.modelMain})`,
  );
  console.log(`  -e0/-e1/-e2 : effort => low/medium/high (既定: ${options.effort})`);
  console.log(`  -v0/-v1/-v2 : verbosity => low/medium/high (既定: ${options.verbosity})`);
  console.log("  -c          : continue（直前の会話から継続）");
  console.log("  -r{num}     : 対応する履歴で対話を再開（例: -r2）");
  console.log("  -d{num}     : 対応する履歴を削除（例: -d2）");
  console.log("  -s{num}     : 対応する履歴の対話内容を表示（例: -s2）");
  console.log("");
  console.log(
    "  -i <image>   : 入力に画像を添付（$HOME 配下のフルパスまたは 'スクリーンショット *.png'）",
  );
  console.log("  -D          : d2モードを有効化 (--d2-mode)");
  console.log("  -F <path>   : d2出力ファイルパスを指定 (--d2-file)");
  console.log("  -I <count>  : d2モード時のツール呼び出し上限 (--d2-iterations)");
  console.log("");
  console.log("環境変数(.env):");
  console.log(
    "  GPT_5_CLI_HISTORY_INDEX_FILE : 履歴ファイルの保存先（例: ~/Library/Mobile Documents/com~apple~CloudDocs/gpt-5-cli/history_index.json）",
  );
  console.log(
    "  GPT_5_CLI_PROMPTS_DIR        : systemプロンプトテンプレートの配置ディレクトリ（例: ~/Library/Application Support/gpt-5-cli/prompts）",
  );
  console.log(
    `  GPT_5_CLI_D2_MAX_ITERATIONS  : d2モードのツール呼び出し上限（正の整数、既定: ${defaults.d2MaxIterations})`,
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

/** CLI履歴番号フラグを数値に変換するスキーマ。 */
const historyIndexSchema = z
  .string()
  .regex(/^\d+$/u, "Error: 履歴番号は正の整数で指定してください")
  .transform((value) => Number.parseInt(value, 10));

/** 履歴系フラグの入力値（有効化 or 指定番号）を検証するスキーマ。 */
const historyFlagSchema = z.union([z.literal(true), historyIndexSchema]);

/** CLI全体のオプションを統合的に検証するスキーマ。 */
const cliOptionsSchema: z.ZodType<CliOptions> = z
  .object({
    model: z.string(),
    effort: z.enum(["low", "medium", "high"]),
    verbosity: z.enum(["low", "medium", "high"]),
    continueConversation: z.boolean(),
    taskMode: z.enum(["default", "d2"]),
    resumeIndex: z.number().optional(),
    resumeListOnly: z.boolean(),
    deleteIndex: z.number().optional(),
    showIndex: z.number().optional(),
    imagePath: z.string().optional(),
    operation: z.union([z.literal("ask"), z.literal("compact")]),
    compactIndex: z.number().optional(),
    d2FilePath: z.string().min(1).optional(),
    d2MaxIterations: z.number(),
    d2MaxIterationsExplicit: z.boolean(),
    args: z.array(z.string()),
    modelExplicit: z.boolean(),
    effortExplicit: z.boolean(),
    verbosityExplicit: z.boolean(),
    taskModeExplicit: z.boolean(),
    d2FileExplicit: z.boolean(),
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
 * OpenAI Responses APIへ渡すツール設定を構築する。
 *
 * @returns CLIが利用可能な関数ツールとプレビュー検索の配列。
 */
function buildToolList(): ResponseCreateParamsNonStreaming["tools"] {
  return [...FUNCTION_TOOLS, { type: "web_search_preview" as const }];
}

/**
 * 履歴操作フラグの入力を解析し、番号と一覧表示フラグを抽出する。
 *
 * @param raw CLI引数から得た履歴指定。
 * @returns 履歴番号または一覧表示フラグ。
 */
function parseHistoryFlag(raw: string | boolean | undefined): {
  index?: number;
  listOnly: boolean;
} {
  if (typeof raw === "undefined") {
    return { listOnly: false };
  }
  const parsed = historyFlagSchema.safeParse(raw);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    throw new Error(firstIssue?.message ?? "Error: 履歴番号は正の整数で指定してください");
  }
  if (parsed.data === true) {
    return { listOnly: true };
  }
  return { index: parsed.data, listOnly: false };
}

/**
 * 旧形式の短縮フラグ固まりをCommanderが解析できる形へ正規化する。
 *
 * @param argv 元の引数配列。
 * @returns 正規化済みの引数配列。
 */
function expandLegacyShortFlags(argv: string[]): string[] {
  const result: string[] = [];
  let passThrough = false;

  const errorForUnknown = (flag: string): Error =>
    new Error(
      `Invalid option: -${flag} は無効です。-m0/1/2, -e0/1/2, -v0/1/2, -c, -r, -d/-d{num}, -s/-s{num}, -D, -F を使用してください。`,
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
    if (arg === "-D" || arg === "-F") {
      result.push(arg);
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
    if (
      !arg.startsWith("-") ||
      arg === "-" ||
      arg.startsWith("--") ||
      arg === "-?" ||
      arg === "-i"
    ) {
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

/**
 * CLI引数を解析し、正規化・検証済みのオプションを返す。
 *
 * @param argv `process.argv`から取得した引数（node部分除外）。
 * @param defaults 環境から取得した既定値。
 * @returns CLI全体で使用するオプション集合。
 */
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
        throw new InvalidArgumentError("Invalid option: -m には 0/1/2 を続けてください（例: -m1）");
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
        throw new InvalidArgumentError("Invalid option: -e には 0/1/2 を続けてください（例: -e2）");
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
        throw new InvalidArgumentError("Invalid option: -v には 0/1/2 を続けてください（例: -v0）");
    }
  };

  const parseCompactIndex = (value: string): number => {
    if (!/^\d+$/.test(value)) {
      throw new InvalidArgumentError("Error: --compact の履歴番号は正の整数で指定してください");
    }
    return Number.parseInt(value, 10);
  };

  const parseD2Iterations = (value: string): number => {
    if (!/^\d+$/u.test(value)) {
      throw new InvalidArgumentError("Error: --d2-iterations の値は正の整数で指定してください");
    }
    const parsed = Number.parseInt(value, 10);
    if (parsed <= 0) {
      throw new InvalidArgumentError("Error: --d2-iterations の値は 1 以上で指定してください");
    }
    return parsed;
  };

  program
    .exitOverride()
    .allowUnknownOption(false)
    .showSuggestionAfterError(false)
    .configureOutput({
      writeErr: (str) => {
        const trimmed = str.replace(/\s+$/u, "");
        if (trimmed.length > 0) {
          console.error(trimmed);
        }
      },
    });

  program.helpOption(false);
  program
    .option("-?, --help", "ヘルプを表示します")
    .option("-m, --model <index>", "モデルを選択 (0/1/2)", parseModelIndex, defaults.modelNano)
    .option("-e, --effort <index>", "effort を選択 (0/1/2)", parseEffortIndex, defaults.effort)
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
    .option("-D, --d2-mode", "d2形式の生成モードを有効にします")
    .option("-F, --d2-file <path>", "d2出力を保存するファイルパスを指定します")
    .option(
      "-I, --d2-iterations <count>",
      "d2モード時のツール呼び出し上限を指定します",
      parseD2Iterations,
      defaults.d2MaxIterations,
    )
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
    d2Mode?: boolean;
    d2File?: string;
    d2Iterations?: number;
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
  const taskMode: CliOptions["taskMode"] = opts.d2Mode ? "d2" : "default";
  const d2FilePath =
    typeof opts.d2File === "string" && opts.d2File.length > 0 ? opts.d2File : undefined;
  const d2MaxIterations =
    typeof opts.d2Iterations === "number" ? opts.d2Iterations : defaults.d2MaxIterations;

  if (taskMode === "default" && d2FilePath) {
    throw new Error("Error: --d2-file は d2モードと併用してください");
  }

  const parsedResume = parseHistoryFlag(opts.resume);
  if (parsedResume.listOnly) {
    resumeListOnly = true;
  }
  if (typeof parsedResume.index === "number") {
    resumeIndex = parsedResume.index;
    continueConversation = true;
    hasExplicitHistory = true;
  }

  const parsedDelete = parseHistoryFlag(opts.delete);
  if (parsedDelete.listOnly) {
    resumeListOnly = true;
  }
  if (typeof parsedDelete.index === "number") {
    deleteIndex = parsedDelete.index;
  }

  const parsedShow = parseHistoryFlag(opts.show);
  if (parsedShow.listOnly) {
    resumeListOnly = true;
  }
  if (typeof parsedShow.index === "number") {
    showIndex = parsedShow.index;
  }

  if (typeof opts.compact === "number") {
    operation = "compact";
    compactIndex = opts.compact;
  }

  const modelExplicit = program.getOptionValueSource("model") === "cli";
  const effortExplicit = program.getOptionValueSource("effort") === "cli";
  const verbosityExplicit = program.getOptionValueSource("verbosity") === "cli";
  const taskModeExplicit = program.getOptionValueSource("d2Mode") === "cli";
  const d2FileExplicit = program.getOptionValueSource("d2File") === "cli";
  const d2MaxIterationsExplicit = program.getOptionValueSource("d2Iterations") === "cli";
  const helpRequested = Boolean(opts.help);

  if (taskMode === "default" && d2MaxIterationsExplicit) {
    throw new Error("Error: --d2-iterations は d2モードと併用してください");
  }

  try {
    return cliOptionsSchema.parse({
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
      taskMode,
      d2FilePath,
      args,
      modelExplicit,
      effortExplicit,
      verbosityExplicit,
      taskModeExplicit,
      d2FileExplicit,
      d2MaxIterations,
      d2MaxIterationsExplicit,
      hasExplicitHistory,
      helpRequested,
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
 * 画像添付用に受け取ったパスを検証し、実際のファイルパスへ解決する。
 *
 * @param raw CLIで指定された画像パス文字列。
 * @returns 存在する画像ファイルの絶対パス。
 */
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

/**
 * 画像ファイルの拡張子からMIMEタイプを推測する。
 *
 * @param filePath 画像ファイルパス。
 * @returns 対応するMIMEタイプ。
 */
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

/**
 * CLIオプションから次の入力アクションを決定する。
 * 履歴操作が指定されている場合は該当処理を実行して終了する。
 *
 * @param options 解析済みオプション。
 * @param historyStore 履歴管理ストア。
 * @param defaults 既定値セット。
 * @returns 入力テキストまたは終了指示。
 */
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
    const inputText = options.args.length > 0 ? options.args.join(" ") : await promptForInput();
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

/**
 * 標準入力からユーザープロンプトを取得する。
 *
 * @returns 入力された文字列。
 */
async function promptForInput(): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("プロンプト > ");
    return answer;
  } finally {
    rl.close();
  }
}

/**
 * 履歴とオプションをもとに、今回の対話コンテキストを構築する。
 *
 * @param options CLIオプション（必要に応じて上書きされる）。
 * @param historyStore 履歴ストア。
 * @param inputText 現在のユーザー入力。
 * @param initialActiveEntry 既に選択された履歴エントリ。
 * @param explicitPrevId 明示的に指定されたレスポンスID。
 * @param explicitPrevTitle 明示的に指定されたタイトル。
 * @returns 対話に必要なコンテキスト。
 */
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
      console.error("[gpt-5-cli] warn: 継続できる履歴が見つかりません（新規開始）。");
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

    if (!options.taskModeExplicit) {
      const historyMode = activeEntry.task?.mode;
      if (historyMode === "d2") {
        options.taskMode = "d2";
      } else if (typeof historyMode === "string" && historyMode.length > 0) {
        options.taskMode = "default";
      }
    }

    if (!options.d2FileExplicit) {
      if (options.taskMode === "d2") {
        const historyFile = activeEntry.task?.d2?.file_path;
        if (historyFile) {
          options.d2FilePath = historyFile;
        }
      } else if (!options.taskModeExplicit) {
        options.d2FilePath = undefined;
      }
    }

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

/**
 * 画像パスからOpenAI API向けのデータURLを生成する。
 *
 * @param imagePath 添付対象の画像パス。
 * @returns データURLやMIMEタイプなどの情報。
 */
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
    throw new Error(`Error: 画像ファイルの base64 エンコードに失敗しました: ${resolved}`);
  }
  const dataUrl = `data:${mime};base64,${base64}`;
  console.log(`[gpt-5-cli] image_attached: ${resolved} (${mime})`);
  return { dataUrl, mime, resolvedPath: resolved };
}

/**
 * 履歴に保存するタスクメタデータを組み立てる。
 *
 * @param options 現在のCLIオプション。
 * @param previousTask 既存履歴に保存されているタスク情報。
 * @param d2Context d2モード時のファイル情報。
 * @returns 保存対象のタスクメタデータ。
 */
function buildTaskMetadata(
  options: CliOptions,
  previousTask?: HistoryTask,
  d2Context?: D2ContextInfo,
): HistoryTask | undefined {
  if (options.taskMode === "d2") {
    const task: HistoryTask = { mode: "d2" };
    let d2Meta = previousTask?.d2 ? { ...previousTask.d2 } : undefined;
    const contextPath = d2Context?.absolutePath;
    let filePath = contextPath ?? options.d2FilePath;
    if (!filePath && !options.d2FileExplicit) {
      filePath = d2Meta?.file_path;
    }
    if (contextPath) {
      d2Meta = { ...d2Meta, file_path: contextPath };
    } else if (filePath) {
      d2Meta = { ...d2Meta, file_path: filePath };
    }
    if (d2Meta && Object.keys(d2Meta).length > 0) {
      task.d2 = d2Meta;
    }
    return task;
  }

  if (options.taskModeExplicit) {
    return { mode: options.taskMode };
  }

  return previousTask;
}

/**
 * レスポンス内で要求されたツール呼び出しを抽出する。
 *
 * @param response OpenAI Responses APIのレスポンス。
 * @returns 関数ツール呼び出し情報の配列。
 */
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

/**
 * OpenAI Responses APIによる推論とツール呼び出しのループを実行する。
 *
 * @param client OpenAIクライアント。
 * @param initialRequest 初回リクエスト。
 * @param options CLIオプション（ツール反復制限を含む）。
 * @returns 最終的なレスポンス。
 */
async function executeWithTools(
  client: OpenAI,
  initialRequest: ResponseCreateParamsNonStreaming,
  options: CliOptions,
): Promise<Response> {
  let response = await client.responses.create(initialRequest);
  let iteration = 0;
  const defaultMaxIterations = 8;
  const maxIterations = options.taskMode === "d2" ? options.d2MaxIterations : defaultMaxIterations;

  while (true) {
    const toolCalls = collectFunctionToolCalls(response);
    if (toolCalls.length === 0) {
      return response;
    }
    if (iteration >= maxIterations) {
      throw new Error("Error: Tool call iteration limit exceeded");
    }

    const toolOutputs = await Promise.all(
      toolCalls.map(async (call) => {
        const callId = call.call_id ?? call.id ?? "";
        console.log(`[gpt-5-cli] tool handling ${call.name} (${callId})`);
        const output = await executeFunctionToolCall(call, {
          cwd: process.cwd(),
          log: console.error,
        });
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
    response = await client.responses.create(followupRequest);
    iteration += 1;
  }
}

/**
 * d2モードで使用するファイルパスを検証し、コンテキスト情報を構築する。
 *
 * @param options CLIオプション。
 * @returns d2ファイルの存在情報。非d2モード時はundefined。
 */
function ensureD2Context(options: CliOptions): D2ContextInfo | undefined {
  if (options.taskMode !== "d2") {
    return undefined;
  }
  const cwd = process.cwd();
  const rawPath =
    options.d2FilePath && options.d2FilePath.trim().length > 0 ? options.d2FilePath : "diagram.d2";
  const absolutePath = path.resolve(cwd, rawPath);
  const normalizedRoot = path.resolve(cwd);
  if (!absolutePath.startsWith(`${normalizedRoot}${path.sep}`) && absolutePath !== normalizedRoot) {
    throw new Error(
      `Error: d2出力の保存先はカレントディレクトリ配下に指定してください: ${rawPath}`,
    );
  }
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) {
    throw new Error(`Error: 指定した d2 ファイルパスはディレクトリです: ${rawPath}`);
  }
  const relativePath = path.relative(normalizedRoot, absolutePath) || path.basename(absolutePath);
  options.d2FilePath = relativePath;
  const exists = fs.existsSync(absolutePath);
  return { relativePath, absolutePath, exists };
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
  ].join("\n");

  const workflow = [
    "作業手順:",
    `1. ${existenceNote}`,
    "2. 変更後は必ず d2_check を実行し、構文エラーを確認する",
    "3. エラーが無いことを確認したら d2_fmt を実行し、整形結果を確認する",
    "4. エラーが続く場合は修正しつつ 2〜3 を繰り返す",
    "5. 最終応答では、日本語で変更内容・ファイルパス・d2_check/d2_fmt の結果を要約し、D2コード全文は回答に貼らない",
  ].join("\n");

  const systemText = [
    "あなたは D2 ダイアグラムを作成・更新するアシスタントです。",
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
 * OpenAI Responses APIへ送信するリクエストを作成する。
 *
 * @param options CLIオプション。
 * @param context 対話コンテキスト。
 * @param inputText ユーザー入力本文。
 * @param systemPrompt システムプロンプト（任意）。
 * @param imageDataUrl 添付画像のデータURL。
 * @param defaults 既定値セット。
 * @param d2Context d2モード時のファイル情報。
 * @returns Responses APIリクエスト。
 */
export function buildRequest(
  options: CliOptions,
  context: ConversationContext,
  inputText: string,
  systemPrompt?: string,
  imageDataUrl?: string,
  defaults?: CliDefaults,
  d2Context?: D2ContextInfo,
): ResponseCreateParamsNonStreaming {
  const modelLog = formatModelValue(
    options.model,
    defaults?.modelMain ?? "",
    defaults?.modelMini ?? "",
    defaults?.modelNano ?? "",
  );
  const effortLog = formatScaleValue(options.effort);
  const verbosityLog = formatScaleValue(options.verbosity);

  console.log(
    `[gpt-5-cli] model=${modelLog}, effort=${effortLog}, verbosity=${verbosityLog}, continue=${options.continueConversation}`,
  );
  console.log(
    `[gpt-5-cli] resume_index=${options.resumeIndex ?? ""}, resume_list_only=${options.resumeListOnly}, delete_index=${
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

  if (options.taskMode === "d2" && d2Context) {
    inputMessages.push(...buildD2InstructionMessages(d2Context));
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

  const textConfig: ResponseTextConfigWithVerbosity = {
    verbosity: options.verbosity,
  };
  const inputForRequest = inputMessages as ResponseCreateParamsNonStreaming["input"];

  const request: ResponseCreateParamsNonStreaming = {
    model: options.model,
    reasoning: { effort: options.effort },
    text: textConfig,
    tools: buildToolList(),
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
      "[gpt-5-cli] warn: 直前の response.id が見つからないため、新規会話として開始します",
    );
  }

  return request;
}

/**
 * Responses APIの結果からアシスタント本文を抽出する。
 *
 * @param response APIレスポンス。
 * @returns アシスタントメッセージ本文。取得できない場合はnull。
 */
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

/**
 * OpenAIレスポンスの結果を履歴へ反映する。
 *
 * @param options CLIオプション。
 * @param context 対話コンテキスト。
 * @param historyStore 履歴ストア。
 * @param responseId 取得したレスポンスID。
 * @param userText ユーザー入力。
 * @param assistantText アシスタント出力。
 * @param d2Context d2モードコンテキスト。
 */
function historyUpsert(
  options: CliOptions,
  context: ConversationContext,
  historyStore: HistoryStore,
  responseId: string,
  userText: string,
  assistantText: string,
  d2Context?: D2ContextInfo,
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
    const newTask = buildTaskMetadata(options, context.activeEntry?.task, d2Context);
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
      task: newTask,
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
      const nextTask = buildTaskMetadata(options, entry.task, d2Context);
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
        task: nextTask,
      };
    }
    return entry;
  });

  if (updated) {
    historyStore.saveEntries(nextEntries);
    return;
  }

  const fallbackTask = buildTaskMetadata(options, context.activeEntry?.task, d2Context);
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
    task: fallbackTask,
  };
  nextEntries.push(fallbackEntry);
  historyStore.saveEntries(nextEntries);
}

/**
 * 履歴要約モードを実行し、選択した対話の概要を生成・保存する。
 *
 * @param options CLIオプション。
 * @param defaults 既定値セット。
 * @param historyStore 履歴ストア。
 * @param client OpenAIクライアント。
 */
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
  const header = "以下はこれまでの会話ログです。全てのメッセージを読んで要約に反映してください。";
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
  console.log(`[gpt-5-cli] compact: history=${options.compactIndex}, summarized=${turns.length}`);
  process.stdout.write(`${summaryText}\n`);
}

/**
 * CLIエントリーポイント。環境ロードからAPI呼び出しまでを統括する。
 */
async function main(): Promise<void> {
  try {
    loadEnvironment();
    const defaults = loadDefaults();
    console.log(`[gpt-5-cli] history_index: ${defaults.historyIndexPath}`);

    const options = parseArgs(process.argv.slice(2), defaults);
    const promptPath = resolvePromptPath(options.taskMode, defaults.promptsDir);
    const systemPrompt = loadPrompt(options.taskMode, defaults.promptsDir);
    if (systemPrompt) {
      const bytes = Buffer.byteLength(systemPrompt, "utf8");
      console.log(`[gpt-5-cli] system_prompt: loaded (${bytes} bytes) path=${promptPath}`);
    } else {
      console.error(`[gpt-5-cli] system_prompt: not found or empty path=${promptPath}`);
    }
    if (options.helpRequested) {
      printHelp(defaults, options);
      return;
    }

    if (options.taskMode === "d2" && options.operation === "compact") {
      throw new Error("Error: d2モードと --compact は併用できません");
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

    const d2Context = ensureD2Context(options);

    const imageInfo = prepareImageData(options.imagePath);
    const request = buildRequest(
      options,
      context,
      determine.inputText,
      systemPrompt,
      imageInfo.dataUrl,
      defaults,
      d2Context,
    );
    const response = await executeWithTools(client, request, options);
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
        d2Context,
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
