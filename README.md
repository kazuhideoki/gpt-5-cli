# gpt-5-cli — OpenAI Responses API CLI

OpenAI Responses API を利用する TypeScript 製の CLI です。会話の継続、履歴管理、モデル/推論強度/冗長度の切替、画像入力、会話ログの要約 (`--compact`) をサポートします。

本リポジトリは **ask**・**d2**・**mermaid**・**sql** の 4 系統の CLI を提供します。`gpt-5-cli` コマンドが ask CLI、`gpt-5-cli-d2` が d2 CLI、`gpt-5-cli-mermaid` が Mermaid CLI、`gpt-5-cli-sql` が SQL CLI です。どの CLI も共通ロジックを共有しつつ、モードごとのフラグ・振る舞いを最適化しています。

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
   - 開発中は ask CLI を `bun run dev`、d2 CLI を `bun run dev:d2`、Mermaid CLI を `bun run dev:mermaid` で TypeScript ソースから直接実行できます。
5. 任意の既定値（例）
   ```env
   OPENAI_MODEL_MAIN=gpt-5
   OPENAI_MODEL_MINI=gpt-5-mini
   OPENAI_MODEL_NANO=gpt-5-nano
   OPENAI_DEFAULT_EFFORT=low      # low|medium|high
   OPENAI_DEFAULT_VERBOSITY=low   # low|medium|high
   GPT_5_CLI_HISTORY_INDEX_FILE=~/gpt-5-cli/history_index.json
   ```
   - `OPENAI_DEFAULT_EFFORT` と `OPENAI_DEFAULT_VERBOSITY` に無効な値を設定すると起動時にエラーになります。
   - `GPT_5_CLI_HISTORY_INDEX_FILE` を設定する場合は空文字不可・`~` を含む場合は `HOME` が必須です。
   - System プロンプトのテンプレート配置先を変えたい場合は `GPT_5_CLI_PROMPTS_DIR` を設定します（空文字不可・`~` 展開対応）。
   - 画像添付（`-i`）機能を使う際も `HOME` が未設定だとエラーになります。
   - CLI ごとに別の設定を使いたい場合は `.env.ask` / `.env.d2` / `.env.mermaid` / `.env.sql` を `.env` と同じディレクトリに配置してください。`loadEnvironment` はまず `.env` を基準値として読み込み、その後に CLI 名に対応するファイルで上書きします（例: ask CLI は `.env.ask`、Mermaid CLI は `.env.mermaid`、SQL CLI は `.env.sql` を追加で読み込みます）。各 CLI 専用 `.env.*` には必ず `GPT_5_CLI_HISTORY_INDEX_FILE` を設定してください。
6. 任意: `prompts/ask.md` や `prompts/d2.md`、`prompts/mermaid.md` に内容を記載すると、新規会話の先頭に固定の指示を自動付与できます。対応するモードでのみ適用されます（存在しない／空ファイルは無視）。

## CLI の使い方

### ask CLI

ビルド後は下記のいずれかで ask CLI を起動します。

```bash
gpt-5-cli -- --help     # グローバルインストール済みの場合
bun run start -- --help  # リポジトリ直下で Bun から実行
```

主なフラグは以下の通りです。

- `-m0/-m1/-m2`: モデル選択（nano/mini/main）。未指定は `nano`。
- `-e0/-e1/-e2`: reasoning effort（low/medium/high）。未指定は `.env` の既定。
- `-v0/-v1/-v2`: 出力の冗長度（low/medium/high）。未指定は `.env` の既定。
- `-c`: 直近の会話から継続（最新の履歴を自動選択）。
- `-i <画像>`: 入力に画像を添付。`$HOME` 配下のフルパス、または「スクリーンショット *.png」というファイル名のみ対応（`~/Desktop` に解決）。
- `-r`: 履歴一覧を表示して終了。
- `-r{N}`: N 番目（新しい順）の履歴で再開。テキスト省略時は対話的に入力。
- `-d{N}`: N 番目の履歴を削除。
- `-s{N}`: N 番目の会話ログを表示（`NO_COLOR=1` で色無し）。
- `-o, --output <path>`: 結果を指定ファイルに保存。ワークスペース配下の相対パスまたはフルパスのみ扱う。
- `--copy`: 応答テキストをクリップボードへコピー（macOS の `pbcopy` を利用）。
- フラグ連結: 1 つの `-` に続けてまとめて指定可（例: `-m1e2v2`）。分割指定も可（例: `-m1 -e2 -v2`）。`-i` は次の引数でパスを受け取るので連結不可。
- 番号付きフラグ: `-r{N}`/`-d{N}`/`-s{N}` は文字の直後に数字を続けます（例: `-r2`）。

#### ask CLI の実行例

```bash
gpt-5-cli -- 明日の予定を整理して
gpt-5-cli -- -m1e2v2 詳しく
gpt-5-cli -- -r              # 一覧のみ
gpt-5-cli -- -r2 続きをやろう  # 2 番目を使って継続
gpt-5-cli -- --compact 1     # 1 番目の履歴を要約
```

### d2 CLI

d2 用の CLI は下記で起動できます。

```bash
gpt-5-cli-d2 -- --help
bun run start:d2 -- --help
```

d2 モード固有のレンダリングやフラグ構成を持ちます。履歴ストアは ask CLI と共有されるため、`task.mode` によりどちらの CLI で作成した履歴か判別できます。

主な追加フラグ:

