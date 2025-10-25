/**
 * @file resolveResultOutput の振る舞いを検証するユニットテスト。
 */
import { describe, expect, it } from "bun:test";
import { resolveResultOutput } from "./result-output.js";

describe("resolveResultOutput", () => {
  it("明示的な --output が成果物と異なる場合は textOutputPath を返す", () => {
    const result = resolveResultOutput({
      responseOutputExplicit: true,
      responseOutputPath: "summary/output.txt",
      artifactPath: "artifacts/query.sql",
    });

    expect(result).toEqual({
      textOutputPath: "summary/output.txt",
      artifactReferencePath: "summary/output.txt",
    });
  });

  it("成果物と同一パスを指定した場合は textOutputPath を null にする", () => {
    const result = resolveResultOutput({
      responseOutputExplicit: true,
      responseOutputPath: "diagram.mmd",
      artifactPath: "diagram.mmd",
    });

    expect(result).toEqual({
      textOutputPath: null,
      artifactReferencePath: "diagram.mmd",
    });
  });

  it("--output が未指定の場合は成果物パスのみを返す", () => {
    const result = resolveResultOutput({
      responseOutputExplicit: false,
      responseOutputPath: undefined,
      artifactPath: "run.sql",
    });

    expect(result).toEqual({
      textOutputPath: null,
      artifactReferencePath: "run.sql",
    });
  });
});
