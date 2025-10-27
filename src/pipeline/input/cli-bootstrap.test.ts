import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { bootstrapCli } from "./cli-bootstrap.js";
import { z } from "zod";
import type { CliDefaults, CliOptions } from "../../types.js";

interface TempResources {
  historyCleanup: () => void;
  promptsDir: string;
}

function createTempHistoryPath(): { historyPath: string; cleanup: () => void } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt5-cli-runner-test-"));
  const historyPath = path.join(tempDir, "history_index.json");
  return {
    historyPath,
    cleanup: () => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    },
  };
}

function createOptions(defaults: CliDefaults, overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    model: defaults.modelNano,
    effort: defaults.effort,
    verbosity: defaults.verbosity,
    continueConversation: false,
    debug: false,
    taskMode: "ask",
    resumeListOnly: false,
    operation: "ask",
    args: [],
    modelExplicit: false,
    effortExplicit: false,
    verbosityExplicit: false,
    hasExplicitHistory: false,
    helpRequested: false,
    ...overrides,
  };
}

let originalHistoryEnv: string | undefined;
let originalPromptsEnv: string | undefined;
let resources: TempResources;

beforeEach(() => {
  originalHistoryEnv = process.env.GPT_5_CLI_HISTORY_INDEX_FILE;
  originalPromptsEnv = process.env.GPT_5_CLI_PROMPTS_DIR;

  const { historyPath, cleanup } = createTempHistoryPath();
  const promptsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt5-cli-prompts-"));
  fs.writeFileSync(path.join(promptsDir, "ask.md"), "test system prompt", "utf8");

  process.env.GPT_5_CLI_HISTORY_INDEX_FILE = historyPath;
  process.env.GPT_5_CLI_PROMPTS_DIR = promptsDir;

  resources = { historyCleanup: cleanup, promptsDir };
});

afterEach(() => {
  if (originalHistoryEnv === undefined) {
    delete process.env.GPT_5_CLI_HISTORY_INDEX_FILE;
  } else {
    process.env.GPT_5_CLI_HISTORY_INDEX_FILE = originalHistoryEnv;
  }

  if (originalPromptsEnv === undefined) {
    delete process.env.GPT_5_CLI_PROMPTS_DIR;
  } else {
    process.env.GPT_5_CLI_PROMPTS_DIR = originalPromptsEnv;
  }

  resources.historyCleanup();
  fs.rmSync(resources.promptsDir, { recursive: true, force: true });
});

describe("bootstrapCli", () => {
  it("履歴ストアとプロンプトを準備して返す", async () => {
    const parseArgs = (argv: string[], defaults: CliDefaults): CliOptions => {
      expect(argv).toEqual(["質問"]);
      return createOptions(defaults, { args: ["質問"] });
    };

    const result = await bootstrapCli({
      argv: ["質問"],
      logLabel: "[test-cli]",
      parseArgs,
      historyContextSchema: z.object({}),
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("unreachable");
    }
    expect(result.defaults.historyIndexPath).toBe(process.env.GPT_5_CLI_HISTORY_INDEX_FILE);
    expect(result.systemPrompt).toBe("test system prompt");
    expect(result.options.args).toEqual(["質問"]);
  });

  it("ヘルプ要求時はヘルプ状態で終了する", async () => {
    const parseArgs = (argv: string[], defaults: CliDefaults): CliOptions => {
      expect(argv).toEqual(["--help"]);
      return createOptions(defaults, { helpRequested: true });
    };

    const result = await bootstrapCli({
      argv: ["--help"],
      logLabel: "[test-cli]",
      parseArgs,
      historyContextSchema: z.object({}),
    });

    expect(result.status).toBe("help");
    expect("historyStore" in result).toBe(false);
  });

  it("ConfigEnv の内容で defaults を構築する", async () => {
    const envRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-cli-config-env-"));
    const promptsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-cli-prompts-env-"));
    const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-cli-history-env-"));
    const historyPath = path.join(historyDir, "history-index.json");
    fs.writeFileSync(path.join(promptsDir, "ask.md"), "prompt from env", "utf8");

    fs.writeFileSync(
      path.join(envRoot, ".env"),
      [
        `GPT_5_CLI_HISTORY_INDEX_FILE=${historyPath}`,
        `GPT_5_CLI_PROMPTS_DIR=${promptsDir}`,
        "GPT_5_CLI_MAX_ITERATIONS=7",
        "OPENAI_DEFAULT_EFFORT=medium",
        "OPENAI_DEFAULT_VERBOSITY=high",
      ].join("\n"),
      "utf8",
    );

    const parseArgs = (argv: string[], defaults: CliDefaults): CliOptions => {
      expect(argv).toEqual(["--mode"]);
      expect(defaults.maxIterations).toBe(7);
      expect(defaults.effort).toBe("medium");
      expect(defaults.verbosity).toBe("high");
      return createOptions(defaults, { args: ["--mode"] });
    };

    try {
      const result = await bootstrapCli({
        argv: ["--mode"],
        logLabel: "[test-cli]",
        parseArgs,
        historyContextSchema: z.object({}),
        envFileSuffix: "ask",
        configEnvOptions: { baseDir: envRoot },
      });

      expect(result.status).toBe("ready");
      if (result.status !== "ready") {
        throw new Error("unreachable");
      }
      expect(result.defaults.historyIndexPath).toBe(path.resolve(historyPath));
      expect(result.defaults.promptsDir).toBe(path.resolve(promptsDir));
      expect(result.configEnv.get("GPT_5_CLI_PROMPTS_DIR")).toBe(promptsDir);
      expect(result.options.args).toEqual(["--mode"]);
    } finally {
      fs.rmSync(envRoot, { recursive: true, force: true });
      fs.rmSync(promptsDir, { recursive: true, force: true });
      fs.rmSync(historyDir, { recursive: true, force: true });
    }
  });
});
