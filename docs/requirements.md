# 実装範囲・主要仕様

本書は公開するSQLite版の範囲です。内部の将来要件を実装済み機能として転記していません。最新の実行結果は[検証記録](testing.md)を参照してください。

| 機能 | 現在の仕様・制約 |
|---|---|
| Task | タイトル必須。見積はNULL可・指定時は正。優先度HIGH/MEDIUM/LOW、開始日・締切、Project、複数Tagを扱う |
| 日付 | 開始日と締切の両方がある場合は開始日≦締切。ローカル日付を時刻へ読み替えない |
| Project / Tag | 名前・識別色の登録・更新・削除。存在しないTag ID等の入力を拒否する |
| ScheduleBlock | Task必須。TIME_UNSET / TIMED / ALL_DAY。TIMEDは開始時刻と正の予定時間を持つ |
| Inbox | 現在のScheduleBlockがないTask。旧互換予定列を現行予定の根拠にしない |
| Timer | StartでActiveをINSERT、Pause / Stopで終了、Resumeで新しい区間。同時ActiveはDB全体で1件 |
| 手動TimeEntry | Task必須、タイムゾーン付き開始・終了、正の区間。重複を拒否し、作成・修正・削除が可能 |
| Task状態 | NOT_STARTED / IN_PROGRESS / COMPLETED。開始・手動実績登録で進行中化する。完了Taskの計測は拒否 |
| 集計 | 日・週・月API、画面の期間・Project・Tagフィルタ。取得時点までのActive実績を含む |
| 保護 | TimeEntry付きTaskとSnapshot参照Projectは削除409。TagはTask関連であり実績独立Tagではない |

APIが扱う見積・予定占有・実績は異なる指標です。同じTaskを同日に複数予定しても、APIの日見積は1回です。APIの週・月見積は日別値の合計なので、別の日に同じTaskを予定すれば各日に計上します。予定占有は重複するTIMED区間を一度だけ数えます。画面のレポート主カードは「計画済み」「記録」「計画差」であり、見積集計をそのまま表示するカードではありません。

未実装：正式ログイン・Session、User別Owner認可、Trash / Restore、Taskなし実績、独立予定、実績専用Tag、MySQL業務テーブルへの移行。将来の名称長・完全一致キーなどを本提出版の新仕様として確定していません。
