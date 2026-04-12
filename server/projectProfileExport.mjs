/**
 * @returns {string} e.g. Project_Profile_20260412_210530.mf
 */
export function projectProfileMfFilename() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `Project_Profile_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.mf`;
}

/**
 * Builds an AES-256–encrypted 7z archive (saved as .mf) for Project profile export.
 * Passphrase is the 64-char hex string produced on the client: SHA256( SHA384( utf8(password) ) as binary digest chain ).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { path7za } = require("7zip-bin");

const RULES_DIR_NAME = "rules";
const RULES_KEEPER_FILES = [
  "core_rules.json",
  "private_rules.json",
  "forbidden_actions.json",
  "workflow_rules.json",
];

/**
 * @param {string} hex
 */
function assertArchivePassphraseHex(hex) {
  const h = String(hex ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) {
    throw new Error("Invalid archive passphrase encoding.");
  }
  return h;
}

function ensure7zaExecutable() {
  try {
    fs.accessSync(path7za, fs.constants.X_OK);
  } catch {
    try {
      fs.chmodSync(path7za, 0o755);
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string[]} args
 * @param {{ cwd: string }} opts
 */
function run7za(args, opts) {
  return new Promise((resolve, reject) => {
    ensure7zaExecutable();
    const child = spawn(path7za, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`7za failed (${code}): ${stderr.trim().slice(-800)}`));
    });
  });
}

/**
 * @param {import("better-sqlite3").Database} database
 */
function exportSqliteRulesContextRows(database) {
  const tbl = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='rules'`)
    .get();
  if (!tbl) return [];
  return database
    .prepare(
      `SELECT id, rule_type AS ruleType, title, content, priority, tags, is_active AS isActive FROM rules ORDER BY priority ASC, title COLLATE NOCASE ASC`,
    )
    .all();
}

/**
 * @param {{
 *   database: import("better-sqlite3").Database,
 *   projectRoot: string,
 *   archivePassphraseHex: string,
 *   aiModelsSnapshot: unknown,
 *   memoryGraph: { nodes: unknown[], links: unknown[] },
 *   accessExternal: { entries: unknown[] },
 *   accessEnrichment: unknown,
 * }} opts
 * @returns {Promise<Buffer>}
 */
export async function buildProjectProfileMf7zBuffer(opts) {
  const passphrase = assertArchivePassphraseHex(opts.archivePassphraseHex);
  const database = opts.database;
  const projectRoot = opts.projectRoot;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mf0-profile-"));
  const stagingDir = path.join(tmpRoot, "s");
  const out7z = path.join(tmpRoot, "bundle.7z");

  try {
    fs.mkdirSync(path.join(stagingDir, RULES_DIR_NAME), { recursive: true });

    const exportedAt = new Date().toISOString();
    const manifest = {
      schema: "mf0.project_profile_bundle.v1",
      exportedAt,
      app: "MF0-1984",
      cryptoNote:
        "7z AES-256; archive passphrase = hex(SHA256( SHA384( UTF-8(user password) ) )) — derive the same way on import.",
      paths: {
        memoryGraph: "mf0_memory_graph_for_db.json",
        rulesSqlite: "mf0_sqlite_rules_context_for_db.json",
        rulesKeeperDir: `${RULES_DIR_NAME}/`,
        accessServices: "mf0_access_external_services_for_db.json",
        accessEnrichment: "mf0_access_data_dump_enrichment_for_db.json",
        aiModels: "mf0_ai_models_local_storage_for_restore.json",
        env: "mf0_env_dotenv_for_restore.txt",
      },
    };
    fs.writeFileSync(path.join(stagingDir, "mf0_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const memoryPayload = {
      schema: "mf0.project_export.memory_graph.v1",
      exportedAt,
      nodes: Array.isArray(opts.memoryGraph?.nodes) ? opts.memoryGraph.nodes : [],
      links: Array.isArray(opts.memoryGraph?.links) ? opts.memoryGraph.links : [],
    };
    fs.writeFileSync(
      path.join(stagingDir, "mf0_memory_graph_for_db.json"),
      `${JSON.stringify(memoryPayload, null, 2)}\n`,
      "utf8",
    );

    const ctxRows = exportSqliteRulesContextRows(database);
    fs.writeFileSync(
      path.join(stagingDir, "mf0_sqlite_rules_context_for_db.json"),
      `${JSON.stringify({ schema: "mf0.project_export.rules_context_sqlite.v1", exportedAt, rows: ctxRows }, null, 2)}\n`,
      "utf8",
    );

    const rulesDir = path.join(projectRoot, "rules");
    for (const name of RULES_KEEPER_FILES) {
      const src = path.join(rulesDir, name);
      const dest = path.join(stagingDir, RULES_DIR_NAME, name);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      } else {
        fs.writeFileSync(dest, `${JSON.stringify({ items: [] }, null, 2)}\n`, "utf8");
      }
    }

    const accessPayload = {
      schema: "mf0.project_export.access_external_services.v1",
      exportedAt,
      entries: Array.isArray(opts.accessExternal?.entries) ? opts.accessExternal.entries : [],
    };
    fs.writeFileSync(
      path.join(stagingDir, "mf0_access_external_services_for_db.json"),
      `${JSON.stringify(accessPayload, null, 2)}\n`,
      "utf8",
    );

    const enrichPayload = {
      schema: "mf0.project_export.access_data_dump_enrichment.v1",
      exportedAt,
      data: opts.accessEnrichment ?? {},
    };
    fs.writeFileSync(
      path.join(stagingDir, "mf0_access_data_dump_enrichment_for_db.json"),
      `${JSON.stringify(enrichPayload, null, 2)}\n`,
      "utf8",
    );

    const aiPayload = {
      schema: "mf0.project_export.ai_models_local_storage.v1",
      exportedAt,
      snapshot: opts.aiModelsSnapshot && typeof opts.aiModelsSnapshot === "object" ? opts.aiModelsSnapshot : {},
    };
    fs.writeFileSync(
      path.join(stagingDir, "mf0_ai_models_local_storage_for_restore.json"),
      `${JSON.stringify(aiPayload, null, 2)}\n`,
      "utf8",
    );

    const envPath = path.join(projectRoot, ".env");
    let envText = "";
    if (fs.existsSync(envPath)) {
      try {
        envText = fs.readFileSync(envPath, "utf8");
      } catch {
        envText = "";
      }
    }
    if (!envText.trim()) {
      envText = "# (.env was missing or empty at export time)\n";
    }
    fs.writeFileSync(path.join(stagingDir, "mf0_env_dotenv_for_restore.txt"), envText, "utf8");

    await run7za(
      ["a", "-t7z", "-mx=9", "-mhe=on", "-r", `-p${passphrase}`, out7z, "."],
      { cwd: stagingDir },
    );

    if (!fs.existsSync(out7z)) {
      throw new Error("7z archive was not created.");
    }
    const st = fs.statSync(out7z);
    if (st.size < 32) {
      throw new Error("7z archive is unexpectedly small.");
    }
    return fs.readFileSync(out7z);
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
