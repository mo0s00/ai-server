-- Run in Supabase → SQL Editor (once per project).
-- Server POST /memo inserts: user_id, content

create table if not exists public.memos (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  content text not null,
  created_at timestamptz not null default now()
);

-- If the table already exists with wrong columns, add missing pieces:
alter table public.memos add column if not exists user_id text;
alter table public.memos add column if not exists content text;
alter table public.memos add column if not exists created_at timestamptz default now();

-- Optional: allow anon/service inserts via RLS (adjust to your security model).
-- alter table public.memos enable row level security;
-- create policy "server_insert_memos" on public.memos for insert with check (true);

comment on table public.memos is 'AI server /memo — user memos';
