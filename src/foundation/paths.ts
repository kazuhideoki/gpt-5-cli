/**
 * プロジェクト共通で利用するパス周りのユーティリティ。
 * CLI やパイプライン各層から参照される基盤機能をまとめる。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** リポジトリのルートディレクトリ絶対パス。 */
export const ROOT_DIR = path.resolve(moduleDir, "../..");

/**
 * `~` から始まるパスを HOME 環境変数を基に展開する。
 *
 * @param target 変換対象のパス。
 * @returns 展開後のパス。
 */
export function expandHome(target: string): string {
  if (!target.startsWith("~")) {
    return target;
  }
  const home = process.env.HOME;
  if (!home || home.trim().length === 0) {
    throw new Error("HOME environment variable is required when using '~' paths.");
  }
  return path.join(home, target.slice(1));
}
