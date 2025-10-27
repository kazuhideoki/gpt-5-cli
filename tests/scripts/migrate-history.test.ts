import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt5-cli-migrate-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("migrateHistory", () => {
  it("旧コンテキスト構造を absolute/relative/copy 形式へ変換する", () => {
    const inputPath = path.join(tempDir, "history.json");
    const outputPath = path.join(tempDir, "history.migrated.json");

    const legacyEntry = {
      context: {
        cli: "d2",
        file_path: "/abs/diagram.d2",
        output: {
          file: "diagram.d2",
          copy: true,
        },
      },
    };

    fs.writeFileSync(inputPath, `${JSON.stringify([legacyEntry], null, 2)}\n`, "utf8");

    const result = Bun.spawnSync([
      "bun",
      "run",
      "scripts/migrate-history.ts",
      "--input",
      inputPath,
      "--output",
      outputPath,
    ]);

    expect(result.exitCode).toBe(0);

    const migrated = JSON.parse(fs.readFileSync(outputPath, "utf8")) as Array<{
      context?: Record<string, unknown>;
    }>;

    expect(migrated).toHaveLength(1);
    const context = migrated[0]?.context as Record<string, unknown> | undefined;
    expect(context).toBeDefined();
    expect(context).toMatchObject({
      cli: "d2",
      absolute_path: "/abs/diagram.d2",
      relative_path: "diagram.d2",
      copy: true,
    });
  });
});
