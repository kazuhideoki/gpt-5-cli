import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { CliDefaults, CliOptions } from "../default-types.js";
import type { HistoryEntry, HistoryStore } from "../../core/history.js";

export interface DetermineInputExit {
  kind: "exit";
  code: number;
}

export interface DetermineInputResult<THistoryTask = unknown> {
  kind: "input";
  inputText: string;
  activeEntry?: HistoryEntry<THistoryTask>;
  previousResponseId?: string;
  previousTitle?: string;
}

export type DetermineResult<THistoryTask = unknown> =
  | DetermineInputExit
  | DetermineInputResult<THistoryTask>;

export interface DetermineInputDependencies<TOptions extends CliOptions = CliOptions> {
  printHelp: (defaults: CliDefaults, options: TOptions) => void;
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

export async function determineInput<TOptions extends CliOptions, THistoryTask = unknown>(
  options: TOptions,
  historyStore: HistoryStore<THistoryTask>,
  defaults: CliDefaults,
  deps: DetermineInputDependencies<TOptions>,
): Promise<DetermineResult<THistoryTask>> {
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
    deps.printHelp(defaults, options);
    return { kind: "exit", code: 1 };
  }

  return { kind: "input", inputText: options.args.join(" ") };
}
