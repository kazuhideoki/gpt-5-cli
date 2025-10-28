/**
 * プロジェクト共通で利用するパス周りのユーティリティ。
 * CLI やパイプライン各層から参照される基盤機能をまとめる。
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigEnvironment } from "../types.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** リポジトリのルートディレクトリ絶対パス。 */
export const ROOT_DIR = path.resolve(moduleDir, "../..");

/**
 * `~` から始まるパスを HOME 環境変数を基に展開する。
 *
 * @param target 変換対象のパス。
 * @param configEnv ConfigEnv から供給される環境値。
 * @returns 展開後のパス。
 */
export function expandHome(target: string, configEnv: ConfigEnvironment): string {
  if (!target.startsWith("~")) {
    return target;
  }
  const homeFromConfig = configEnv.get("HOME");
  const normalizedHome =
    typeof homeFromConfig === "string" && homeFromConfig.trim().length > 0
      ? homeFromConfig.trim()
      : os.homedir();
  const homeDirectory = normalizedHome?.trim();
  if (!homeDirectory || homeDirectory.trim().length === 0) {
    throw new Error("HOME environment variable is required when using '~' paths.");
  }
  return path.join(path.resolve(homeDirectory), target.slice(1));
}
