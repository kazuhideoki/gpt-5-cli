import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ConfigEnvironment } from "../../types.js";
import {
  decorateLevelValue,
  formatModelValue,
  formatScaleValue,
  levelForModelValue,
  levelForScaleValue,
} from "./log-format.js";

const originalNoColor = process.env.NO_COLOR;
const hadOriginalStderrIsTTY = Object.hasOwn(process.stderr, "isTTY");
const originalStderrIsTTY = process.stderr.isTTY;

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

function restoreNoColor(): void {
  if (originalNoColor === undefined) {
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = originalNoColor;
  }
}

function restoreIsTTY(): void {
  if (hadOriginalStderrIsTTY) {
    process.stderr.isTTY = originalStderrIsTTY;
  } else {
    delete process.stderr.isTTY;
  }
}

beforeEach(() => {
  restoreNoColor();
  restoreIsTTY();
});

afterEach(() => {
  restoreNoColor();
  restoreIsTTY();
});

describe("levelForScaleValue", () => {
  it("正規化してレベルを返す", () => {
    expect(levelForScaleValue("LOW")).toBe("low");
    expect(levelForScaleValue("Medium")).toBe("medium");
    expect(levelForScaleValue("hIgH")).toBe("high");
  });

  it("未知の値は high と判定する", () => {
    expect(levelForScaleValue("something")).toBe("high");
  });
});

describe("levelForModelValue", () => {
  const main = "gpt-5";
  const mini = "gpt-5-mini";
  const nano = "gpt-5-nano";

  it("既定モデル名を正しくマッピングする", () => {
    expect(levelForModelValue(main, main, mini, nano)).toBe("high");
    expect(levelForModelValue(mini, main, mini, nano)).toBe("medium");
    expect(levelForModelValue(nano, main, mini, nano)).toBe("low");
  });

  it("名称からヒューリスティックでレベル推定する", () => {
    expect(levelForModelValue("my-nano", main, mini, nano)).toBe("low");
    expect(levelForModelValue("super-lite", main, mini, nano)).toBe("low");
    expect(levelForModelValue("legacy-mini", main, mini, nano)).toBe("medium");
    expect(levelForModelValue("custom-base", main, mini, nano)).toBe("medium");
    expect(levelForModelValue("enterprise-pro", main, mini, nano)).toBe("high");
  });
});

describe("decorateLevelValue", () => {
  it("スタイルがあれば medium/high の文字列を装飾する", () => {
    delete process.env.NO_COLOR;
    process.stderr.isTTY = true;
    expect(decorateLevelValue("value", "low")).toBe("value");
    expect(decorateLevelValue("value", "medium")).toBe("\u001b[33m+value+\u001b[0m");
    expect(decorateLevelValue("value", "high")).toBe("\u001b[1;31m!value!\u001b[0m");
  });

  it("NO_COLOR 環境でも強調記号は残る", () => {
    process.env.NO_COLOR = "1";
    process.stderr.isTTY = true;
    expect(decorateLevelValue("value", "high")).toBe("!value!");
  });
});

describe("formatModelValue / formatScaleValue", () => {
  const main = "gpt-5";
  const mini = "gpt-5-mini";
  const nano = "gpt-5-nano";

  it("モデル値をスタイル付きで表示する", () => {
    delete process.env.NO_COLOR;
    process.stderr.isTTY = true;
    expect(formatModelValue(mini, main, mini, nano)).toBe("\u001b[33m+gpt-5-mini+\u001b[0m");
    expect(formatModelValue(main, main, mini, nano)).toBe("\u001b[1;31m!gpt-5!\u001b[0m");
  });

  it("尺度値をスタイル付きで表示する", () => {
    delete process.env.NO_COLOR;
    process.stderr.isTTY = true;
    expect(formatScaleValue("medium")).toBe("\u001b[33m+medium+\u001b[0m");
    expect(formatScaleValue("high")).toBe("\u001b[1;31m!high!\u001b[0m");
    expect(formatScaleValue("low")).toBe("low");
  });

  it("NO_COLOR 環境でも記号は維持される", () => {
    process.env.NO_COLOR = "1";
    process.stderr.isTTY = true;
    expect(formatModelValue(main, main, mini, nano)).toBe("!gpt-5!");
    expect(formatScaleValue("medium")).toBe("+medium+");
  });

  it("ConfigEnv による NO_COLOR 設定を参照する", () => {
    delete process.env.NO_COLOR;
    process.stderr.isTTY = true;
    const configEnv = createConfigEnv({ NO_COLOR: "1" });
    const decorateWithConfig = decorateLevelValue as unknown as (
      value: string,
      level: "low" | "medium" | "high",
      configEnv: ConfigEnvironment,
    ) => string;

    expect(decorateWithConfig("value", "high", configEnv)).toBe("!value!");
  });
});
