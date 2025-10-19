/**
 * CLI フラグの正規化と検証を提供するユーティリティ。
 * pipeline/input 層から履歴番号やモデル指定などの入力解析を統一する。
 */
import { InvalidArgumentError } from "commander";
import { z } from "zod";
import type { CliDefaults, EffortLevel, VerbosityLevel } from "../../core/types.js";

/** CLI 履歴番号フラグを数値に変換するスキーマ。 */
const historyIndexSchema = z
  .string()
  .regex(/^\d+$/u, "Error: 履歴番号は正の整数で指定してください")
  .transform((value) => Number.parseInt(value, 10));

/** 履歴系フラグの入力値（有効化 or 指定番号）を検証するスキーマ。 */
const historyFlagSchema = z.union([z.literal(true), historyIndexSchema]);

/** 履歴フラグ解析後の結果。 */
interface HistoryFlagParseResult {
  index?: number;
  listOnly: boolean;
}

/**
 * 履歴操作フラグの入力を解析し、番号と一覧表示フラグを抽出する。
 *
 * @param raw CLI 引数から得た履歴指定。
 * @returns 履歴番号または一覧表示フラグ。
 */
export function parseHistoryFlag(raw: string | boolean | undefined): HistoryFlagParseResult {
  if (typeof raw === "undefined") {
    return { listOnly: false };
  }
  const parsed = historyFlagSchema.safeParse(raw);
  if (!parsed.success) {
    if (typeof raw === "string") {
      throw new Error("Error: 履歴番号は正の整数で指定してください");
    }
    const firstIssue = parsed.error.issues[0];
    throw new Error(firstIssue?.message ?? "Error: 履歴番号は正の整数で指定してください");
  }
  if (parsed.data === true) {
    return { listOnly: true };
  }
  return { index: parsed.data, listOnly: false };
}

/**
 * 旧形式の短縮フラグ固まりを Commander が解析できる形へ正規化する。
 *
 * @param argv 元の引数配列。
 * @returns 正規化済みの引数配列。
 */
export function expandLegacyShortFlags(argv: string[]): string[] {
  const result: string[] = [];
  let passThrough = false;

  const errorForUnknown = (flag: string): Error =>
    new Error(
      `Invalid option: -${flag} は無効です。-m0/1/2, -e0/1/2, -v0/1/2, -c, -r, -d/-d{num}, -s/-s{num}, -F を使用してください。`,
    );

  for (const arg of argv) {
    if (passThrough) {
      result.push(arg);
      continue;
    }
    if (arg === "--") {
      result.push(arg);
      passThrough = true;
      continue;
    }
    if (arg === "-F") {
      result.push(arg);
      continue;
    }
    if (arg === "-m") {
      throw new Error("Invalid option: -m には 0/1/2 を続けてください（例: -m1）");
    }
    if (arg === "-e") {
      throw new Error("Invalid option: -e には 0/1/2 を続けてください（例: -e2）");
    }
    if (arg === "-v") {
      throw new Error("Invalid option: -v には 0/1/2 を続けてください（例: -v0）");
    }
    if (
      !arg.startsWith("-") ||
      arg === "-" ||
      arg.startsWith("--") ||
      arg === "-?" ||
      arg === "-i"
    ) {
      result.push(arg);
      continue;
    }

    const cluster = arg.slice(1);
    if (cluster.length <= 1) {
      result.push(arg);
      continue;
    }

    let index = 0;
    let recognized = false;
    const append = (flag: string, value?: string) => {
      result.push(flag);
      if (typeof value === "string") {
        result.push(value);
      }
      recognized = true;
    };

    while (index < cluster.length) {
      const ch = cluster[index]!;
      switch (ch) {
        case "m":
        case "e":
        case "v": {
          const value = cluster[index + 1];
          if (!value) {
            throw new Error(`Invalid option: -${ch} には 0/1/2 を続けてください（例: -${ch}1）`);
          }
          append(`-${ch}`, value);
          index += 2;
          break;
        }
        case "c": {
          append(`-${ch}`);
          index += 1;
          break;
        }
        case "r":
        case "d":
        case "s": {
          index += 1;
          let digits = "";
          while (index < cluster.length && /\d/.test(cluster[index]!)) {
            digits += cluster[index]!;
            index += 1;
          }
          append(`-${ch}`, digits.length > 0 ? digits : undefined);
          break;
        }
        default:
          throw errorForUnknown(ch);
      }
    }

    if (!recognized) {
      result.push(arg);
    }
  }
  return result;
}

/**
 * モデル指定フラグの数値インデックスを実際のモデル名へ変換する。
 *
 * @param value ユーザー入力のインデックス。
 * @param defaults 既定モデル名。
 * @returns 対応するモデル名。
 */
export function parseModelFlag(
  value: string,
  defaults: Pick<CliDefaults, "modelNano" | "modelMini" | "modelMain">,
): string {
  switch (value) {
    case "0":
      return defaults.modelNano;
    case "1":
      return defaults.modelMini;
    case "2":
      return defaults.modelMain;
    default:
      throw new InvalidArgumentError("Invalid option: -m には 0/1/2 を続けてください（例: -m1）");
  }
}

/**
 * effort フラグの数値インデックスを EffortLevel に変換する。
 *
 * @param value ユーザー入力のインデックス。
 * @returns 対応する EffortLevel。
 */
export function parseEffortFlag(value: string): EffortLevel {
  switch (value) {
    case "0":
      return "low";
    case "1":
      return "medium";
    case "2":
      return "high";
    default:
      throw new InvalidArgumentError("Invalid option: -e には 0/1/2 を続けてください（例: -e2）");
  }
}

/**
 * verbosity フラグの数値インデックスを VerbosityLevel に変換する。
 *
 * @param value ユーザー入力のインデックス。
 * @returns 対応する VerbosityLevel。
 */
export function parseVerbosityFlag(value: string): VerbosityLevel {
  switch (value) {
    case "0":
      return "low";
    case "1":
      return "medium";
    case "2":
      return "high";
    default:
      throw new InvalidArgumentError("Invalid option: -v には 0/1/2 を続けてください（例: -v0）");
  }
}
