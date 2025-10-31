/**
 * @file finalize アクション実行ランタイムの仕様テスト（d2-html アクション周り）。
 */
import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { ConfigEnvironment } from "../../../types.js";
import type { CliLogger } from "../../../foundation/logger/types.js";
import { executeFinalizeAction } from "./execute.js";

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

describe("executeFinalizeAction", () => {
  it("d2-html アクションで d2 コマンドを実行する", async () => {
    const spawnCalls: Array<{
      command: string;
      args: string[];
      options: Record<string, unknown>;
    }> = [];
    const spawnMock = mock((command: string, args: string[], options: Record<string, unknown>) => {
      spawnCalls.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => {
        child.emit("close", 0);
      });
      return child as unknown as any;
    });
    mock.module("node:child_process", () => ({ spawn: spawnMock }));

    try {
      const result = await executeFinalizeAction(
        {
          kind: "d2-html",
          sourcePath: "diagram.d2",
          htmlOutputPath: "diagram.html",
          workingDirectory: "/workspace",
          openHtml: false,
          priority: 30,
        },
        {
          logger: createLoggerStub().logger,
          configEnv: createConfigEnv(),
          defaultContent: "fallback",
        },
      );

      expect(result.copied).toBe(false);
    } finally {
      mock.restore();
    }

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [call] = spawnCalls;
    expect(call).toBeDefined();
    expect(call?.command).toBe("d2");
    expect(call?.args).toEqual(["--layout=elk", "diagram.d2", "diagram.html"]);
    expect(call?.options?.cwd).toBe("/workspace");
  });

  it("openHtml が有効な場合は HTML を規定アプリで開く", async () => {
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    const spawnMock = mock((command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => {
        child.emit("close", 0);
      });
      return child as unknown as any;
    });
    mock.module("node:child_process", () => ({ spawn: spawnMock }));

    try {
      await executeFinalizeAction(
        {
          kind: "d2-html",
          sourcePath: "diagram.d2",
          htmlOutputPath: "diagram.html",
          workingDirectory: "/workspace",
          openHtml: true,
          priority: 10,
        },
        {
          logger: createLoggerStub().logger,
          configEnv: createConfigEnv(),
          defaultContent: "fallback",
        },
      );
    } finally {
      mock.restore();
    }

    expect(spawnCalls.length).toBe(2);
    expect(spawnCalls[0]).toEqual({
      command: "d2",
      args: ["--layout=elk", "diagram.d2", "diagram.html"],
    });
    const openerCommand =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const openerArgs =
      process.platform === "win32" ? ["/c", "start", "", "diagram.html"] : ["diagram.html"];
    expect(spawnCalls[1]).toEqual({
      command: openerCommand,
      args: openerArgs,
    });
  });

  it("logger にアクション開始と成功を記録する", async () => {
    const spawnMock = mock(
      (_command: string, _args: string[], _options: Record<string, unknown>) => {
        const child = new EventEmitter();
        queueMicrotask(() => {
          child.emit("close", 0);
        });
        return child as unknown as any;
      },
    );
    mock.module("node:child_process", () => ({ spawn: spawnMock }));

    const loggerStub = createLoggerStub();

    try {
      await executeFinalizeAction(
        {
          kind: "d2-html",
          sourcePath: "diagram.d2",
          htmlOutputPath: "diagram.html",
          workingDirectory: "/workspace",
          openHtml: false,
          priority: 25,
        },
        {
          logger: loggerStub.logger,
          configEnv: createConfigEnv(),
          defaultContent: "fallback",
        },
      );
    } finally {
      mock.restore();
    }

    expect(loggerStub.debug).toHaveBeenCalled();
    const messages = loggerStub.debug.mock.calls.map((call) => call?.[0]);
    expect(messages[0]).toContain("action start: --open-html (priority=25)");
    expect(messages).toContain("[gpt-5-cli finalize] action success: --open-html");
  });

  it("logger に失敗を記録し例外を伝播する", async () => {
    const spawnMock = mock(
      (_command: string, _args: string[], _options: Record<string, unknown>) => {
        const child = new EventEmitter();
        queueMicrotask(() => {
          child.emit("close", 1);
        });
        return child as unknown as any;
      },
    );
    mock.module("node:child_process", () => ({ spawn: spawnMock }));

    const loggerStub = createLoggerStub();

    try {
      await expect(
        executeFinalizeAction(
          {
            kind: "d2-html",
            sourcePath: "diagram.d2",
            htmlOutputPath: "diagram.html",
            workingDirectory: "/workspace",
            openHtml: false,
            priority: 50,
          },
          {
            logger: loggerStub.logger,
            configEnv: createConfigEnv(),
            defaultContent: "fallback",
          },
        ),
      ).rejects.toThrow("command exited with non-zero code");
    } finally {
      mock.restore();
    }

    expect(loggerStub.debug).toHaveBeenCalled();
    const startMessage = loggerStub.debug.mock.calls[0]?.[0];
    expect(startMessage).toContain("action start: --open-html (priority=50)");
    expect(loggerStub.error).toHaveBeenCalled();
    const errorMessage = loggerStub.error.mock.calls[0]?.[0];
    expect(errorMessage).toContain("action failure: --open-html");
  });
});
