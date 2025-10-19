import { describe, expect, it } from "bun:test";
import type { HistoryEntry } from "../history/store.js";
import { createCliHistoryEntryFilter } from "./history-filter.js";

describe("createCliHistoryEntryFilter", () => {
  it("context に CLI 名が無い場合は許可する", () => {
    const filter = createCliHistoryEntryFilter("ask");
    const entry = { context: undefined } as HistoryEntry;
    expect(filter(entry)).toBe(true);
  });

  it("一致する CLI 名の履歴だけを許可する", () => {
    const filter = createCliHistoryEntryFilter("ask");
    const allowed = { context: { cli: "ask" } } as HistoryEntry;
    const denied = { context: { cli: "d2" } } as HistoryEntry;
    expect(filter(allowed)).toBe(true);
    expect(filter(denied)).toBe(false);
  });

  it("文字列以外の cli フィールドは無視する", () => {
    const filter = createCliHistoryEntryFilter("ask");
    const entry = { context: { cli: 123 } } as HistoryEntry;
    expect(filter(entry)).toBe(true);
  });
});
