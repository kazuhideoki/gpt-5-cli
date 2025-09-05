# OpenAI API Wrapper

OpenAI Responses API を叩くための Bash スクリプト。

## 使い方

```bash
./gpt-5-cli.sh [-<クラスタ>] <入力テキスト>

# 例
./gpt-5-cli.sh 明日の予定を整理して   # model=gpt-5-nano, effort=low, verbosity=low（デフォルト）
./gpt-5-cli.sh -m1e2v2 詳しく       # model=gpt-5-mini(m1), effort=high(e2), verbosity=high(v2)
./gpt-5-cli.sh -m0e0v0 箇条書きで   # model=gpt-5-nano(m0), effort=low(e0), verbosity=low(v0)
```

- モデル指定（連結可）
  - `-m0`=nano, `-m1`=mini, `-m2`=main（=gpt-5）
- Reasoning effort（連結可／既定: low）
  - `-e0`=low, `-e1`=medium, `-e2`=high
  - フラグ未指定時は `effort=${OPENAI_DEFAULT_EFFORT:-low}`（`.env` の `OPENAI_DEFAULT_EFFORT` で上書き可）
- Verbosity（連結可／既定: low）
  - `-v0`=low, `-v1`=medium, `-v2`=high
  - フラグ未指定時は `verbosity=${OPENAI_DEFAULT_VERBOSITY:-low}`（`.env` の `OPENAI_DEFAULT_VERBOSITY` で上書き可）
- 継続/履歴
  - `c`: continue（直前の会話から継続）
  - `r`: 履歴一覧を表示して終了（表示のみ）
  - `r{num}`: 対応する履歴で対話を再開（例: `-r2`）
  - `d{num}`: 対応する履歴を削除（例: `-d2`）
  - `s{num}`: 対応する履歴の対話内容を表示（例: `-s2`）。各発話の前に `user:` / `assistant:` を付けて表示します。
- `-?` or `--help` でヘルプ表示

## セットアップ

1. `.env.example` を `.env` にコピー
   ```bash
   cp .env.example .env
   ```
2. `.env` に OpenAI API キーを設定
   ```env
   OPENAI_API_KEY=your-actual-api-key-here
   ```
3. 必要ならモデルを上書き（任意）
  ```env
  OPENAI_MODEL_MAIN=gpt-5
  OPENAI_MODEL_MINI=gpt-5-mini
  OPENAI_MODEL_NANO=gpt-5-nano
  ```
  - 既定の選択: フラグ未指定時は `OPENAI_MODEL_NANO` が使われます
  - effort の既定値を変えたい場合
  ```env
  # 既定: low
 OPENAI_DEFAULT_EFFORT=medium  # high|medium|low|minimal
  ```
4. 履歴ファイルの設定（任意）
   ```env
   # 履歴インデックス（複数会話のタイトル/最終IDを保持。-r で使用）
   # 既定: scripts/gpt-5-cli/history_index.json
   OPENAI_HISTORY_INDEX_FILE=/path/to/history_index.json
   ```
5. ローカル履歴インデックスについて
   - `history_index.json` は「会話のメタ情報（タイトル・最終レスポンスID・モデル・effort・verbosity・更新時刻）」に加えて、`turns` 配列として user/assistant の各発話を保存します（2025-09 以降）。
   - 古いエントリには `turns` が無い場合があります。その場合、`-s{num}` は「保存された対話メッセージがありません」と表示します。
   - `-r` は一覧表示のみを行います。特定の履歴で再開したい場合は `-r{num}`、削除は `-d{num}`、表示は `-s{num}` を使用します。

## 必要な依存関係

- `curl`
- `jq`

## 継続の扱い

- `-c` 付き実行では、`history_index.json` 内で「直近に更新された会話（updated_at 最大）」の `last_response_id` を `previous_response_id` として渡し、サーバー側の会話状態を継続します。クライアント側では今回の user 入力のみを送信します。
- `-r{num}` を指定すると、一覧の `{num}` 番目（新しい順）の `last_response_id` を用いて継続します。引数のテキストが無い場合は起動時にプロンプトを求めます。
- `-r` は履歴の一覧表示のみを行います。
- `-d{num}` を指定すると、一覧の `{num}` 番目（新しい順）の履歴を `history_index.json` から削除します。
- 上記いずれにも該当しない場合は新規会話として開始します（`previous_response_id` は付与しません）。

## 動作

OpenAI の `/v1/responses` を利用し、`web_search_preview` ツールを有効化して問い合わせます。
サーバー側継続は `previous_response_id` を用いて実現しています（詳細は公式Cookbookを参照）。
