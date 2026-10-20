# SQLite schema evolution

このディレクトリは提出版SQLite用です。MySQL用Alembic系列は含みません。

| 履歴 | 主な対象 |
|---|---|
| 001 / 002 SQL | 初期の旧Schema用資料。新規起動時に手作業で実行しません |
| 003 | ScheduleBlock、NULL見積、完了・Project snapshot |
| 004 | 永続化Timer、TimeEntry、単一Activeの部分一意index |
| 005 | Task優先度・締切 |
| 006 | TagとTaskの多対多関連 |
| 007 | Project / Tagの識別色 |
| 008 | Task開始日 |

起動時には008のrunnerから前提を順に検証します。未適用変更は個別承認フラグが必要です。提出版の `run_portfolio.py --initialize` は新規の専用ローカルDBだけを選択し、そのDBに限って初期化を許可します。通常再起動ではフラグを付けません。

既存DBの自動採用、旧開発DBの移行、未知Schemaの自動修復は行いません。初期化失敗時は状態を保持して停止し、DB削除・再実行を自動で行いません。データの実体と内部検証ログはGit対象外です。
