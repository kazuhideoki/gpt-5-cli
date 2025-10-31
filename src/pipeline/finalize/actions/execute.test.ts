/**
 * @file finalize アクション実行ランタイムの仕様テスト（d2-html アクション周り）。
 */
import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { ConfigEnvironment } from "../../../types.js";
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

  it("logger にアクション開始と成功を記録する", () => {
    /* TODO: implement */
  });

  it("logger に失敗を記録し例外を伝播する", () => {
    /* TODO: implement */
  });
});
