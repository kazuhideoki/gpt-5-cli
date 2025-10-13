# Formattingユーティリティ移動のメモ

`refactor: move formatting helpers into core` コミットでは、`src/cli/ask/utils.ts` にあったフォーマッタ群を `src/core/formatting.ts` へ移動した。実装は既存の関数群をそのまま移設しており、関数名や `EffortLevel` 型など設計・命名上の変更は加えていない。

移動の目的は ask / d2 の両 CLI で同じロジックを共有し、モジュール間の重複を避けるため。これによりテストファイルも `src/core/formatting.test.ts` に再配置され、`src/core` 配下で一貫して検証できるようになった。
