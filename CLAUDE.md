# 毎日のタスク（個人用タスク管理アプリ）

ユーザー本人だけが使う、PC と iPhone で同期するタスク管理 Web アプリ。

## 公開先・外部サービス
- 公開 URL: https://spacebook3080.github.io/task-app/ （GitHub Pages、`main` ブランチの root をそのまま配信）
- リポジトリ: https://github.com/Spacebook3080/task-app （Public）
- Supabase プロジェクト: `ndmemqobhhivlsjshowk`（リージョン Singapore、Free プラン）
  - ダッシュボード: https://supabase.com/dashboard/project/ndmemqobhhivlsjshowk
  - 新規登録は無効化済み（`disable_signup: true`）。利用者はユーザー本人のアカウント1つだけ
  - `config.js` の publishable キーは公開前提の値。service_role / secret キーや DB パスワードは絶対にコードやチャットに入れない
- `git push` すると 1〜2 分で公開版に反映される（ビルド工程なし）

## 構成
- ビルドなしの素の HTML/CSS/JS。npm・Node・Python はこの PC に入っていない
- `index.html` … 画面と CSS（ライト/ダーク対応、iPhone の safe-area 対応）
- `app.js` … すべてのロジック
  - 状態は `state = { tasks, routines, routineDone: {date: [routineId]}, notes: {date: body}, goals }`（goals は `parentId` でつながるツリー。タスクは `due`（締切）と `goalId` を持つ）
  - 変更は `commit(ops)` でローカルキャッシュ（localStorage）に保存 → 送信キューに積んで Supabase に送る（オフラインでも動く）
  - `pull()` で全件取り直し（起動時・画面復帰時・1 分ごと）
  - Supabase 未設定なら端末内保存だけのモードで動く
- `config.js` … Supabase の URL と publishable キー
- `sw.js` … Service Worker（自前ファイルはネット優先、supabase-js は CDN 版をキャッシュ）
- `manifest.webmanifest`, `icons/` … ホーム画面に追加するための PWA 設定
- `supabase/schema.sql` … テーブル定義と RLS（本人の行だけ読み書き可）。スキーマを変えるときはここを更新し、ユーザーに SQL Editor で実行してもらう
  - SQL Editor: https://supabase.com/dashboard/project/ndmemqobhhivlsjshowk/sql/new

## 開発・確認方法
- ローカル確認: `.claude/launch.json` の `task-app`（PowerShell 製の簡易サーバー `.claude/serve.ps1`、http://localhost:8080）
- ローカルでも本番の Supabase につながる。テストでデータを作ったら必ず消す

## 機能の現状
- 実装済み: 長期目標のツリー（`goals` テーブル、何段でも分けられる・期限・進み具合・順調/遅れ気味・ステップを「→今日」でタスク化）、タスクの締切日時、日付ごとのタスク（優先度・時間・カテゴリ）、未完了タスクの持ち越し表示、→明日、毎日の習慣（曜日指定）、達成率バー、日ごとのメモ、JSON の書き出し/読み込み、ログイン、パスワード再設定/変更、PWA
- 今後の候補: iPhone への通知（Web Push。ホーム画面に追加した PWA のみ対象。Edge Function + pg_cron が必要）、習慣の連続記録、週の予定表、数値で測る目標、習慣と目標のひもづけ

## ユーザーについて
- プログラミング初心者。日本語で、専門用語を避けて、1 回に 1〜2 ステップずつ案内する
- Supabase や GitHub の画面操作をお願いするときは、直接開けるリンクを付ける
- 有料サービスは避けたい（無料枠で作る）
- iPhone を使用（Safari、ホーム画面に追加済み）
