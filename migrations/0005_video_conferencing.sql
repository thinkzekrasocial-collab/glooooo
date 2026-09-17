-- Cloudflare D1 migration (SQLite). The Next/PostgreSQL runtime uses the
-- equivalent Drizzle schema; do not run this file through PostgreSQL.
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'draft',
  video_calls_enabled INTEGER NOT NULL DEFAULT 0, voice_calls_enabled INTEGER NOT NULL DEFAULT 0,
  call_start_permission TEXT NOT NULL DEFAULT 'admin_only', call_join_permission TEXT NOT NULL DEFAULT 'group_members',
  screen_sharing_enabled INTEGER NOT NULL DEFAULT 0, max_call_participants INTEGER,
  created_by_admin_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role TEXT NOT NULL DEFAULT 'member', removed_at TEXT,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS video_meetings (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  room_name TEXT NOT NULL UNIQUE,
  meeting_type TEXT NOT NULL CHECK (meeting_type IN ('video', 'voice')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('scheduled', 'active', 'ended', 'cancelled')),
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  scheduled_start_at TIMESTAMPTZ,
  scheduled_end_at TIMESTAMPTZ,
  ended_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_video_meetings_group ON video_meetings(group_id);
CREATE INDEX IF NOT EXISTS idx_video_meetings_creator ON video_meetings(created_by);
CREATE INDEX IF NOT EXISTS idx_video_meetings_status ON video_meetings(status);
CREATE INDEX IF NOT EXISTS idx_video_meetings_room ON video_meetings(room_name);
CREATE INDEX IF NOT EXISTS idx_video_meetings_created ON video_meetings(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_video_active_group ON video_meetings(group_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS video_meeting_participants (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES video_meetings(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'participant' CHECK (role IN ('host', 'participant')),
  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'joined', 'left', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (meeting_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_video_participants_meeting ON video_meeting_participants(meeting_id);
CREATE INDEX IF NOT EXISTS idx_video_participants_user ON video_meeting_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_video_participants_status ON video_meeting_participants(meeting_id, status);
