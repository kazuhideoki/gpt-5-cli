// cli-input.ts: CLI がユーザー入力を受け取る際の履歴操作とフロー分岐を提供する共通ユーティリティ。
// NOTE(pipeline/input): 各 CLI 固有の入力前処理は現状 CLI 側に残しており、共通化できる箇所には TODO を付与予定。
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { CliDefaults, CliOptions } from "../../types.js";
import type { HistoryEntry, HistoryStore } from "../history/store.js";
import { printHistoryDetail, printHistoryList } from "../history/output.js";

interface DetermineInputExit {
  kind: "exit";
  code: number;
}

interface DetermineInputResult<THistoryTask = unknown> {
  kind: "input";
  inputText: string;
  activeEntry?: HistoryEntry<THistoryTask>;
  previousResponseId?: string;
  previousTitle?: string;
}

type DetermineResult<THistoryTask = unknown> =
  | DetermineInputExit
  | DetermineInputResult<THistoryTask>;

export interface DetermineInputDependencies<
  TOptions extends CliOptions = CliOptions,
  THistoryTask = unknown,
> {
  printHelp: (defaults: CliDefaults, options: TOptions) => void;
  printHistoryList?: (store: HistoryStore<THistoryTask>) => void;
  printHistoryDetail?: (store: HistoryStore<THistoryTask>, index: number, noColor: boolean) => void;
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

/**
 * CLI のフラグと履歴ストアの状態から次の処理ステップを決定する。
 *
 * @param options 解析済み CLI オプション。
 * @param historyStore 履歴エントリの参照・更新を担うストア。
 * @param defaults 現在の CLI 既定値セット。
 * @param deps ヘルプ出力など CLI 実装側が差し込む依存性。
 * @throws {Error} 履歴再開時に取得した入力が空文字だった場合。
 */
export async function determineInput<TOptions extends CliOptions, THistoryTask = unknown>(
  options: TOptions,
  historyStore: HistoryStore<THistoryTask>,
  defaults: CliDefaults,
  deps: DetermineInputDependencies<TOptions, THistoryTask>,
): Promise<DetermineResult<THistoryTask>> {
  const renderHistoryList = deps.printHistoryList ?? printHistoryList;
  const renderHistoryDetail = deps.printHistoryDetail ?? printHistoryDetail;

  if (typeof options.deleteIndex === "number") {
    const { removedTitle } = historyStore.deleteByNumber(options.deleteIndex);
    console.log(`削除しました: ${options.deleteIndex}) ${removedTitle}`);
    return { kind: "exit", code: 0 };
  }

  if (typeof options.showIndex === "number") {
    renderHistoryDetail(historyStore, options.showIndex, Boolean(process.env.NO_COLOR));
    return { kind: "exit", code: 0 };
  }

  if (options.resumeListOnly) {
    renderHistoryList(historyStore);
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
