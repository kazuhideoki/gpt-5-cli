---
title: 共通フラグ／ヘルプ共通化 設計メモ
updated: 2025-10-16
---

## 目的
- ask / d2 / mermaid / sql 各 CLI のフラグ定義とヘルプ文言の重複を排除し、保守性を高める。
- 共通フラグ仕様を core 層で集約し、CLI 個別フラグは差分のみを注入できる構造を整える。
- ヘルプ出力の生成ロジックを共通化し、表記揺れと抜け漏れを防ぐ。

## 成果物サマリ
- `src/core/options/commonFlags.ts`: 共通フラグ定義と取得関数
- `src/core/options/composeFlags.ts`: 共通／個別フラグをマージするユーティリティ
- `src/core/formatting/helpBuilder.ts`: フラグ配列を受け取りヘルプテキストを構築する関数
- CLI 各モードの `options.ts` 改修（共通定義を利用するよう移行）
- 単体テスト: `src/core/options/commonFlags.test.ts`, `src/core/formatting/helpBuilder.test.ts`

## ディレクトリ／モジュール構成
```
src/
  core/
    options/
      commonFlags.ts        # 共通フラグ定義・取得
      composeFlags.ts       # 共通＋個別フラグマージ用ユーティリティ
      types.ts              # 既存。FlagDefinition などの型定義を拡張する場合はここで対応
    formatting/
      helpBuilder.ts        # フラグ情報から CLI ヘルプ文言を構築
  cli/
    default/
      options.ts            # composeFlags を利用し共通フラグを取り込む
    d2/
      options.ts
    mermaid/
      options.ts
    sql/
      options.ts
```

## 共通フラグ定義方針
- `FlagDefinition` 型（既存）を拡張して、`description`・`alias`・`group`（表示グルーピング用）を保持。
- `buildCommonFlagMap()`（仮名）で `Map<string, FlagDefinition>` を返却。キーはロングオプション。
- 共通化対象例:
  - `-m` (model)
  - `-e` (effort)
  - `-v` (verbose)
  - `--image` / `-i`
  - `--continue` / `-c`（CLI cross-over で必要な場合）
- 各フラグにはヘルプ本文・既定値・環境変数との関連を明示。

## フラグ構成ユーティリティ
- `composeFlagSet({ common, specific, overrides })` 形式で呼び出し、共通フラグ `common`（`Map`）に個別フラグを上書き結合。
- `overrides` で共通フラグの説明やデフォルト値を CLI ごとに上書き可能。
- 戻り値は `FlagDefinition[]`（ヘルプ表示順序でソート済み）を想定。

## ヘルプ生成ロジック
- `buildHelpSections(flags: FlagDefinition[], sections?: HelpSection[]) => string`
- `sections` で「共通」「モード固有」などの章立てを制御。
- 生成時に `alias` を整形し、環境変数情報があれば別欄に追加。
- 既存 CLI のヘルプ組み立てコードからロジックを移し、再利用する。

## 移行ステップ
1. `commonFlags.ts` と `composeFlags.ts` を追加、単体テスト実装。
2. 各 CLI の `options.ts` で共通フラグを読み込み、現行挙動を維持するよう組み替え。
3. 既存ヘルプ生成コードを `helpBuilder.ts` へ抽出し、各 CLI から利用するよう修正。
4. CLI 別の差異（デフォルト値・サポートモデルなど）を `overrides` で調整。
5. `bun run build && bun run lint && bun run format:check && bun run test` で検証。

## 検討メモ
- 将来的に agent-session を導入する場合も共通フラグを流用できるよう、core 層でモジュールを閉じる。
- CLI ごとの `options` モジュールは core 層以外へ依存しないため、共通化しても依存方向ガイドラインに抵触しない。
- CLI 固有でヘルプの文章を調整したい場合は `overrides.description` を活用する。
- 共通フラグ以外のヘルプ整形（使用例、サブコマンドなど）は従来の CLI 側ロジックを維持しつつ、必要に応じて `helpBuilder` へ段階的に移管する。
