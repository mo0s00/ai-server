-- Supabase SQL Editor에서 한 번 실행 — 가상 제작자 프로필·스토리 지정 (계정당 1행 JSON)
-- ai-server: GET/POST /api/virtual-story-creators

create table if not exists public.virtual_story_creator_prefs (
  user_id text not null primary key,
  profiles jsonb not null default '[]'::jsonb,
  assignments jsonb not null default '{}'::jsonb,
  updated_at_ms bigint not null default 0,
  updated_at timestamptz not null default now()
);

comment on table public.virtual_story_creator_prefs is '가상 스토리 제작자 — user_id __global__ 1행(앱 전체 공통). 관리자 POST(333).';
