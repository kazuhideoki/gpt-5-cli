import { describe, expect, it } from "bun:test";
import { createCliToolLoggerOptions, updateCliLoggerLevel } from "./logger.js";
import type { CliLogger } from "../../foundation/logger/types.js";

function createLoggerStub() {
  const infoCalls: unknown[] = [];
  const transports: Array<{ level: string }> = [{ level: "info" }];
  const stub = {
    level: "info",
    transports,
    info: (message: unknown) => {
      infoCalls.push(message);
    },
    debug: () => undefined,
  };
  return {
    logger: stub as unknown as CliLogger,
    infoCalls,
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
