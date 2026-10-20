# Frontend

React / TypeScript / Viteの画面実装です。概要・最新画面・起動・検証結果は[ルートREADME](../README.md)を参照してください。

```sh
npm ci
npm run dev -- --host 127.0.0.1
```

テストにはChrome / Chromium / Edgeと、Backend依存を導入したPythonが必要です。`BROWSER_PATH`、`TIMER_TEST_PYTHON`で実行ファイルを指定できます。APIモックまたは専用の新規一時SQLite DBを使い、通常DBを入力にしません。
