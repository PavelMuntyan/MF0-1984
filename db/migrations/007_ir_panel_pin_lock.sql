-- Per-panel PIN (Intro, Rules, Access) — each row is an independently set lock.
CREATE TABLE IF NOT EXISTS ir_panel_pin_lock (
  panel TEXT PRIMARY KEY CHECK (panel IN ('intro', 'rules', 'access')),
  pin_double_hash TEXT NOT NULL
);
