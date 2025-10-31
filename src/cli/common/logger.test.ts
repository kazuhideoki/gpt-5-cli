import { describe, expect, it } from "bun:test";
import { createCliToolLoggerOptions, updateCliLoggerLevel } from "./logger.js";
import type { CliLogger } from "../../foundation/logger/types.js";

function createLoggerStub() {
  const infoCalls: unknown[] = [];
  const debugCalls: unknown[] = [];
  const transports: Array<{ level: string }> = [{ level: "info" }];
  const stub = {
    level: "info",
    transports,
    info: (message: unknown) => {
      infoCalls.push(message);
    },
    debug: (message: unknown) => {
      debugCalls.push(message);
    },
  };
  return {
    logger: stub as unknown as CliLogger,
    infoCalls,
    debugCalls,
  };
}

describe("createCliToolLoggerOptions", () => {
  it("CLI ロガーを通じてツールの情報ログを出力する", () => {
    const stub = createLoggerStub();
    const options = createCliToolLoggerOptions({
      logger: stub.logger,
      logLabel: "[test-cli]",
      debugEnabled: false,
    });
    const executionContext = options.createExecutionContext?.();
    if (!executionContext) {
      throw new Error("createExecutionContext should be defined");
    }
    executionContext.log("tool runs");
    expect(stub.infoCalls).toEqual(["tool runs"]);
  });

  it("debugEnabled が true の場合にデバッグログを流す", () => {
    const stub = createLoggerStub();
    const options = createCliToolLoggerOptions({
      logger: stub.logger,
      logLabel: "[test-cli]",
      debugEnabled: true,
    });
    expect(typeof options.debugLog).toBe("function");
    options.debugLog?.("detail");
    expect(stub.debugCalls).toEqual(["detail"]);
  });

  it("debugEnabled が false の場合はデバッグログを登録しない", () => {
    const stub = createLoggerStub();
    const options = createCliToolLoggerOptions({
      logger: stub.logger,
      logLabel: "[test-cli]",
      debugEnabled: false,
    });
    expect(options.debugLog).toBeUndefined();
  });
});

describe("updateCliLoggerLevel", () => {
  it("ロガーと全トランスポートのレベルを更新する", () => {
    const stub = createLoggerStub();
    const options = createCliToolLoggerOptions({
      logger: stub.logger,
      logLabel: "[test-cli]",
      debugEnabled: false,
    });
    const executionContext = options.createExecutionContext?.();
    if (!executionContext) {
      throw new Error("createExecutionContext should be defined");
    }
    executionContext.log("info");
    expect(stub.infoCalls.length).toBe(1);

    updateCliLoggerLevel(stub.logger, "debug");
    for (const transport of stub.logger.transports) {
      expect(transport.level).toBe("debug");
    }
    expect(stub.logger.level).toBe("debug");
  });
});
