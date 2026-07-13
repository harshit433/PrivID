-- Rename LiveKit media room id → Stream Video call id (activity parties).
ALTER TABLE activity_sessions
  RENAME COLUMN livekit_room_id TO stream_call_id;
