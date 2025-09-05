# Repository Guidelines

## プロジェクト構成
- `gpt-5-cli.sh`: 中核の Bash CLI。OpenAI Responses API を呼び出します。
- `.env` / `.env.example`: 認証や既定値の設定。最低限 `OPENAI_API_KEY` が必要。
- `system_prompt.txt`: 新規会話時に付与する初期 system メッセージ（任意）。
- `history_index.json`: 実行時に生成・更新される会話インデックス（既定: リポジトリ直下）。`OPENAI_HISTORY_INDEX_FILE` で上書き可。
- `README.md`: 使い方・フラグ一覧。

## ビルド・実行・開発コマンド
- `bash -n gpt-5-cli.sh`: 構文チェック。
- `shellcheck gpt-5-cli.sh`: Lint（推奨）。
- `shfmt -w -i 4 gpt-5-cli.sh`: フォーマット（推奨）。
- `./gpt-5-cli.sh --help` または `-?`: ヘルプ表示。
- 実行例: `./gpt-5-cli.sh -m1e2v2 "要約して"`（`.env` に API キー設定後）。

## コーディング規約・命名
- シェルは Bash。`set -euo pipefail` を維持。
- インデントは 4 スペース。条件は `[[ ... ]]`、変数展開は二重引用で保護。
- 命名: 定数は `UPPER_SNAKE_CASE`、関数は `lower_snake_case`、関数内は `local` を使用。
- JSON は `jq` で生成・解析。ユーザー向け出力は標準出力、ログは標準エラーへ。

## テスト指針
- 公式テストは未整備。最低限の確認:
  - `bash -n` と `shellcheck` を通す。
  - `./gpt-5-cli.sh --help` がゼロ終了すること。
  - 履歴系の動作: `OPENAI_HISTORY_INDEX_FILE=/tmp/history.json NO_COLOR=1 ./gpt-5-cli.sh -r` で安定出力を確認。
  - 実対話はキー設定後、最小入力で疎通確認。`jq . history_index.json` で生成物を検証。

## コミット／PR ガイドライン
- 現状の履歴に統一規約は未確立。以降は Conventional Commits を推奨。
  - 例: `feat(cli): resume(-r{num}) を追加`、`fix(history): index 更新を修正`、`docs: README の既定パスを同期`。
- PR には以下を含める:
  - 目的・背景、実装概要、影響範囲、手動確認手順、関連 Issue。
  - フラグや既定値変更時は `README.md` と `show_help()` のメッセージを必ず同期。
  - チェックリスト: `bash -n`、`shellcheck`、（任意）動作例のスクリーンショット。

## セキュリティ／設定の注意
- `.env` と API キーはコミット禁止。`.env.example` を更新して共有。
- 履歴には機微情報が含まれ得るため、共有前にパス変更や削除を検討。

## アーキテクチャ要旨（参考）
- `curl` で `/v1/responses` を呼び出し、`jq` で I/O を整形。
- 会話継続は `previous_response_id`、履歴は `history_index.json` に追記保存。

