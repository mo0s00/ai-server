-- Supabase SQL editor / migration reference for user_presence.
create table if not exists public.user_presence (
  user_id text primary key,
  last_seen_at timestamptz not null default now(),
  current_screen text,
  app_version text,
  platform text,
  last_event text,
  updated_at timestamptz not null default now()
);

create index if not exists user_presence_last_seen_at_idx
  on public.user_presence (last_seen_at desc);
