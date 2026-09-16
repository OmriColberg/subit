-- ============================================================
-- Subit — video_history table
-- Run once in the Supabase SQL editor.
-- ============================================================

CREATE TABLE IF NOT EXISTS video_history (
  id           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      uuid        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  video_id     text        NOT NULL,
  filename     text        NOT NULL,
  credits_used integer     DEFAULT 0,
  srt_content  text,
  segments     jsonb,
  created_at   timestamptz DEFAULT now() NOT NULL
);

-- Index for fast per-user queries (newest first)
CREATE INDEX IF NOT EXISTS video_history_user_created
  ON video_history (user_id, created_at DESC);

-- RLS: each user sees and writes only their own rows
ALTER TABLE video_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_select_own_history"
  ON video_history FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_history"
  ON video_history FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_history"
  ON video_history FOR DELETE
  USING (auth.uid() = user_id);
