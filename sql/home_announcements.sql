-- 홈 공지 알림 — 전 사용자 공통 · 관리자(333) POST/DELETE.
create table if not exists public.home_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  created_at_ms bigint not null,
  created_at timestamptz not null default now()
);

create index if not exists home_announcements_created_at_ms_idx
  on public.home_announcements (created_at_ms desc);

comment on table public.home_announcements is '앱 홈 상단 공지 — GET public · 관리자 POST/DELETE(333).';
