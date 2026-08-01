-- Initial schema for __APP_NAME__.
-- Migrations run once, in filename order, tracked in _urban_migrations.
CREATE TABLE IF NOT EXISTS greetings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  who        TEXT NOT NULL,
  message    TEXT NOT NULL,
  createdAt  TEXT
);
