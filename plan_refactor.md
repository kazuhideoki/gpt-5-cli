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
