CREATE TABLE target_browser_runs (
  id uuid PRIMARY KEY, target_id uuid NOT NULL REFERENCES target_accounts(id),
  kind text NOT NULL, status text NOT NULL DEFAULT 'QUEUED', profile_url text,
  "limit" integer NOT NULL DEFAULT 0, results jsonb NOT NULL DEFAULT '[]', message text,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX target_browser_runs_target_id_kind_created_at_idx ON target_browser_runs(target_id, kind, created_at);
