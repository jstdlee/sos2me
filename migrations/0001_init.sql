-- Key/value store for the GUI-editable config and small cursors (e.g. ntfy "since").
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per message from the child; also tracks the alert it triggered.
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  sender TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  level TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  acknowledged_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_received ON messages (received_at DESC);

-- Activity log: calls, SMS, classification, errors.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  message_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_events_message ON events (message_id, id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (id DESC);
