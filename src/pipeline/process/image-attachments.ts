// image-attachments.ts: CLI から渡された画像パスを検証し Responses API 向けデータ URL を生成する。
// NOTE(pipeline/process): 入力検証寄りだが、現状はモデル呼び出し準備の一環として process 層に配置。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CliLoggerConfig } from "../../foundation/logger/types.js";
import type { ConfigEnvironment } from "../../types.js";

function resolveHomeDirectory(configEnv: ConfigEnvironment): string {
  const configured = configEnv.get("HOME");
  if (typeof configured === "string" && configured.trim().length > 0) {
    return path.resolve(configured.trim());
  }
  const fallback = os.homedir();
  if (!fallback || fallback.trim().length === 0) {
    throw new Error("HOME environment variable must be set to use image attachments.");
  }
  return path.resolve(fallback);
}

function resolveImagePath(raw: string, configEnv: ConfigEnvironment): string {
  const home = resolveHomeDirectory(configEnv);
  if (path.isAbsolute(raw)) {
    if (!raw.startsWith(home)) {
      throw new Error(`Error: -i で指定できるフルパスは ${home || "$HOME"} 配下のみです: ${raw}`);
    }
    if (!fs.existsSync(raw) || !fs.statSync(raw).isFile()) {
      throw new Error(`Error: 画像ファイルが見つかりません: ${raw}`);
    }
    return raw;
  }
  if (raw.startsWith("スクリーンショット ") && raw.endsWith(".png")) {
    const resolved = path.join(home, "Desktop", raw);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`Error: 画像ファイルが見つかりません: ${resolved}`);
    }
    return resolved;
  }
  throw new Error(
    `Error: -i には ${home || "$HOME"} 配下のフルパスか 'スクリーンショット *.png' のみ指定できます: ${raw}`,
  );
}

function detectImageMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".heic":
    case ".heif":
      return "image/heic";
    default:
      throw new Error(`Error: 未対応の画像拡張子です: ${filePath}`);
  }
}

/**
 * CLI から指定された画像パスを検証し、Responses API 用の Data URL を生成する。
 *
 * @param imagePath `-i` フラグで渡された画像パス。未指定なら添付なしとして `undefined` を返す。
 * @param loggerConfig CLI 層から注入されるロガー設定。
 */
export function prepareImageData(
  imagePath: string | undefined,
  loggerConfig: CliLoggerConfig,
  configEnv: ConfigEnvironment,
): string | undefined {
  if (!imagePath) {
    return undefined;
  }
  const resolved = resolveImagePath(imagePath, configEnv);
  const mime = detectImageMime(resolved);
  const data = fs.readFileSync(resolved);
  const base64 = data.toString("base64");
  if (!base64) {
    throw new Error(`Error: 画像ファイルの base64 エンコードに失敗しました: ${resolved}`);
  }
  const dataUrl = `data:${mime};base64,${base64}`;
  const { logger } = loggerConfig;
  logger.info(`image_attached: ${resolved} (${mime})`);
  return dataUrl;
}
