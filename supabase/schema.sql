-- タスク管理アプリ用のテーブル
-- Supabase の「SQL Editor」→「New query」に全部貼り付けて「Run」してください。
-- 何度実行しても大丈夫なように書いてあります。

create table if not exists public.tasks (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  title       text not null,
  date        date not null,
  time        text,
  priority    text not null default 'mid',
  tag         text,
  done        boolean not null default false,
  done_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.routines (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  title       text not null,
  days        int[] not null default '{0,1,2,3,4,5,6}',
  created_at  timestamptz not null default now()
);

create table if not exists public.routine_logs (
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  routine_id  text not null references public.routines on delete cascade,
  date        date not null,
  primary key (user_id, routine_id, date)
);

create table if not exists public.notes (
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  date        date not null,
  body        text not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, date)
);

-- 長期目標（parent_id で親の目標につながるツリー）
create table if not exists public.goals (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  parent_id   text references public.goals on delete cascade,
  title       text not null,
  deadline    date,
  done        boolean not null default false,
  done_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- タスクの締切日時と、どの目標のステップかを入れる列
alter table public.tasks add column if not exists due timestamptz;
alter table public.tasks add column if not exists goal_id text references public.goals on delete set null;

create index if not exists tasks_user_date on public.tasks (user_id, date);

-- 本人のデータだけ読み書きできるようにする（Row Level Security）
alter table public.tasks        enable row level security;
alter table public.routines     enable row level security;
alter table public.routine_logs enable row level security;
alter table public.notes        enable row level security;
alter table public.goals        enable row level security;

drop policy if exists "own tasks" on public.tasks;
create policy "own tasks" on public.tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own routines" on public.routines;
create policy "own routines" on public.routines
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own routine_logs" on public.routine_logs;
create policy "own routine_logs" on public.routine_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own notes" on public.notes;
create policy "own notes" on public.notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own goals" on public.goals;
create policy "own goals" on public.goals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- 毎朝の通知（Web Push） ----------
-- 通知を受け取る端末（ホーム画面に追加したアプリごとに 1 行）
create table if not exists public.push_subscriptions (
  endpoint    text primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);

-- 通知の時刻。last_sent は送った日（Edge Function が書く）
create table if not exists public.notify_settings (
  user_id       uuid primary key default auth.uid() references auth.users on delete cascade,
  morning_time  text not null default '07:00',
  tz            text not null default 'Asia/Tokyo',
  last_sent     date
);

-- 昼・夕方に「まだ終わっていないタスク」を知らせる時刻（空ならオフ）。remind_sent は最後に送った回（例 2026-10-27T12:00）
alter table public.notify_settings add column if not exists remind_times text[] not null default '{12:00,18:00}';
alter table public.notify_settings add column if not exists remind_sent  text;

-- 通知を送るための鍵（Edge Function が初回に自動で作る）。
-- ポリシーを作らないので、アプリからは読めず Edge Function（service_role）だけが使える
create table if not exists public.push_keys (
  id           int primary key,
  public_key   text not null,
  private_key  text not null
);

alter table public.push_subscriptions enable row level security;
alter table public.notify_settings    enable row level security;
alter table public.push_keys          enable row level security;

drop policy if exists "own push_subscriptions" on public.push_subscriptions;
create policy "own push_subscriptions" on public.push_subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own notify_settings" on public.notify_settings;
create policy "own notify_settings" on public.notify_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- Claude との連携（Edge Function「ai」が窓口） ----------
-- 合言葉（アプリで作る）。そのものは保存せず、SHA-256 にした値だけを持つ
create table if not exists public.ai_tokens (
  token_hash  text primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  created_at  timestamptz not null default now()
);

-- Claude からの便り（週の振り返りなど）。steps は [{ parent_id, title, added }] のステップ案
create table if not exists public.ai_messages (
  id          text primary key default gen_random_uuid()::text,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  kind        text not null default 'review',
  period_end  date,
  body        text not null,
  steps       jsonb not null default '[]',
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);

alter table public.ai_tokens   enable row level security;
alter table public.ai_messages enable row level security;

drop policy if exists "own ai_tokens" on public.ai_tokens;
create policy "own ai_tokens" on public.ai_tokens
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own ai_messages" on public.ai_messages;
create policy "own ai_messages" on public.ai_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- Google カレンダーの取り込み（Edge Function「calendar」が iCal を読む） ----------
-- 非公開の iCal アドレス（これを知っている人は予定を読めるので、本人だけが読み書きできる）
create table if not exists public.calendar_settings (
  user_id     uuid primary key default auth.uid() references auth.users on delete cascade,
  ical_url    text not null,
  updated_at  timestamptz not null default now()
);

-- もうタスクにした予定（key は「予定の UID|繰り返しの回」）。タスクを消しても二度と入らないように残す
create table if not exists public.calendar_imports (
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  key         text not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.calendar_settings enable row level security;
alter table public.calendar_imports  enable row level security;

drop policy if exists "own calendar_settings" on public.calendar_settings;
create policy "own calendar_settings" on public.calendar_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own calendar_imports" on public.calendar_imports;
create policy "own calendar_imports" on public.calendar_imports
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 5 分ごとに Edge Function「push」を呼ぶ（送る時刻かどうかは関数の中で判断する）
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
select cron.schedule('morning-push', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://ndmemqobhhivlsjshowk.supabase.co/functions/v1/push',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"action": "cron"}'::jsonb
  );
$$);
