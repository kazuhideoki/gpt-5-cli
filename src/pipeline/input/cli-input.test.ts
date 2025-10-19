import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { CliDefaults, CliOptions } from "../../core/types.js";
import type { DetermineInputDependencies } from "./cli-input.js";
import type { HistoryEntry, HistoryStore } from "../../core/history.js";

const promptAnswers: string[] = [];
const promptQuestions: string[] = [];
let promptCloseCount = 0;

mock.module("node:readline/promises", () => ({
  createInterface: () => ({
    question: async (message: string) => {
      promptQuestions.push(message);
      return promptAnswers.shift() ?? "";
    },
    close: () => {
      promptCloseCount += 1;
    },
  }),
}));

const { determineInput } = await import("./cli-input.js");

const defaults: CliDefaults = {
  modelMain: "gpt-5-main",
  modelMini: "gpt-5-mini",
  modelNano: "gpt-5-nano",
  effort: "medium",
  verbosity: "medium",
  historyIndexPath: "/tmp/history.json",
  promptsDir: "/tmp/prompts",
  maxIterations: 6,
};

type HistoryStoreMethods = Pick<
  HistoryStore<unknown>,
  "deleteByNumber" | "showByNumber" | "listHistory" | "selectByNumber"
>;

function createOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    model: defaults.modelNano,
    effort: defaults.effort,
    verbosity: defaults.verbosity,
    continueConversation: false,
    debug: false,
    taskMode: "ask",
    resumeIndex: undefined,
    resumeListOnly: false,
    deleteIndex: undefined,
    showIndex: undefined,
    imagePath: undefined,
    operation: "ask",
    compactIndex: undefined,
    args: [],
    modelExplicit: false,
    effortExplicit: false,
    verbosityExplicit: false,
    hasExplicitHistory: false,
    helpRequested: false,
    ...overrides,
  };
}

function createHistoryStore(overrides: Partial<HistoryStoreMethods> = {}): HistoryStore<unknown> {
  const base: HistoryStoreMethods = {
    deleteByNumber: () => {
      throw new Error("deleteByNumber should not be called");
    },
    showByNumber: () => {
      throw new Error("showByNumber should not be called");
    },
    listHistory: () => {
      throw new Error("listHistory should not be called");
    },
    selectByNumber: () => {
      throw new Error("selectByNumber should not be called");
    },
  };
  return { ...base, ...overrides } as HistoryStore<unknown>;
}

function createDeps(
  printHelp?: DetermineInputDependencies["printHelp"],
): DetermineInputDependencies {
  return {
    printHelp:
      printHelp ??
      (() => {
        throw new Error("printHelp should not be called");
      }),
  };
}

beforeEach(() => {
  promptAnswers.length = 0;
  promptQuestions.length = 0;
  promptCloseCount = 0;
});

afterEach(() => {
  mock.restore();
});

