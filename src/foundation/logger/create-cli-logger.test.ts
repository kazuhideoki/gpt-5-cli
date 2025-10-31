// create-cli-logger.test.ts: createCliLogger の仕様テスト。
import { describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import { transports } from "winston";
import { createCliLogger } from "./create-cli-logger.js";
import type { CliLoggerParams, CliLogger } from "./types.js";

const LABEL = "ask";

describe("createCliLogger", () => {
  it("debug フラグが false の場合は info レベルで初期化する", () => {
    const logger = createCliLogger({ task: "ask", label: LABEL, debug: false });
    expect(logger.level).toBe("info");
  });

  it("debug フラグが true の場合は debug レベルで初期化する", () => {
    const logger = createCliLogger({ task: "ask", label: LABEL, debug: true });
    expect(logger.level).toBe("debug");
  });

  it("ラベル付きフォーマットでログを出力する", () => {
    const { logger, messages, dispose } = createStreamLogger({
      task: "ask",
      label: LABEL,
      debug: false,
    });
    try {
      logger.info("hello");
    } finally {
      dispose();
    }
    expect(messages[0]).toMatch(/^\[ask] .* info: hello/);
  });

  it("追加メタデータを JSON として末尾に付与する", () => {
    const { logger, messages, dispose } = createStreamLogger({
      task: "ask",
      label: LABEL,
      debug: false,
    });
    try {
      logger.info("hello", { extra: "value" });
    } finally {
      dispose();
    }
    expect(messages[0]).toContain('"extra":"value"');
  });

  it("BigInt を含むメタデータも安全にシリアライズする", () => {
    const { logger, messages, dispose } = createStreamLogger({
      task: "ask",
      label: LABEL,
      debug: false,
    });
    try {
      logger.info("hello", { bigintValue: BigInt(42) });
    } finally {
      dispose();
    }
    expect(messages[0]).toContain('"bigintValue":"42"');
  });

  it("format.splat の追加引数を splat メタデータとして残す", () => {
    const { logger, messages, dispose } = createStreamLogger({
      task: "ask",
      label: LABEL,
      debug: false,
    });
    try {
      logger.info("hello %s", "world", { foo: 1 });
    } finally {
      dispose();
    }
    expect(messages[0]).toContain('"splat":["world"]');
    expect(messages[0]).toContain('"foo":1');
  });

  it("モード情報をメタデータとして保持する", () => {
    const logger = createCliLogger({ task: "mermaid", label: "mermaid-cli", debug: false });
    expect(logger.defaultMeta).toEqual({ task: "mermaid" });
  });
});

function createStreamLogger(params: CliLoggerParams): {
  logger: CliLogger;
  messages: string[];
  dispose: () => void;
} {
  const logger = createCliLogger(params);
  const messages: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      messages.push(chunk.toString().trim());
      callback();
    },
  });
  const streamTransport = new transports.Stream({
    stream: sink,
    level: logger.level,
  });
  logger.clear();
  logger.add(streamTransport);
  return {
    logger,
    messages,
    dispose: () => {
      logger.remove(streamTransport);
      sink.end();
    },
  };
}
