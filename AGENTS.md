# Repository Guidelines

## プロジェクト構成
- `src/cli.ts`: 中核の TypeScript CLI。OpenAI Responses API を呼び出します。
- `dist/cli.js`: ビルド済みのエントリーポイント（`npm run build` で生成）。
- `.env` / `.env.example`: 認証や既定値の設定。最低限 `OPENAI_API_KEY` が必要。
- `system_prompt.txt`: 新規会話時に付与する初期 system メッセージ（任意）。
- `history_index.json`: 実行時に生成・更新される会話インデックス（既定: リポジトリ直下）。`OPENAI_HISTORY_INDEX_FILE` で上書き可能。
- `README.md`: 使い方・フラグ一覧。

## ビルド・実行・開発コマンド
- `npm install`: 依存関係の導入。
- `npm run build`: TypeScript をコンパイルして `dist/` を生成。
- `npm run dev`: `tsx` を使って `src/cli.ts` を直接実行。
- `npm run start -- --help`: ビルド済み CLI のヘルプ表示。
- 実行例: `npm run start -- -m1e2v2 "要約して"`（`.env` に API キー設定後）。

## コーディング規約・命名
- TypeScript は `strict` 設定。ES Modules (`type: module`) を利用。
- インデントは 2 スペース。
- 型は明示的に記載し、`any` は最小限に。
- ログは `console.error`（標準エラー）、ユーザー向け出力は `console.log` / `process.stdout.write`。

## テスト指針
- 公式テストは未整備。最低限の確認:
  - `npm run build` が成功すること。
  - `npm run start -- --help` がゼロ終了すること。
  - 履歴系の動作: `OPENAI_HISTORY_INDEX_FILE=/tmp/history.json NO_COLOR=1 npm run start -- -r` で安定出力を確認。
  - 実対話はキー設定後、最小入力で疎通確認。`jq . history_index.json` で生成物を検証。

## コミット／PR ガイドライン
- 現状の履歴に統一規約は未確立。以降は Conventional Commits を推奨。
  - 例: `feat(cli): add resume selector`、`fix(history): correct request count`、`docs: update usage examples`。
- PR には以下を含める:
  - 目的・背景、実装概要、影響範囲、手動確認手順、関連 Issue。
  - フラグや既定値変更時は `README.md` と CLI のヘルプ出力を必ず同期。
  - チェックリスト: `npm run build`、（任意）動作例のスクリーンショット。

## セキュリティ／設定の注意
- `.env` と API キーはコミット禁止。`.env.example` を更新して共有。
- 履歴には機微情報が含まれ得るため、共有前にパス変更や削除を検討。

## アーキテクチャ要旨（参考）
- OpenAI Node SDK の `responses.create` を使用。
- 会話継続は `previous_response_id`、履歴は `history_index.json` に追記保存。
