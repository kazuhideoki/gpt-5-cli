/**
 * @file finalize 層のエントリーポイントに対するユニットテスト。
 */
import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { ConfigEnvironment } from "../../types.js";
import type { CliLogger } from "../../foundation/logger/types.js";
import type { FinalizeRequest } from "./types.js";
import { handleResult } from "./handle-result.js";

function createConfigEnv(values: Record<string, string | undefined> = {}): ConfigEnvironment {
  return {
    get: (key: string) => values[key],
    has: (key: string) => values[key] !== undefined,
    entries(): IterableIterator<readonly [key: string, value: string]> {
      const entries = Object.entries(values).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      );
      return entries[Symbol.iterator]();
    },
  };
}

interface MockStdin extends EventEmitter {
  end: (chunk: string, encoding?: BufferEncoding) => void;
}

interface MockClipboardChild extends EventEmitter {
  stdin: MockStdin;
}

function createLoggerStub() {
  const state: { logger: CliLogger } = { logger: undefined as unknown as CliLogger };
  const info = mock((..._args: unknown[]) => state.logger);
  const error = mock((..._args: unknown[]) => state.logger);
  const warn = mock((..._args: unknown[]) => state.logger);
  const debug = mock((..._args: unknown[]) => state.logger);
  const logger = {
    info,
    error,
    warn,
    debug,
    level: "info",
    transports: [],
  } as unknown as CliLogger;
  state.logger = logger;
  return { logger, info, error, warn, debug };
}

describe("handleResult", () => {
  it("既定のコンテンツを出力ハンドラーへ渡し、成果物メタデータを返す", async () => {
    const delivery = mock(async () => ({
      file: {
        absolutePath: "/workspace/out.txt",
        bytesWritten: 42,
      },
      copied: true,
    }));

    const request: FinalizeRequest = {
      content: "primary output",
      actions: [],
      output: {
        handler: delivery,
        params: {
          content: undefined,
          cwd: undefined,
          filePath: "out.txt",
          copy: undefined,
          copySource: undefined,
        },
      },
      configEnv: createConfigEnv(),
      stdout: undefined,
      history: undefined,
      exitCode: undefined,
      logger: createLoggerStub().logger,
    };

    const outcome = await handleResult(request);

    expect(delivery).toHaveBeenCalledTimes(1);
    const [firstCall] = delivery.mock.calls;
    expect(firstCall![0]).toMatchObject({
      content: "primary output",
      filePath: "out.txt",
    });
    expect(outcome.output).toEqual({
      filePath: "/workspace/out.txt",
      bytesWritten: 42,
      copied: true,
    });
  });

  it("履歴エフェクトを実行する", async () => {
    const historyEffect = mock(() => Promise.resolve());

    await handleResult({
      content: "history",
      actions: [],
      history: {
        run: historyEffect,
      },
      configEnv: createConfigEnv(),
      stdout: undefined,
      output: undefined,
      exitCode: undefined,
      logger: createLoggerStub().logger,
    });

    expect(historyEffect).toHaveBeenCalledTimes(1);
  });

  it("stdout と exitCode を上書きできる", async () => {
    const outcome = await handleResult({
      content: "fallback",
      stdout: "custom stdout",
      exitCode: 1,
      actions: [],
      configEnv: createConfigEnv(),
      output: undefined,
      history: undefined,
      logger: createLoggerStub().logger,
    });

    expect(outcome.stdout).toBe("custom stdout");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.output).toBeUndefined();
  });

  it("ConfigEnv を deliverOutput へ引き渡す", async () => {
    const configEnv = createConfigEnv({ SAMPLE_KEY: "value" });
    const delivery = mock(async () => ({ file: undefined }));

    await handleResult({
      content: "pass-through",
      actions: [],
      configEnv,
      output: {
        handler: delivery,
        params: {
          content: undefined,
          cwd: undefined,
          filePath: undefined,
          copy: undefined,
          copySource: undefined,
        },
      },
      stdout: undefined,
      history: undefined,
      exitCode: undefined,
      logger: createLoggerStub().logger,
    });

    expect(delivery).toHaveBeenCalledTimes(1);
    const [args] = delivery.mock.calls;
    expect(args?.[0]?.configEnv).toBe(configEnv);
  });

  it("clipboard アクションを優先順位順に実行する", async () => {
    const copied: string[] = [];
    const spawnMock = mock((command: string) => {
      if (command !== "pbcopy") {
        throw new Error(`Unexpected command: ${command}`);
      }
      const child = new EventEmitter() as MockClipboardChild;
      const stdin = new EventEmitter() as MockStdin;
      stdin.end = (chunk: string) => {
        copied.push(chunk);
        child.emit("close", 0);
      };
      child.stdin = stdin;
      return child as unknown as any;
    });

    mock.module("node:child_process", () => ({ spawn: spawnMock }));

    try {
      await handleResult({
        content: "fallback",
        actions: [
          {
            kind: "clipboard",
            flag: "--copy",
            source: { type: "content", value: "second" },
            workingDirectory: process.cwd(),
            priority: 20,
          },
          {
            kind: "clipboard",
            flag: "--copy",
            source: { type: "content", value: "first" },
            workingDirectory: process.cwd(),
            priority: 10,
          },
        ],
        configEnv: createConfigEnv(),
        stdout: undefined,
        output: undefined,
        history: undefined,
        exitCode: undefined,
        logger: createLoggerStub().logger,
      });
    } finally {
      mock.restore();
    }

    expect(copied).toEqual(["first", "second"]);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("logger へ成果物出力とアクション情報を記録する", async () => {
    const loggerStub = createLoggerStub();
    const delivery = mock(async () => ({
      file: {
        absolutePath: "/workspace/out.txt",
        bytesWritten: 128,
      },
      copied: true,
    }));

    await handleResult({
      content: "log target",
      actions: [],
      output: {
        handler: delivery,
        params: {
          content: undefined,
          cwd: undefined,
          filePath: "out.txt",
          copy: undefined,
          copySource: undefined,
        },
      },
      configEnv: createConfigEnv(),
      stdout: undefined,
      history: undefined,
      exitCode: undefined,
      logger: loggerStub.logger,
    });

    const debugMessages = loggerStub.debug.mock.calls.map((call) => call?.[0]);
    expect(
      debugMessages.some(
        (message) =>
          typeof message === "string" && message.includes("output file: /workspace/out.txt"),
      ),
    ).toBe(true);
    expect(
      debugMessages.some(
        (message) => typeof message === "string" && message.includes("copy: true"),
      ),
    ).toBe(true);
    expect(
      debugMessages.some(
        (message) => typeof message === "string" && message.includes("actions summary: count=0"),
      ),
    ).toBe(true);
  });
});
