-- 코모카 제작자 순위 · 캔디 귀속 · 하트 — Supabase SQL Editor에서 1회 실행
-- ai-server: GET /api/creator-ranking, POST /api/creator-candy-event, POST /api/creator-heart

create table if not exists public.creator_candy_events (
  id uuid primary key default gen_random_uuid(),
  creator_user_id text not null,
  spender_user_id text not null,
  content_type text not null default '',
  content_id text not null default '',
  candies int not null check (candies > 0),
  reason text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists creator_candy_events_creator_created_idx
  on public.creator_candy_events (creator_user_id, created_at desc);

create table if not exists public.creator_hearts (
  creator_user_id text not null,
  giver_user_id text not null,
  created_at timestamptz not null default now(),
  primary key (creator_user_id, giver_user_id)
);

create index if not exists creator_hearts_creator_idx
  on public.creator_hearts (creator_user_id);

create table if not exists public.creator_tiers (
  creator_user_id text primary key,
  tier text not null default 'sprout',
  display_name text not null default '',
  points_lifetime int not null default 0,
  updated_at timestamptz not null default now()
);

comment on table public.creator_tiers is 'tier: sprout | pick | partner | ambassador';
