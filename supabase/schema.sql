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
