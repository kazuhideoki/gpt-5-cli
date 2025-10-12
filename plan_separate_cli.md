# CLI 分離計画（default / d2）

## 背景
- 単一 CLI（`src/cli.ts` → `dist/cli.js`）に複数モードを抱えていたため、機能差分の把握が難しく保守性が低かった。
- default モードと d2 モードで依存関係・フラグ構成が異なり、別 CLI として分離することでユーザー体験を改善したかった。
- 将来的な追加モード（SQL など）に備え、共通基盤を整理する必要があった。

## 進捗状況
- [x] default 用 CLI を `src/cli/default.ts` に実装し、`dist/cli/default.js` をエントリーポイントとしてビルド。
- [x] d2 用 CLI を `src/cli/d2.ts` に実装し、`dist/cli/d2.js` をエントリーポイントとしてビルド。
- [x] 共通ロジック（設定・履歴ストア・OpenAI クライアントなど）を `src/core/` と `src/cli/shared/` へ集約。
- [x] 業務ロジック（会話開始/再開など）を `src/commands/` に配置し、両 CLI から再利用。
- [x] 履歴タスクのスキーマを `task.mode` 付きで保持できるよう `cliHistoryTaskSchema` を整備。
- [x] `package.json` の `bin` を `gpt-5-cli`（default）と `gpt-5-cli-d2`（d2）に分割し、`bun run start` は default CLI を指すよう調整。
- [x] テストを `tests/default/` と `tests/d2/` に分割し、各 CLI の統合テストを実行可能にした。
- [x] README / ドキュメントのモード別利用方法を最新構成へ反映。
- [ ] 追加モード（SQL など）への展開は未着手。

## 成果物
- default 用 CLI と d2 用 CLI を独立したエントリーポイントとしてビルド・配布できる状態。
- 共通ロジックを `src/core/` と `src/cli/shared/` へ集約したアーキテクチャ。
- 履歴タスクがモード情報を保持し、既存履歴を損なわずに拡張可能な構造。
- CLI ごとの統合テストを個別に実行できる体制（`tests/default/` と `tests/d2/`）。

## 実現方針
1. **ディレクトリ構成**
   - CLI エントリーポイントは `src/cli/default.ts` と `src/cli/d2.ts` に配置する。
   - 共通基盤を `src/core/` および CLI 共有ユーティリティを `src/cli/shared/` にまとめる。
   - 業務ロジックを `src/commands/` でユースケース単位に定義し、CLI 層は引数パースと入出力に専念する。
2. **ビルド・エントリーポイント**
   - `tsconfig.json` と `package.json` を複数エントリに対応させ、`bun run build` で `dist/cli/default.js` と `dist/cli/d2.js` を生成する。
   - `bun run start` / `bun run start:d2` によりビルド済み CLI を直接実行できるようにする。
3. **既存機能の移植**
   - default 版：旧 CLI のコマンド群を移植し、既存オプションとの互換を維持する。
   - d2 版：`d2` 固有の初期化を `src/cli/d2.ts` に集中させ、不要な分岐を排除する。
4. **履歴と設定の共通化**
   - 履歴スキーマ定義を `src/core/history/` 系へ集約し、モードに応じた型安全なアクセスを提供する。
   - `.env` 読み込みやデフォルト値は `src/core/config/` に集約し、両 CLI から共有する。
5. **テストとドキュメント**
   - `tests/default/` と `tests/d2/` に CLI 2 種のスモークテストを配置する。
   - README や `plan*.md` を分離後の構成に合わせて更新する。

## 既知の課題・検討事項
- default / d2 以外のモード（SQL など）は後続タスクで対応する。
- CLI 分割後のインストール／実行手順が増えるため、ユーザーへの周知とサンプルを定期的に見直す。

## ディレクトリ構成メモ
- `src/core/`: 共通インフラ層（設定、履歴スキーマ、OpenAI クライアント等）
- `src/cli/shared/`: CLI 共通のヘルパー（ブートストラップ、履歴ストアの生成など）
- `src/commands/`: 業務ロジック層（会話開始、d2 レンダリング等のユースケース処理）
- `src/cli/default.ts`: default CLI エントリーポイント
- `src/cli/d2.ts`: d2 CLI エントリーポイント
- `dist/cli/default.js`, `dist/cli/d2.js`: ビルド成果物
- `tests/default/`: default CLI の統合テスト
- `tests/d2/`: d2 CLI の統合テスト