- `-o, --output <path>`: 生成した D2 コードを保存するファイルパス。未指定時は `GPT_5_CLI_OUTPUT_DIR` で示した場所（未設定なら `output/d2/`）にタイムスタンプ付きファイルを自動生成します。
- `--copy`: 生成した D2 コードの内容をクリップボードへコピー（macOS の `pbcopy` が必要）。

### Mermaid CLI

Mermaid 用の CLI は下記で起動できます。

```bash
gpt-5-cli-mermaid -- --help
bun run start:mermaid -- --help
```

Mermaid CLI では `mermaid_check` ツールを通じて `@mermaid-js/mermaid-cli` の `mmdc` を実行し、Mermaid 記法の検証を行います。履歴ストアは共通で、タスクメタデータには対象ファイルパスが保存されます。Mermaid 専用の設定を分離したい場合は `.env.mermaid` に `GPT_5_CLI_HISTORY_INDEX_FILE` や既定モデルを指定してください。

- `.mmd` など純粋な Mermaid ソースファイルを指定するのが最も確実です。Markdown で管理する場合は、Mermaid コードを必ず ```mermaid``` または `:::mermaid` ブロック内に記述してください（`mmdc` がチャートを抽出できません）。

主な追加フラグ:

- `-o, --output <path>`: 生成・修正した Mermaid ソースを保存するファイルパス。未指定時は `GPT_5_CLI_OUTPUT_DIR` または `output/mermaid/` 配下にタイムスタンプ付きファイルを自動生成します。
- `--copy`: 生成した Mermaid ソースの内容をクリップボードへコピー（macOS の `pbcopy` が必要）。

### SQL CLI

SQL 向け CLI は下記で起動します。

```bash
gpt-5-cli-sql -- --help
bun run start:sql -- --help
```

SQL CLI では接続情報の管理や `--iterations` フラグなどが追加され、会話履歴には SQL 用タスクメタデータが保存されます。CLI ごとの履歴分離を行う場合は `.env.sql` に `GPT_5_CLI_HISTORY_INDEX_FILE` を設定し、必要に応じて `OPENAI_DEFAULT_EFFORT` なども上書きしてください。

主な追加フラグ:

- `-o, --output <path>`: 応答した SQL を保存するファイルパス。未指定時は `GPT_5_CLI_OUTPUT_DIR` または `output/sql/` 配下にタイムスタンプ付きファイルを自動生成します。
- `--copy`: 生成した SQL ファイルの内容をクリップボードへコピー（macOS の `pbcopy` が必要）。

## 依存関係

- Bun 1.2 以降
- TypeScript コンパイラ（`bun install` で導入）

## 履歴と設定の要点

- 既定の履歴ファイルはリポジトリ直下の `history_index.json`（`GPT_5_CLI_HISTORY_INDEX_FILE` で変更可。`~` 展開対応）。
- CLI ごとに履歴ファイルを分離する場合は `.env.ask`・`.env.d2`・`.env.mermaid`・`.env.sql` を用意し、各ファイルで `GPT_5_CLI_HISTORY_INDEX_FILE` を固有のパスに設定してください。`.env` に共通設定を記載しつつ、CLI 固有の値（モデルや effort、SQL であれば DSN など）を `.env.*` で上書きできます。同一プロセス内で複数 CLI を混在させない運用を前提にしています。
- 履歴にはタイトル・最終 response.id・メタ情報・`turns`（user/assistant 各発話）を保存。共有前に機微情報の有無を確認してください。
- `prompts/<mode>.md` が存在すると、そのモードで新規会話開始時に system メッセージとして付与されます。ファイルが無い場合は system メッセージ無しで実行されます。

## 内部動作のメモ

- OpenAI Node SDK の `responses.create` を使用して `/v1/responses` を呼び出します。
- 会話継続は `previous_response_id` を使用。Web 検索ツール `web_search_preview` を自動付与しています。
- 履歴管理は `history_index.json` を JSON 配列として読み書きします。

## 開発コマンド

- `bun run build`: TypeScript をコンパイルして `dist/cli/ask.js`・`dist/cli/d2.js`・`dist/cli/mermaid.js`・`dist/cli/sql.js` を生成
- `bun run dev`: Bun の TypeScript 実行機能で ask CLI を実行
- `bun run dev:d2`: Bun の TypeScript 実行機能で d2 CLI を実行
- `bun run dev:mermaid`: Bun の TypeScript 実行機能で Mermaid CLI を実行
- `bun run test`: Bun のテストランナーでユニットテスト・統合テストを実行
- `bun run lint`: Biome による静的解析
- `bun run format:check`: Biome によるフォーマット検査
- `bun run knip:exports`: Knip による未使用 export チェック
- `bun run knip:fix-exports`: Knip で未使用 export を自動削除

## 未使用 export の整理（Knip）

Knip を使ってプロジェクト全体の未使用 export を検出・削除できます。

1. まず `bun run knip:exports` で未使用 export を洗い出す。
2. 問題なければ `bun run knip:fix-exports` を実行し、自動削除を適用する。

CI でも同じチェックを行うため、未使用 export が残っていると Pull Request が失敗します。

## レイヤー境界のLint

- 依存方向は `core <- pipeline/{input,process} <- cli` を基本とし、`biome.json` の `noRestrictedImports` で `core` から上位層 (`pipeline/*` や `cli`) への参照を禁止しています。
- 同じ設定で `pipeline/input`・`pipeline/process` から `cli` への参照も禁止済みです。詳細な運用ルールは `AGENTS.md` の行動規範（R4）を参照してください。
