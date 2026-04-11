-- External services catalog (Access section). Replaces data/access-external-services.json.
CREATE TABLE IF NOT EXISTS access_external_services (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  endpoint_url TEXT NOT NULL DEFAULT '',
  access_key TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_access_external_services_name ON access_external_services (name);
