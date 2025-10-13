import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { bootstrapCli } from "./runner.js";
import type { CliDefaults, CliOptions } from "../types.js";

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
    taskMode: "default",
    resumeListOnly: false,
    operation: "ask",
    args: [],
    modelExplicit: false,
    effortExplicit: false,
    verbosityExplicit: false,
    taskModeExplicit: false,
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
  fs.writeFileSync(path.join(promptsDir, "default.md"), "test system prompt", "utf8");

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
  it("履歴ストアとプロンプトを準備して返す", () => {
    const parseArgs = (argv: string[], defaults: CliDefaults): CliOptions => {
      expect(argv).toEqual(["質問"]);
      return createOptions(defaults, { args: ["質問"] });
    };
    const printHelp = () => {
      throw new Error("should not be called");
    };

    const result = bootstrapCli({
      argv: ["質問"],
      logLabel: "[test-cli]",
      parseArgs,
      printHelp,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("unreachable");
    }
    expect(result.defaults.historyIndexPath).toBe(process.env.GPT_5_CLI_HISTORY_INDEX_FILE);
    expect(result.systemPrompt).toBe("test system prompt");
    expect(result.options.args).toEqual(["質問"]);
  });

  it("ヘルプ要求時はprintHelpを呼び出して終了する", () => {
    let helpCalled = false;
    const parseArgs = (argv: string[], defaults: CliDefaults): CliOptions => {
      expect(argv).toEqual(["--help"]);
      return createOptions(defaults, { helpRequested: true });
    };
    const printHelp = () => {
      helpCalled = true;
    };

    const result = bootstrapCli({
      argv: ["--help"],
      logLabel: "[test-cli]",
      parseArgs,
      printHelp,
    });

    expect(helpCalled).toBe(true);
    expect(result.status).toBe("help");
    expect("historyStore" in result).toBe(false);
  });
});
