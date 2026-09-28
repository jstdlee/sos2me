-- Where the child was (GPS, IP, network, device) and extra details they added after sending (JSON).
ALTER TABLE messages ADD COLUMN context TEXT NOT NULL DEFAULT '';
-- AI picture of what is happening, from the recent messages (JSON, see Situation in shared/types.ts).
ALTER TABLE messages ADD COLUMN situation TEXT NOT NULL DEFAULT '';
