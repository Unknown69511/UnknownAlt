-- Clients UnknownAlt follows (instances::tracker::Saved as JSON), so a restarted UnknownAlt follows them
-- again; a row goes when its client ends.
CREATE TABLE tracked (
  instance_id TEXT PRIMARY KEY,
  data        TEXT NOT NULL
);
