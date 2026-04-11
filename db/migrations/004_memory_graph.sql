-- Memory graph (Intro, etc.): nodes with category for legend, facts in blob, edges.
CREATE TABLE IF NOT EXISTS memory_graph_nodes (
  id TEXT PRIMARY KEY NOT NULL,
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  blob TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_graph_nodes_cat_label ON memory_graph_nodes (category, label);

CREATE TABLE IF NOT EXISTS memory_graph_edges (
  id TEXT PRIMARY KEY NOT NULL,
  source_node_id TEXT NOT NULL REFERENCES memory_graph_nodes (id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES memory_graph_nodes (id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_graph_edges_src ON memory_graph_edges (source_node_id);
CREATE INDEX IF NOT EXISTS idx_memory_graph_edges_tgt ON memory_graph_edges (target_node_id);
