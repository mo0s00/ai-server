-- Supabase SQL Editor에서 한 번 실행 — 스토리별 좋아요·즐겨찾기(관리자·전역)
-- ai-server: GET /api/story-social-stats/public, POST /api/story-social-stats (333)

create table if not exists public.story_social_stats_prefs (
  user_id text not null primary key,
  stats jsonb not null default '{}'::jsonb,
  updated_at_ms bigint not null default 0,
  updated_at timestamptz not null default now()
);

comment on table public.story_social_stats_prefs is '스토리 소셜 수치 — user_id __global__ 1행. stats: { storyId: { likes, bookmarks } }';

alter table public.creator_tiers
  add column if not exists ranking_favorites_override int;
