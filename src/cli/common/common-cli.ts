import { Command, CommanderError, InvalidArgumentError } from "commander";
import { z } from "zod";
import type { CliDefaults, CommonCliOptions } from "../../types.js";
import {
  expandLegacyShortFlags,
  parseEffortFlag,
  parseHistoryFlag,
  parseModelFlag,
  parseVerbosityFlag,
} from "../../pipeline/input/options.js";
import type { CommonCliParseResult, CommonCommandBuildOptions } from "./types.js";

const HELP_FLAGS = "-?, --help";
const HELP_DESCRIPTION = "ヘルプを表示します";
const COMPACT_ERROR_MESSAGE = "Error: --compact の履歴番号は正の整数で指定してください";
const ITERATIONS_PARSE_MESSAGE = "Error: --iterations の値は正の整数で指定してください";
const ITERATIONS_MIN_MESSAGE = "Error: --iterations の値は 1 以上で指定してください";

const commonCliOptionsSchema = z.object({
  model: z.string(),
  effort: z.enum(["low", "medium", "high"]),
  verbosity: z.enum(["low", "medium", "high"]),
  continueConversation: z.boolean(),
  debug: z.boolean(),
  maxIterations: z.number(),
  maxIterationsExplicit: z.boolean(),
  responseOutputPath: z.union([z.string().min(1), z.undefined()]),
  responseOutputExplicit: z.boolean(),
  copyOutput: z.boolean(),
  copyExplicit: z.boolean(),
  resumeIndex: z.union([z.number(), z.undefined()]),
  resumeListOnly: z.boolean(),
  deleteIndex: z.union([z.number(), z.undefined()]),
  showIndex: z.union([z.number(), z.undefined()]),
  imagePath: z.union([z.string(), z.undefined()]),
  operation: z.union([z.literal("ask"), z.literal("compact")]),
  compactIndex: z.union([z.number(), z.undefined()]),
  args: z.array(z.string()),
  modelExplicit: z.boolean(),
  effortExplicit: z.boolean(),
  verbosityExplicit: z.boolean(),
  hasExplicitHistory: z.boolean(),
  helpRequested: z.boolean(),
});

function configureProgramBehavior(program: Command): void {
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
}

function registerCommonOptions(program: Command, defaults: CliDefaults): void {
  const parseCompactIndex = (value: string): number => {
    if (!/^\d+$/u.test(value)) {
      throw new InvalidArgumentError(COMPACT_ERROR_MESSAGE);
    }
    return Number.parseInt(value, 10);
  };

  const parseIterations = (value: string): number => {
    if (!/^\d+$/u.test(value)) {
      throw new InvalidArgumentError(ITERATIONS_PARSE_MESSAGE);
    }
    const parsed = Number.parseInt(value, 10);
    if (parsed <= 0) {
      throw new InvalidArgumentError(ITERATIONS_MIN_MESSAGE);
    }
    return parsed;
  };

  program
    .option(
      "-m, --model <index>",
      "モデルを選択 (0/1/2)",
      (value) => parseModelFlag(value, defaults),
      defaults.modelNano,
    )
    .option("-e, --effort <index>", "effort を選択 (0/1/2)", parseEffortFlag, defaults.effort)
    .option(
      "-v, --verbosity <index>",
      "verbosity を選択 (0/1/2)",
      parseVerbosityFlag,
      defaults.verbosity,
    )
    .option("-c, --continue-conversation", "直前の会話から継続します")
    .option("-r, --resume [index]", "指定した番号の履歴から継続します")
    .option("-d, --delete [index]", "指定した番号の履歴を削除します")
    .option("-s, --show [index]", "指定した番号の履歴を表示します")
    .option("--debug", "デバッグログを有効化します")
    .option("-i, --image <path>", "画像ファイルを添付します")
    .option("-o, --output <path>", "結果を保存するファイルパスを指定します")
    .option("--copy", "結果をクリップボードにコピーします")
    .option(
      "-I, --iterations <count>",
      "イテレーション上限を指定します",
      parseIterations,
      defaults.maxIterations,
    )
    .option("--compact <index>", "指定した履歴を要約します", parseCompactIndex);
}

export function buildCommonCommand(options: CommonCommandBuildOptions): Command {
  const { defaults, argument, extraOptionRegistrars } = options;
  const program = new Command();
  configureProgramBehavior(program);
  program.helpOption(HELP_FLAGS, HELP_DESCRIPTION);
  registerCommonOptions(program, defaults);
  for (const registrar of extraOptionRegistrars) {
    registrar(program);
  }
  program.argument(argument.tokens, argument.description);
  return program;
}

export function parseCommonOptions(
  argv: string[],
  defaults: CliDefaults,
  program: Command,
): CommonCliParseResult {
  const normalizedArgv = expandLegacyShortFlags(argv);
  let helpRequested = false;
  try {
    program.parse(normalizedArgv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed") {
        helpRequested = true;
      } else {
        throw new Error(error.message);
      }
    } else {
      throw error;
    }
  }

  const opts = program.opts<{
    model?: string;
    effort?: CommonCliOptions["effort"];
    verbosity?: CommonCliOptions["verbosity"];
    continueConversation?: boolean;
    resume?: string | boolean;
    delete?: string | boolean;
    show?: string | boolean;
    debug?: boolean;
    image?: string;
    output?: string;
    copy?: boolean;
    compact?: number;
    iterations?: number;
  }>();

  const args = program.args as string[];

  const model = opts.model ?? defaults.modelNano;
  const effort = opts.effort ?? defaults.effort;
  const verbosity = opts.verbosity ?? defaults.verbosity;
  const debug = Boolean(opts.debug);
  let continueConversation = Boolean(opts.continueConversation);
  let resumeIndex: number | undefined;
  let resumeListOnly = false;
  let deleteIndex: number | undefined;
  let showIndex: number | undefined;
  let hasExplicitHistory = false;
  const imagePath = opts.image;
  let responseOutputPath = typeof opts.output === "string" ? opts.output.trim() : undefined;
  if (responseOutputPath && responseOutputPath.length === 0) {
    responseOutputPath = undefined;
  }
  const copyOutput = Boolean(opts.copy);
  let operation: "ask" | "compact" = "ask";
  let compactIndex: number | undefined;

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
  const responseOutputExplicit = program.getOptionValueSource("output") === "cli";
  const copyExplicit = program.getOptionValueSource("copy") === "cli";
  const maxIterationsExplicit = program.getOptionValueSource("iterations") === "cli";
  const maxIterations =
    typeof opts.iterations === "number" ? opts.iterations : defaults.maxIterations;

  try {
    const optionsInput = {
      model,
      effort,
      verbosity,
      continueConversation,
      resumeIndex,
      resumeListOnly,
      deleteIndex,
      showIndex,
      imagePath,
      debug,
      maxIterations,
      maxIterationsExplicit,
      responseOutputPath,
      responseOutputExplicit,
      copyOutput,
      copyExplicit,
      operation,
      compactIndex,
      args,
      modelExplicit,
      effortExplicit,
      verbosityExplicit,
      hasExplicitHistory,
      helpRequested,
    } satisfies Record<keyof CommonCliOptions, unknown>;
    const options = commonCliOptionsSchema.parse(optionsInput) as CommonCliOptions;
    return { options, helpRequested };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const firstIssue = error.issues[0];
      throw new Error(firstIssue?.message ?? error.message);
    }
    throw error;
  }
}
