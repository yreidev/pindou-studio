CREATE TABLE backup_runs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('local', 'offsite')),
  name text NOT NULL CHECK (name ~ '^pindou_[0-9T+-]+\.dump$'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  finished_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX backup_runs_latest ON backup_runs (kind, id DESC);
