/**
 * @file SQL モード用ユーティリティの単体テスト。select 判定と sqruff 呼び出しの基礎挙動を検証する。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatWithSqruff, isSelectOnly } from "./sql.js";

const ORIGINAL_SQRUFF_BIN = process.env.SQRUFF_BIN;

afterEach(() => {
  if (ORIGINAL_SQRUFF_BIN === undefined) {
    delete process.env.SQRUFF_BIN;
  } else {
    process.env.SQRUFF_BIN = ORIGINAL_SQRUFF_BIN;
  }
});

describe("isSelectOnly", () => {
  it("SELECT 文や WITH 句を許可する", () => {
    expect(isSelectOnly("SELECT * FROM users")).toBe(true);
    expect(
      isSelectOnly(`
        -- comment
        WITH latest AS (
          SELECT * FROM orders
        )
        SELECT * FROM latest;
      `),
    ).toBe(true);
  });

  it("INSERT などの更新系は拒否する", () => {
    expect(isSelectOnly("INSERT INTO users VALUES (1)")).toBe(false);
    expect(isSelectOnly("/* comment */ DELETE FROM users")).toBe(false);
  });
});

describe("formatWithSqruff", () => {
  it("指定したバイナリで整形できる", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqruff-test-"));
    const script = join(dir, "sqruff.sh");
    const lines = [
      "#!/bin/sh",
      "if [ \"$1\" != \"fix\" ]; then exit 1; fi",
      "input=$2",
      'tmp="$' + '{' + 'input}.tmp"',
      "tr '[:lower:]' '[:upper:]' < \"$input\" > \"$tmp\"",
      'mv "$tmp" "$input"',
      "exit 0",
    ];
    writeFileSync(script, `${lines.join("\n")}\n`, { mode: 0o755 });
    chmodSync(script, 0o755);
    process.env.SQRUFF_BIN = script;

    const formatted = await formatWithSqruff("select 1;\n");
    expect(formatted).toBe("SELECT 1;\n");
  });

  it("整形バイナリが失敗した場合はエラーを投げる", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqruff-test-"));
    const script = join(dir, "sqruff-fail.sh");
    const failLines = ["#!/bin/sh", "echo failure >&2", "exit 2"];
    writeFileSync(script, `${failLines.join("\n")}\n`, { mode: 0o755 });
    chmodSync(script, 0o755);
    process.env.SQRUFF_BIN = script;

    await expect(formatWithSqruff("select 1")).rejects.toThrow("sqruff failed with exit code 2");
  });
});
