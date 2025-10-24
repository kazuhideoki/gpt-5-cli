# gpt-5-cli リファクタリング青写真（最小）

現在進行中リファクタリングについて。
この文書は **パイプライン層をトップ** とし、**入力 / 処理 / 結果処理**＋**ユーティリティ**のみで構成する最小の骨格を示す。
ユーザーの指示に応じてこの構成に近づけられるようにする

---

## 設計概要

### 1. パイプライン層（Top Pipeline）

- **役割**: ①入力 → ②処理 → ③結果処理 を直列実行する“筋”そのもの。
- **挙動**: `input()` の戻り値を `process()` に渡し、`process()` の結果を `handleResult()` に渡す。
- **副作用**: なし（ログのみ）。副作用は下位の責務に委譲。

### 2.1 入力（Input）

- **責務**: フラグ/標準入力/ファイル/履歴などを正規化して **InputDescriptor** を返す。
- **副作用**: なし（ログのみ）。

### 2.2 処理（Process / Engine）

- **責務**: モデル呼び出し・セッション管理・**tool 実行**を含む主処理。
- **副作用**: **あり**（API通信・tool による外部作用）。必要なログのみ出す。

### 2.3 結果処理（Result Handling / Finalize）

- **責務**: 処理結果の反映と終了時フック。例：ファイル保存、STDOUT/クリップボード、履歴追記、終了コード設定。
- **副作用**: **あり**（外部への反映）。ログのみ許可。

### 3. ユーティリティ層（Utilities / Foundation）

- **責務**: パス解決、時刻、ログ、など、業務知識に依存しない普遍機能。
- **副作用**: なし（設定読み取り・時刻参照は可）。上位層を参照しない。

---

## 契約(＊あくまでイメージ、詳細は今後検討)

```ts
// 共通文脈（上位から注入される依存）
export type Context = {
  io: {
    readFile(p: string): Promise<Uint8Array>;
    writeFile(p: string, data: Uint8Array | string): Promise<void>;
    stdout(s: string): void;
  };
  history: { add(entry: unknown): Promise<void> };
  tools: unknown; // tool レジストリ（中身はモード依存でOK）
  logger: {
    debug(msg: string, meta?: unknown): void;
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
  };
};

// 入力の正規化結果（複数可）
export type InputDescriptor =
  | { kind: "text";  payload: { text: string; source?: "argv" | "file" } }
  | { kind: "image"; payload: { paths: string[] } }
  // 状態再開/圧縮復元用の最小入力（任意利用）
  | { kind: "state"; payload: { type: "thread"; id: string } | { type: "compact"; blob: Uint8Array } };

// 処理の最小結果
export type ProcessResult = {
  data: unknown;
  meta?: { elapsedMs?: number; notes?: string; toolCalls?: number };
};

// 終了コード
export type ExitCode = 0 | 1;

// 引数束
export type Args = Readonly<{
  argv: string[];
  env: Record<string, string | undefined>;
}>;

// 各段の関数契約
export type InputFn = (args: Args, ctx: Context) => Promise<InputDescriptor[]>;

// openai クライアント等の動的初期化はこの中で行う想定（env から）
// tool 実行などの副作用は許容
export type ProcessFn = (inputs: InputDescriptor[], ctx: Context) => Promise<ProcessResult>;

// 出力・履歴追記・終了コード決定などの副作用はここで実施
export type HandleResultFn = (
  inputs: InputDescriptor[],
  result: ProcessResult,
  ctx: Context
) => Promise<ExitCode>;

// パイプライン署名
export type Pipeline = (
  fns: { input: InputFn; process: ProcessFn; handleResult: HandleResultFn },
  args: Args,
  ctx: Context
) => Promise<ExitCode>;
```

---

## 追加整理トラック案

### 処理層: tool リストフィルタの共通化（難易度: 低） ✅
- 現状: ask / d2 が `buildCliToolList` 生成後に `web_search_preview` を個別フィルタしている。
- 整理案: `pipeline/process/tools` 側で標準フィルタを提供し、CLI は登録リスト宣言だけで済むようにする。
- 効果: ツール一覧の後処理を集約し、今後のプレビューツール仕様変更に追従しやすくする。

### 結果処理層: サマリ出力パスと成果物ログの整理（難易度: 低）
- 現状: ファイル系 CLI が `summaryOutputPath` 判定と成果物存在ログをそれぞれ実装している。
- 整理案: finalize 層にサマリ出力先決定と成果物ログ出力を束ねたユーティリティを用意する。
- 効果: 標準出力の整合性を保ちつつ重複コードを排除し、成果物ログ仕様の変更を簡潔にする。

### 処理層: 履歴同期コールバックの標準化（難易度: 中）
- 現状: `computeContext` 呼び出しごとに `taskMode` セットや `outputPath`/`copyOutput` 継承を匿名関数で重複記述している。
- 整理案: `pipeline/process/conversation-context.ts` に共通同期ハンドラを公開し、CLI からは差分ロジックのみ渡すようにする。
- 効果: 履歴同期の仕様差分を抑え、フラグ追加時に各 CLI を横断修正しなくて済む。

### 結果処理層: ask 履歴コンテキストの共通化（難易度: 中）
- 現状: `buildAskHistoryContext` がファイル系と類似のロジックを独自に保持している。
- 整理案: `finalize/history-context.ts` に非ファイル成果物向けヘルパを追加し、ask も finalize 層の共通 API を利用する。
- 効果: 履歴保存の扱いを層単位で統一し、フラグ継承ルールを一本化できる。

### 入力層: 出力ファイルパス検証の共通化（難易度: 中〜高）
- 現状: d2 / mermaid / sql でワークスペース内チェックやディレクトリ検証を個別実装している (`ensureD2Context` など)。
- 整理案: `pipeline/input` もしくは `pipeline/finalize` にファイルパス正規化ユーティリティを追加し、CLI 側はモード固有メタデータのみ保持する。
- 効果: パス制約の挙動差異を防ぎ、検証ロジックの変更を一度で反映可能にする。

### 入力層: CLI オプションスキーマの重複解消（難易度: 高）
- 現状: `src/cli/ask.ts`, `src/cli/d2.ts`, `src/cli/mermaid.ts`, `src/cli/sql.ts` がほぼ同じ Zod バリデーションを個別に保持しており、`--compact` 併用禁止などのルールが分散している。
- 整理案: `pipeline/input` に共通スキーマビルダーを追加し、タスク固有フィールドだけを合成するファクトリ関数を導入する。
- 効果: バリデーション仕様の一元管理と CLI 追加時の複製削減。エラーメッセージも一箇所で揃い、将来のフラグ追加が容易になる。
