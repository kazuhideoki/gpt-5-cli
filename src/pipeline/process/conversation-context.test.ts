import { describe, expect, it } from "bun:test";
import type { CliOptions } from "../../core/types.js";
import type { HistoryEntry, HistoryStore } from "../../core/history.js";
import { computeContext } from "./conversation-context.js";

interface TestHistoryTask {
  note?: string;
}

function createOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    model: "gpt-5-nano",
    effort: "low",
    verbosity: "low",
    continueConversation: false,
    debug: false,
    taskMode: "ask",
    outputPath: undefined,
    outputExplicit: false,
    copyOutput: false,
    copyExplicit: false,
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

describe("computeContext", () => {
  it("新規会話では最新履歴が無くても isNewConversation を維持しタイトルを生成する", () => {
    const options = createOptions({
      continueConversation: false,
      args: ["最初の 問い合わせ"],
    });
    const historyStore = {
      findLatest: () => undefined,
    } as unknown as HistoryStore<TestHistoryTask>;

    const context = computeContext(options, historyStore, "最初の 問い合わせ");

    expect(context.isNewConversation).toBe(true);
    expect(context.previousResponseId).toBeUndefined();
    expect(context.titleToUse).toBe("最初の 問い合わせ");
    expect(context.resumeBaseMessages).toHaveLength(0);
    expect(options.model).toBe("gpt-5-nano");
  });

  it("継続会話では最新履歴を引き継ぎ、summary を system メッセージとして反映する", () => {
    const options = createOptions({
      continueConversation: true,
      hasExplicitHistory: false,
      model: "gpt-5-nano",
      effort: "low",
      verbosity: "low",
    });
    const latestEntry: HistoryEntry<TestHistoryTask> = {
      title: "前回の質問",
      model: "gpt-5-mini",
      effort: "high",
      verbosity: "medium",
      last_response_id: "resp_latest",
      resume: {
        mode: "continue",
        previous_response_id: "resp_prev",
        summary: {
          text: "要約テキスト",
          created_at: "2025-01-01T00:00:00Z",
        },
      },
    };
    let synchronized = false;
    const historyStore = {
      findLatest: () => latestEntry,
    } as unknown as HistoryStore<TestHistoryTask>;

    const context = computeContext(
      options,
      historyStore,
      "続きの質問をしたい",
      undefined,
      undefined,
      undefined,
      {
        logLabel: "[test-cli]",
        synchronizeWithHistory: ({ activeEntry }) => {
          expect(activeEntry).toBe(latestEntry);
          synchronized = true;
        },
      },
    );

    expect(context.isNewConversation).toBe(false);
    expect(context.previousResponseId).toBe("resp_prev");
    expect(context.titleToUse).toBe("前回の質問");
    expect(context.resumeBaseMessages).toHaveLength(1);
    expect(context.resumeBaseMessages[0]).toEqual({
      role: "system",
      content: [{ type: "input_text", text: "要約テキスト" }],
    });
    expect(options.model).toBe("gpt-5-mini");
    expect(options.effort).toBe("high");
    expect(options.verbosity).toBe("medium");
    expect(synchronized).toBe(true);
  });
});
