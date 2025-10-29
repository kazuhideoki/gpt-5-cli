/**
 * @file CLI 応答の出力先（標準出力以外）を束ねるユーティリティ。
 * 結果テキストのファイル保存やクリップボードコピーを共通化する。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import { expandHome } from "../../foundation/paths.js";
import type { ConfigEnvironment } from "../../types.js";

export type CopySource =
  | {
      type: "content";
      value: string;
    }
  | {
      type: "file";
      filePath: string;
    };

export interface DefaultOutputPathParams {
  /** CLI モード名（例: "d2"、"mermaid"、"sql"）。 */
  mode: string;
  /** 生成するファイル名の拡張子。ドットを含めない。 */
  extension: string;
  /**
   * 生成の基準となるカレントディレクトリ。
   * `undefined` を渡した場合は `process.cwd()` を利用する。
   */
  cwd: string | undefined;
  /**
   * `.env` 群を取り込んだ環境スナップショット。
   * finalize 層では ConfigEnv が渡される想定。
   */
  configEnv: ConfigEnvironment;
}

export interface DefaultOutputPathResult {
  /** ワークスペース基準の相対パス。 */
  relativePath: string;
  /** 絶対パス。 */
  absolutePath: string;
}

export const DEFAULT_OUTPUT_DIR_ENV = "GPT_5_CLI_OUTPUT_DIR";

export interface DeliverOutputParams {
  /** 書き出す本文。 */
  content: string;
  /**
   * CLI の実行ルート。
   * `undefined` を渡した場合は `process.cwd()` を利用する。
   */
  cwd: string | undefined;
  /**
   * 保存対象の相対または絶対パス。
   * `undefined` の場合はファイル保存を行わない。
   */
  filePath: string | undefined;
  /**
   * クリップボードへコピーする場合に `true`。
   * `undefined` はコピー要求なしと解釈する。
   */
  copy: boolean | undefined;
  /**
   * コピー対象を本文以外へ変更する場合の情報。
   * `undefined` の場合は本文をコピーする。
   */
  copySource: CopySource | undefined;
  /**
   * finalize 層で参照する環境スナップショット。
   * ConfigEnv から供給される値を使用する。
   */
  configEnv: ConfigEnvironment;
}

/**
 * deliverOutput の保存・コピー処理結果。
 */
export interface DeliverOutputResult {
  /** ファイルへ書き出した場合の結果メタデータ。 */
  file:
    | {
        /** 書き込み先の絶対パス。 */
        absolutePath: string;
        /** 書き込んだバイト数。 */
        bytesWritten: number;
      }
    | undefined;
  /** クリップボードコピーを実行した場合は true。 */
  copied: boolean | undefined;
}

function resolveHomeDirectory(configEnv: ConfigEnvironment): string {
  const fromConfig = configEnv.get("HOME" as any);
  if (typeof fromConfig === "string" && fromConfig.trim().length > 0) {
    return path.resolve(fromConfig.trim());
  }
  const fallback = os.homedir();
  if (!fallback || fallback.trim().length === 0) {
    throw new Error("HOME environment variable is required when using '~' paths.");
  }
  return path.resolve(fallback);
}

function expandHomeWithConfig(rawPath: string, configEnv: ConfigEnvironment): string {
  if (!rawPath.startsWith("~")) {
    return rawPath;
  }
  const home = resolveHomeDirectory(configEnv);
  const remainder = rawPath.slice(1);
  return path.join(home, remainder);
}

function ensureWorkspacePath(rawPath: string, cwd: string, configEnv: ConfigEnvironment): string {
  if (!rawPath || rawPath.trim().length === 0) {
    throw new Error("Error: --output には空でないパスを指定してください");
  }
  const root = path.resolve(cwd);
  const trimmed = rawPath.trim();
  const expanded = trimmed.startsWith("~")
    ? expandHomeWithConfig(trimmed, configEnv)
    : expandHome(trimmed, configEnv);
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(root, expanded);
  const relative = path.relative(root, resolved);
  const isInside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!isInside) {
    throw new Error(`Error: 出力パスはワークスペース配下に指定してください: ${rawPath}`);
  }
  return resolved;
}

function formatTimestamp(date: Date): string {
  const yyyy = date.getFullYear().toString().padStart(4, "0");
  const mm = (date.getMonth() + 1).toString().padStart(2, "0");
  const dd = date.getDate().toString().padStart(2, "0");
  const hh = date.getHours().toString().padStart(2, "0");
  const mi = date.getMinutes().toString().padStart(2, "0");
  const ss = date.getSeconds().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function resolveBaseDirectory(mode: string, cwd: string, configEnv: ConfigEnvironment): string {
  const configValue = configEnv.get(DEFAULT_OUTPUT_DIR_ENV);
  const envDirRaw =
    typeof configValue === "string" && configValue.trim().length > 0
      ? configValue.trim()
      : undefined;
  const normalizedRoot = path.resolve(cwd);
  if (envDirRaw && envDirRaw.length > 0) {
    const expanded = envDirRaw.startsWith("~")
      ? expandHomeWithConfig(envDirRaw, configEnv)
      : expandHome(envDirRaw, configEnv);
    const candidate = path.resolve(normalizedRoot, expanded);
    const relative = path.relative(normalizedRoot, candidate);
    const isInsideWorkspace =
      relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    if (!isInsideWorkspace) {
      throw new Error(
        `Error: ${DEFAULT_OUTPUT_DIR_ENV} はワークスペース配下のディレクトリを指定してください: ${envDirRaw}`,
      );
    }
    return candidate;
  }
  return path.join(normalizedRoot, "output", mode);
}

/**
 * CLI モードに応じた一意の出力ファイルパスを生成する。
 */
export function generateDefaultOutputPath(
  params: DefaultOutputPathParams,
): DefaultOutputPathResult {
  const cwd = params.cwd ? path.resolve(params.cwd) : process.cwd();
  const baseDir = resolveBaseDirectory(params.mode, cwd, params.configEnv);
  const timestamp = formatTimestamp(new Date());
  const randomSuffix = crypto.randomBytes(2).toString("hex");
  const fileName = `${params.mode}-${timestamp}-${randomSuffix}.${params.extension}`;
  const absolutePath = path.join(baseDir, fileName);
  const relativePath = path.relative(cwd, absolutePath) || path.basename(absolutePath);
  return { relativePath, absolutePath };
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
 */
export async function deliverOutput(params: DeliverOutputParams): Promise<DeliverOutputResult> {
  const cwd = params.cwd ?? process.cwd();
  const result: DeliverOutputResult = {
    file: undefined,
    copied: undefined,
  };

  if (params.filePath) {
    const resolved = ensureWorkspacePath(params.filePath, cwd, params.configEnv);
    const bytesWritten = await writeToFile(resolved, params.content);
    result.file = {
      absolutePath: resolved,
      bytesWritten,
    };
  }

  if (params.copy) {
    const copySource = params.copySource ?? {
      type: "content" as const,
      value: params.content,
    };
    let copyContent: string;
    if (copySource.type === "content") {
      copyContent = copySource.value;
    } else {
      const resolvedCopyPath = ensureWorkspacePath(copySource.filePath, cwd, params.configEnv);
      try {
        copyContent = await fs.readFile(resolvedCopyPath, { encoding: "utf8" });
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError?.code === "ENOENT") {
          throw new Error(`Error: --copy の対象ファイルが存在しません: ${copySource.filePath}`);
        }
        throw error;
      }
    }
    await copyWithPbcopy(copyContent);
    result.copied = true;
  }

  return result;
}
