-- Single-row table: presence of row = Intro PIN is set (locked until correct unlock clears it).
CREATE TABLE IF NOT EXISTS intro_pin_lock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  pin_double_hash TEXT NOT NULL
);
