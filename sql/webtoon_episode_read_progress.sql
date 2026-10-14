-- #784: Per-episode reader progress for the webtoon episode list.
-- Deploy this schema before the server endpoint that reads/writes it.
-- The existing webtoon_read_progress keeps the last-read chapter position.
CREATE TABLE IF NOT EXISTS public.webtoon_episode_read_progress (
  user_id text NOT NULL,
  story_id uuid NOT NULL,
  episode_beat integer NOT NULL CHECK (episode_beat > 0),
  cut_index integer NOT NULL CHECK (cut_index BETWEEN 0 AND 59),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, story_id, episode_beat)
);
ALTER TABLE public.webtoon_episode_read_progress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.webtoon_episode_read_progress FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.webtoon_episode_read_progress TO service_role;

INSERT INTO public.webtoon_episode_read_progress
  (user_id, story_id, episode_beat, cut_index, updated_at)
SELECT user_id, story_id, episode_beat, cut_index, updated_at
FROM public.webtoon_read_progress
WHERE episode_beat > 0 AND cut_index BETWEEN 0 AND 59
ON CONFLICT (user_id, story_id, episode_beat) DO UPDATE SET
  cut_index = GREATEST(
    public.webtoon_episode_read_progress.cut_index, EXCLUDED.cut_index
  ),
  updated_at = GREATEST(
    public.webtoon_episode_read_progress.updated_at, EXCLUDED.updated_at
  );

CREATE OR REPLACE FUNCTION public.webtoon_mark_episode_read(
  p_user_id text, p_story_id uuid, p_beat integer, p_cut integer
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' OR p_story_id IS NULL OR
     p_beat IS NULL OR p_beat <= 0 OR p_cut IS NULL OR
     p_cut < 0 OR p_cut >= 60 THEN
    RAISE EXCEPTION 'invalid reading progress';
  END IF;
  INSERT INTO public.webtoon_episode_read_progress
    (user_id, story_id, episode_beat, cut_index, updated_at)
  VALUES (p_user_id, p_story_id, p_beat, p_cut, now())
  ON CONFLICT (user_id, story_id, episode_beat) DO UPDATE SET
    cut_index = GREATEST(
      public.webtoon_episode_read_progress.cut_index, EXCLUDED.cut_index
    ),
    updated_at = now();
END;
$$;
-- Supabase can grant extra function defaults to API roles: revoke explicitly.
REVOKE EXECUTE ON FUNCTION public.webtoon_mark_episode_read(text,uuid,integer,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.webtoon_mark_episode_read(text,uuid,integer,integer)
  TO service_role;
