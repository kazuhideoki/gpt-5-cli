# gpt-5-cli — OpenAI Responses API CLI

OpenAI Responses API を叩くシンプルな Bash スクリプトです。会話の継続、履歴管理、モデル/推論強度/冗長度の切替をサポートします。

## セットアップ
1) `.env.example` を `.env` にコピー
```bash
cp .env.example .env
```
2) `.env` に API キーを設定
```env
OPENAI_API_KEY=your-actual-api-key-here
```
3) 任意の既定値（例）
```env
OPENAI_MODEL_MAIN=gpt-5
OPENAI_MODEL_MINI=gpt-5-mini
OPENAI_MODEL_NANO=gpt-5-nano
OPENAI_DEFAULT_EFFORT=low      # low|medium|high
OPENAI_DEFAULT_VERBOSITY=low   # low|medium|high
OPENAI_HISTORY_INDEX_FILE=~/openai/history_index.json
```

4) 任意: `system_prompt.txt` を作成すると、新規会話の先頭に固定の指示を自動付与できます（削除または空ファイルで無効化）。

## 使い方
```bash
./gpt-5-cli.sh [-m0|1|2][-e0|1|2][-v0|1|2][-c|-r|-r{N}|-d{N}|-s{N}] <入力テキスト>
./gpt-5-cli.sh --help  # または -?
```
- `-m0/-m1/-m2`: モデル選択（nano/mini/main）。未指定は `nano`。
- `-e0/-e1/-e2`: reasoning effort（low/medium/high）。未指定は `.env` の既定。
- `-v0/-v1/-v2`: 出力の冗長度（low/medium/high）。未指定は `.env` の既定。
- `-c`: 直近の会話から継続（最新の履歴を自動選択）。
- `-r`: 履歴一覧を表示して終了。
- `-r{N}`: N 番目（新しい順）の履歴で再開。テキスト省略時は対話的に入力。
- `-d{N}`: N 番目の履歴を削除。
- `-s{N}`: N 番目の会話ログを表示（`NO_COLOR=1` で色無し）。
 - フラグ連結: 1 つの `-` に続けてまとめて指定可（例: `-m1e2v2`）。分割指定も可（例: `-m1 -e2 -v2`）。
 - 番号付きフラグ: `-r{N}`/`-d{N}`/`-s{N}` は文字の直後に数字を続けます（例: `-r2`）。

実行例
```bash
./gpt-5-cli.sh 明日の予定を整理して
./gpt-5-cli.sh -m1e2v2 詳しく
./gpt-5-cli.sh -r              # 一覧のみ
./gpt-5-cli.sh -r2 続きをやろう  # 2 番目を使って継続
```

## 依存関係
- 必須: `curl`, `jq`, `awk`, `diff`
- 推奨: `shellcheck`, `shfmt`（`bash -n gpt-5-cli.sh` で構文確認）

## 履歴と設定の要点
- 既定の履歴ファイルはリポジトリ直下の `history_index.json`（`OPENAI_HISTORY_INDEX_FILE` で変更可。`~` 展開対応）。
- 履歴にはタイトル・最終 response.id・メタ情報・`turns`（user/assistant 各発話）を保存。共有前に機微情報の有無を確認してください。
- `system_prompt.txt` が存在する場合、新規会話の先頭に system メッセージとして付与されます。

## 内部動作のメモ
- OpenAI `/v1/responses` を `curl` で呼び出し、`jq` で JSON を生成/解析。
- 会話継続は `previous_response_id` を使用。Web 検索ツール `web_search_preview` を有効化しています。
