// create-cli-logger.test.ts: createCliLogger の仕様テスト。
import { describe, expect, it } from "bun:test";
import type { TransformableInfo } from "logform";
import { createCliLogger } from "./create-cli-logger.js";

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
    const logger = createCliLogger({ task: "ask", label: LABEL, debug: false });
    const info: TransformableInfo = {
      level: "info",
      message: "hello",
      label: LABEL,
      timestamp: "2025-03-01T10:00:00.000Z",
    };
    const formatted = logger.format.transform(info, logger.format.options ?? {});
    expect(formatted).toBeDefined();
    expect(formatted?.[Symbol.for("message")]).toContain(`[${LABEL}]`);
    expect(formatted?.[Symbol.for("message")]).toContain("hello");
  });

  it("モード情報をメタデータとして保持する", () => {
    const logger = createCliLogger({ task: "mermaid", label: "mermaid", debug: false });
    expect(logger.defaultMeta).toEqual({ task: "mermaid" });
  });
});
