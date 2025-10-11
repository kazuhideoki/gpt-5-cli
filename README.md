# gpt-5-cli — OpenAI Responses API CLI

OpenAI Responses API を利用する TypeScript 製の CLI です。会話の継続、履歴管理、モデル/推論強度/冗長度の切替、画像入力、会話ログの要約 (`--compact`) をサポートします。

## セットアップ

1. `.env.example` を `.env` にコピー
   ```bash
   cp .env.example .env
   ```
2. `.env` に API キーを設定
   ```env
   OPENAI_API_KEY=your-actual-api-key-here
   ```
3. 依存関係をインストール
   ```bash
   bun install
   ```
4. TypeScript をコンパイル
   ```bash
   bun run build
   ```
   （開発中は `bun run dev` で TypeScript ソースをそのまま実行できます）
5. 任意の既定値（例）
   ```env
   OPENAI_MODEL_MAIN=gpt-5
   OPENAI_MODEL_MINI=gpt-5-mini
   OPENAI_MODEL_NANO=gpt-5-nano
   OPENAI_DEFAULT_EFFORT=low      # low|medium|high
   OPENAI_DEFAULT_VERBOSITY=low   # low|medium|high
   OPENAI_HISTORY_INDEX_FILE=~/gpt-5-cli/history_index.json
   ```
   - `OPENAI_DEFAULT_EFFORT` と `OPENAI_DEFAULT_VERBOSITY` に無効な値を設定すると起動時にエラーになります。
   - `OPENAI_HISTORY_INDEX_FILE` を設定する場合は空文字不可・`~` を含む場合は `HOME` が必須です。
   - 画像添付（`-i`）機能を使う際も `HOME` が未設定だとエラーになります。
6. 任意: `prompts/default.md` に内容を記載すると、新規会話の先頭に固定の指示を自動付与できます。`prompts/d2.md` などモード名と同じファイルを置くと `--d2-mode` 時のみ適用されます（存在しない／空ファイルは無視）。

## 使い方

```bash
bun start -- [-m0|1|2][-e0|1|2][-v0|1|2][-c|-r|-r{N}|-d{N}|-s{N}] [-i <画像>] <入力テキスト>
bun start -- --help  # または -?
```

- `-m0/-m1/-m2`: モデル選択（nano/mini/main）。未指定は `nano`。
- `-e0/-e1/-e2`: reasoning effort（low/medium/high）。未指定は `.env` の既定。
- `-v0/-v1/-v2`: 出力の冗長度（low/medium/high）。未指定は `.env` の既定。
- `-c`: 直近の会話から継続（最新の履歴を自動選択）。
- `-i <画像>`: 入力に画像を添付。`$HOME` 配下のフルパス、または「スクリーンショット \*.png」というファイル名のみ対応（`~/Desktop` に解決）。
- `-r`: 履歴一覧を表示して終了。
- `-r{N}`: N 番目（新しい順）の履歴で再開。テキスト省略時は対話的に入力。
- `-d{N}`: N 番目の履歴を削除。
- `-s{N}`: N 番目の会話ログを表示（`NO_COLOR=1` で色無し）。
- フラグ連結: 1 つの `-` に続けてまとめて指定可（例: `-m1e2v2`）。分割指定も可（例: `-m1 -e2 -v2`）。`-i` は次の引数でパスを受け取るので連結不可。
- 番号付きフラグ: `-r{N}`/`-d{N}`/`-s{N}` は文字の直後に数字を続けます（例: `-r2`）。

### 実行例

```bash
bun start -- 明日の予定を整理して
bun start -- -m1e2v2 詳しく
bun start -- -r              # 一覧のみ
bun start -- -r2 続きをやろう  # 2 番目を使って継続
bun start -- --compact 1     # 1 番目の履歴を要約
```

## 依存関係

- Bun 1.2 以降
- TypeScript コンパイラ（`bun install` で導入）

## 履歴と設定の要点

- 既定の履歴ファイルはリポジトリ直下の `history_index.json`（`OPENAI_HISTORY_INDEX_FILE` で変更可。`~` 展開対応）。
- 履歴にはタイトル・最終 response.id・メタ情報・`turns`（user/assistant 各発話）を保存。共有前に機微情報の有無を確認してください。
- `prompts/<mode>.md` が存在すると、そのモードで新規会話開始時に system メッセージとして付与されます（例: `default.md`, `d2.md`）。ファイルが無い場合は system メッセージ無しで実行されます。

## 内部動作のメモ

- OpenAI Node SDK の `responses.create` を使用して `/v1/responses` を呼び出します。
- 会話継続は `previous_response_id` を使用。Web 検索ツール `web_search_preview` を自動付与しています。
- 履歴管理は `history_index.json` を JSON 配列として読み書きします。

## 開発コマンド

- `bun run build`: TypeScript をコンパイルして `dist/` を生成
- `bun run dev`: Bun の TypeScript 実行機能で `src/cli.ts` を直接実行
