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

## 2 台の PC で開発している
- ノート PC（LAPTOP-2K2H9E2A）: `C:\Users\Axely\Desktop\タスク管理`
- 自宅デスクトップ PC（DESKTOP-BS96LUJ、メインにする予定）: `C:\Users\Axely\OneDrive\デスクトップ\タスク管理`
- 作業を始めるときは、まず `git pull` で、もう 1 台での変更を取り込む
- 区切りがついたら commit して `git push` まで行う。push していない変更は、もう 1 台からは見えない
- iPhone からはリモートコントロールで操作する

## 開発・確認方法
- ローカル確認: `.claude/launch.json` の `task-app`（PowerShell 製の簡易サーバー `.claude/serve.ps1`、http://localhost:8080）
- ローカルでも本番の Supabase につながる。テストでデータを作ったら必ず消す

## 機能の現状
- 実装済み: 長期目標のツリー（`goals` テーブル、何段でも分けられる・期限・進み具合・順調/遅れ気味・ステップを「→今日」でタスク化・↪ で移動）、段階の名前（深さ 0 = ビジョン、1 = 目標、2 以降 = ステップ。データは深さで決まるだけで列はない。アドネスの VisionToDo を参考）、ホームの目標カードに最近 7 日の進みと次のステップ、🤖 で Claude への依頼文をコピー → 返事の箇条書きを貼るとツリーに追加（「（期限 YYYY-MM-DD）」は期限として読む）、週の振り返り（設定した曜日に表示。曜日は端末ごとに localStorage。内容はその日の `notes` に【週の振り返り】〜【振り返りここまで】の形で保存。🤖 で相談文をコピー）、タスクの締切日時、日付ごとのタスク（優先度・時間・カテゴリ）、未完了タスクの持ち越し表示、→明日、毎日の習慣（曜日指定）、達成率バー、日ごとのメモ、JSON の書き出し/読み込み、ログイン、パスワード再設定/変更、PWA、毎朝の通知（Web Push。Edge Function `supabase/functions/push` を pg_cron が 5 分ごとに呼ぶ。通知の鍵は Edge Function が初回に作って `push_keys` に保存）

## ビジョン（2026-10-26 にユーザーと決定）
**「毎日やったことが、長期目標にどれだけ近づいたかが一目でわかるアプリ」**
- いちばんの困りごと: 目標が進んでいるかわからない
- 進み具合は「終えたステップの数」で測る（今の `leafCount` の考え方のまま）
- 新しい機能はこの軸に沿うかで判断する。沿わないものは後回し

### 優先順位
1. ~~目標の進み具合を見やすくする~~（済。段階の名前・週の振り返りも済）
2. 習慣と目標のひもづけ
3. 数値で測る目標
4. Claude とつないで進み具合を相談する（有料の API は避けたい）
   - コピペ方式（🤖 ボタン）に加えて、クラウドのスケジュールタスクで週の振り返りを自動で書く仕組みを作った（2026-10-26）
   - 窓口は Edge Function `supabase/functions/ai`（Verify JWT オフ）。アプリの ⚙ 設定で作った合言葉（`ai_tokens` に SHA-256 だけ保存）を `Authorization: Bearer` で受け取り、`week`（7 日分の記録を返す）と `post`（`ai_messages` に保存して通知）だけができる
   - 合言葉は claude.ai の cloud environment のネットワークシークレット（ホスト `ndmemqobhhivlsjshowk.supabase.co`）に登録。Claude からは値が見えない
   - スケジュールタスクの手順書は `supabase/claude-weekly-review.md`（タスクの指示文は「このファイルを読んでその手順どおりに」）
   - 設定済み・動作確認済み（2026-10-26）: SQL 実行、関数 `ai` を配置（Verify JWT オフ）、合言葉を cloud environment「Default」（ネットワーク: 制限付き）に登録、スケジュールタスク「週の振り返り」（毎週日曜 20:07、リポジトリ task-app、コネクタなし）。今すぐ実行で iPhone に通知が届いた
   - Supabase コネクタ（何でもできてしまう）と Google ドライブ経由（アプリに Google ログインが必要）は比べた上で見送り
- 保留: 年間カレンダー（1 年分をマス目で表示し、タスクを終えた日ほど濃くする）、習慣の連続記録、週の予定表、締切前の通知

## ユーザーについて
- プログラミング初心者。日本語で、専門用語を避けて、1 回に 1〜2 ステップずつ案内する
- Supabase や GitHub の画面操作をお願いするときは、直接開けるリンクを付ける
- 有料サービスは避けたい（無料枠で作る）
- iPhone を使用（Safari、ホーム画面に追加済み）
