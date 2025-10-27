// image-attachments.ts: CLI から渡された画像パスを検証し Responses API 向けデータ URL を生成する。
// NOTE(pipeline/process): 入力検証寄りだが、現状はモデル呼び出し準備の一環として process 層に配置。
import fs from "node:fs";
import path from "node:path";

function resolveImagePath(raw: string): string {
  const home = process.env.HOME;
  if (!home || home.trim().length === 0) {
    throw new Error("HOME environment variable must be set to use image attachments.");
  }
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
 * @param logLabel ログ識別に利用する CLI ラベル。
 */
export function prepareImageData(
  imagePath: string | undefined,
  logLabel: string,
): string | undefined {
  if (!imagePath) {
    return undefined;
  }
  const resolved = resolveImagePath(imagePath);
  const mime = detectImageMime(resolved);
  const data = fs.readFileSync(resolved);
  const base64 = data.toString("base64");
  if (!base64) {
    throw new Error(`Error: 画像ファイルの base64 エンコードに失敗しました: ${resolved}`);
  }
  const dataUrl = `data:${mime};base64,${base64}`;
  console.log(`${logLabel} image_attached: ${resolved} (${mime})`);
  return dataUrl;
}
