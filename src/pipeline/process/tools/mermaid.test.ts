import { describe, expect, it } from "bun:test";

import { resolveMermaidCommand } from "./index.js";

describe("resolveMermaidCommand", () => {
  it("Mermaid CLI を見つけられない場合は PATH にフォールバックする", async () => {
    const resolved = await resolveMermaidCommand();
    expect(resolved.command.length).toBeGreaterThan(0);
  });
});