describe("determineInput", () => {
  it("deleteIndexが指定されたとき履歴を削除して終了する", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(String(args[0]));
    };
    const deleteByNumber = mock((index: number) => {
      expect(index).toBe(2);
      return { removedTitle: "古い会話", removedId: "res-1" };
    });
    const historyStore = createHistoryStore({ deleteByNumber });
    const deps = createDeps(
      mock((defaultsArg: CliDefaults, optionsArg: CliOptions) => {
        throw new Error(
          `printHelp should not be called: ${defaultsArg.modelMain} ${optionsArg.model}`,
        );
      }),
    );

    try {
      const result = await determineInput(
        createOptions({ deleteIndex: 2 }),
        historyStore,
        defaults,
        deps,
      );
      expect(result).toEqual({ kind: "exit", code: 0 });
      expect(deleteByNumber).toHaveBeenCalledTimes(1);
      expect(logs).toEqual(["削除しました: 2) 古い会話"]);
    } finally {
      console.log = originalLog;
    }
  });

  it("showIndexが指定されたとき履歴を表示して終了する", async () => {
    const originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    const showByNumber = mock((index: number, noColor: boolean) => {
      expect(index).toBe(3);
      expect(noColor).toBe(true);
    });
    const historyStore = createHistoryStore({ showByNumber });
    const deps = createDeps();

    try {
      const result = await determineInput(
        createOptions({ showIndex: 3 }),
        historyStore,
        defaults,
        deps,
      );
      expect(result).toEqual({ kind: "exit", code: 0 });
      expect(showByNumber).toHaveBeenCalledTimes(1);
    } finally {
      if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = originalNoColor;
      }
    }
  });

  it("resumeListOnlyが設定されていると履歴一覧を出力して終了する", async () => {
    const listHistory = mock(() => {});
    const historyStore = createHistoryStore({ listHistory });
    const deps = createDeps();

    const result = await determineInput(
      createOptions({ resumeListOnly: true }),
      historyStore,
      defaults,
      deps,
    );

    expect(result).toEqual({ kind: "exit", code: 0 });
    expect(listHistory).toHaveBeenCalledTimes(1);
  });

  it("resumeIndexと引数がある場合は履歴を再開し入力を返す", async () => {
    const entry: HistoryEntry = {
      title: "過去の会話",
      last_response_id: "res-2",
    };
    const selectByNumber = mock((index: number) => {
      expect(index).toBe(4);
      return entry;
    });
    const historyStore = createHistoryStore({ selectByNumber });
    const deps = createDeps();

    const result = await determineInput(
      createOptions({ resumeIndex: 4, args: ["続き", "お願いします"] }),
      historyStore,
      defaults,
      deps,
    );

    expect(result.kind).toBe("input");
    if (result.kind !== "input") {
      throw new Error("unexpected result kind");
    }
    expect(result.inputText).toBe("続き お願いします");
    expect(result.activeEntry).toBe(entry);
    expect(result.previousResponseId).toBe("res-2");
    expect(result.previousTitle).toBe("過去の会話");
  });

  it("resumeIndex指定時にプロンプトで取得した入力をそのまま返す", async () => {
    promptAnswers.push("  新しい質問  ");
    const entry: HistoryEntry = {
      title: "再開対象",
      last_response_id: "res-3",
    };
    const selectByNumber = mock(() => entry);
    const historyStore = createHistoryStore({ selectByNumber });
    const deps = createDeps();

    const result = await determineInput(
      createOptions({ resumeIndex: 1 }),
      historyStore,
      defaults,
      deps,
    );

    expect(promptQuestions).toEqual(["プロンプト > "]);
    expect(promptCloseCount).toBe(1);
    expect(result.kind).toBe("input");
    if (result.kind !== "input") {
      throw new Error("unexpected result kind");
    }
    expect(result.inputText).toBe("  新しい質問  ");
    expect(result.activeEntry).toBe(entry);
    expect(result.previousResponseId).toBe("res-3");
  });

  it("resumeIndex指定時に空文字が入力された場合はエラーを投げる", async () => {
    promptAnswers.push("   ");
    const entry: HistoryEntry = {
      last_response_id: "res-4",
    };
    const selectByNumber = mock(() => entry);
    const historyStore = createHistoryStore({ selectByNumber });
    const deps = createDeps();

    await expect(
      determineInput(createOptions({ resumeIndex: 1 }), historyStore, defaults, deps),
    ).rejects.toThrow("プロンプトが空です。");
    expect(promptCloseCount).toBe(1);
  });

  it("引数が無い場合はヘルプを表示して終了コード1を返す", async () => {
    const printHelp = mock((receivedDefaults: CliDefaults, options: CliOptions) => {
      expect(receivedDefaults).toBe(defaults);
      expect(options.args).toEqual([]);
    });
    const deps = createDeps(printHelp);
    const historyStore = createHistoryStore();

    const result = await determineInput(createOptions(), historyStore, defaults, deps);

    expect(result).toEqual({ kind: "exit", code: 1 });
    expect(printHelp).toHaveBeenCalledTimes(1);
  });

  it("通常の入力は引数を結合して返す", async () => {
    const historyStore = createHistoryStore();
    const deps = createDeps();

    const result = await determineInput(
      createOptions({ args: ["bun", "test"] }),
      historyStore,
      defaults,
      deps,
    );

    expect(result).toEqual({ kind: "input", inputText: "bun test" });
  });
});
