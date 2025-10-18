/**
 * @file CLI 応答の出力先（標準出力以外）を束ねるユーティリティ。
 * 結果テキストのファイル保存やクリップボードコピーを共通化する。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

interface DeliverOutputParams {
  /** 書き出す本文。 */
  content: string;
  /** CLI の実行ルート。既定は `process.cwd()` を利用する。 */
  cwd?: string;
  /** 保存対象の相対または絶対パス。未指定の場合はファイル保存を行わない。 */
  filePath?: string;
  /** クリップボードへコピーする場合に `true`。 */
  copy?: boolean;
}

interface DeliverOutputResult {
  file?: {
    absolutePath: string;
    bytesWritten: number;
  };
  copied?: boolean;
}

function ensureWorkspacePath(rawPath: string, cwd: string): string {
  if (!rawPath || rawPath.trim().length === 0) {
    throw new Error("Error: --output には空でないパスを指定してください");
  }
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, rawPath);
  const relative = path.relative(root, resolved);
  const isInside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!isInside) {
    throw new Error(`Error: 出力パスはワークスペース配下に指定してください: ${rawPath}`);
  }
  return resolved;
}

async function writeToFile(resolvedPath: string, content: string): Promise<number> {
  const stats = await fs.stat(resolvedPath).catch((error: NodeJS.ErrnoException) => {
    if (error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stats?.isDirectory()) {
    throw new Error(`Error: 出力先としてディレクトリは指定できません: ${resolvedPath}`);
  }
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, content, { encoding: "utf8" });
  return Buffer.byteLength(content, "utf8");
}

async function copyWithPbcopy(content: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("pbcopy");
    proc.on("error", (error) => {
      reject(new Error(`Error: pbcopy の起動に失敗しました: ${error.message}`));
    });
    proc.stdin.on("error", (error) => {
      reject(new Error(`Error: pbcopy への書き込みに失敗しました: ${error.message}`));
    });
    proc.on("close", (code) => {
      if ((code ?? 1) === 0) {
        resolve();
        return;
      }
      reject(new Error(`Error: pbcopy の実行が失敗しました (exit code ${code ?? -1})`));
    });
    proc.stdin.end(content, "utf8");
  });
}

/**
 * CLI 応答をファイル保存・クリップボードコピーへ分配する。
 *
 * @param params 出力条件。
 * @returns 保存・コピーの結果メタデータ。
 */
export async function deliverOutput(params: DeliverOutputParams): Promise<DeliverOutputResult> {
  const cwd = params.cwd ?? process.cwd();
  const result: DeliverOutputResult = {};

  if (params.filePath) {
    const resolved = ensureWorkspacePath(params.filePath, cwd);
    const bytesWritten = await writeToFile(resolved, params.content);
    result.file = {
      absolutePath: resolved,
      bytesWritten,
    };
  }

  if (params.copy) {
    await copyWithPbcopy(params.content);
    result.copied = true;
  }

  return result;
}
