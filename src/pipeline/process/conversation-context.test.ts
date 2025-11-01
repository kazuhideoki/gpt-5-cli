import { describe, expect, it } from "bun:test";
import type { CliOptions } from "../../types.js";
import type { HistoryEntry, HistoryStore } from "../history/store.js";
import { computeContext } from "./conversation-context.js";
import type { CliLogger, CliLoggerConfig } from "../../foundation/logger/types.js";

interface TestHistoryTask {
  note?: string;
}

type LoggerMessages = Record<"info" | "warn" | "error" | "debug", string[]>;

function createTestLoggerConfig(overrides: { logLabel?: string; debugEnabled?: boolean } = {}): {
  config: CliLoggerConfig;
  messages: LoggerMessages;
} {
  const messages: LoggerMessages = {
    info: [],
    warn: [],
    error: [],
    debug: [],
  };

  const loggerRecord: Record<string, any> = {
    level: "info",
    transports: [],
    log: () => undefined,
  };

  for (const level of ["info", "warn", "error", "debug"] as const) {
    loggerRecord[level] = (message: unknown, ..._meta: unknown[]) => {
      messages[level].push(String(message ?? ""));
      return loggerRecord;
    };
  }

  return {
    config: {
      logger: loggerRecord as CliLogger,
      logLabel: overrides.logLabel ?? "[test-cli]",
      debugEnabled: overrides.debugEnabled ?? false,
    },
    messages,
  };
}

function createOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    model: "gpt-5-nano",
    effort: "low",
    verbosity: "low",
    continueConversation: false,
    debug: false,
    taskMode: "ask",
    maxIterations: 8,
    maxIterationsExplicit: false,
    resumeIndex: undefined,
    deleteIndex: undefined,
    showIndex: undefined,
    imagePath: undefined,
    responseOutputPath: undefined,
    responseOutputExplicit: false,
    copyOutput: false,
    copyExplicit: false,
    compactIndex: undefined,
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
    const { config: loggerConfig } = createTestLoggerConfig();

    const context = computeContext({
      options,
      historyStore,
      inputText: "最初の 問い合わせ",
      loggerConfig,
    });

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
    const { config: loggerConfig } = createTestLoggerConfig();

    const context = computeContext({
      options,
      historyStore,
      inputText: "続きの質問をしたい",
      config: {
        logLabel: "[test-cli]",
        synchronizeWithHistory: ({ activeEntry }) => {
          expect(activeEntry).toBe(latestEntry);
          synchronized = true;
        },
      },
      loggerConfig,
    });

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

  it("loggerConfig 経由で warn ログを出力する", () => {
    const options = createOptions({
      continueConversation: true,
      hasExplicitHistory: false,
    });
    const historyStore = {
      findLatest: () => undefined,
    } as unknown as HistoryStore<TestHistoryTask>;
    const { config: loggerConfig, messages } = createTestLoggerConfig();

    computeContext({
      options,
      historyStore,
      inputText: "次の質問",
      loggerConfig,
    });

    expect(
      messages.warn.some((message) => message.includes("継続できる履歴が見つかりません")),
    ).toBe(true);
  });
});
