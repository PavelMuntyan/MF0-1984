/**
 * Import project profile from `.mf` (7z AES). Validates bundle layout, replaces DB + rules files + `.env`,
 * restores Access data-dump enrichment snapshot, returns AI model keys for the client.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { normalizeImportPayload, replaceMemoryGraphInDatabase } from "./memoryGraphImport.mjs";
import { writeAccessDataDumpEnrichmentImportFromArchivedPayload } from "./accessDataDumpImportCache.mjs";
import { replaceAccessExternalServicesInDatabase } from "./accessExternalServicesDb.mjs";

const require = createRequire(import.meta.url);
const { path7za } = require("7zip-bin");

const MANIFEST_SCHEMA = "mf0.project_profile_bundle.v1";

const REQUIRED_ROOT_FILES = [
  "mf0_manifest.json",
  "mf0_memory_graph_for_db.json",
  "mf0_sqlite_rules_context_for_db.json",
  "mf0_access_external_services_for_db.json",
  "mf0_access_data_dump_enrichment_for_db.json",
  "mf0_ai_models_local_storage_for_restore.json",
  "mf0_env_dotenv_for_restore.txt",
];

const RULES_SUBDIR = "rules";
const RULES_KEEPER_FILES = [
  "core_rules.json",
  "private_rules.json",
  "forbidden_actions.json",
  "workflow_rules.json",
];

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
 * @param {{ cwd?: string }} opts
 */
function run7za(args, opts = {}) {
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
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(/** @type {string} */ (stderr));
      else reject(new Error(`7za failed (${code}): ${stderr.trim().slice(-1200)}`));
    });
  });
}

/**
 * @param {string} fp
 * @returns {unknown}
 */
function readJsonFile(fp) {
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

/**
 * @param {string} stderr
 */
function isWrong7zPassword(stderr) {
  const s = String(stderr ?? "").toLowerCase();
  return (
    s.includes("wrong password") ||
    s.includes("can not open the file as archive") ||
    s.includes("cannot open the file as archive") ||
    s.includes("data error in encrypted file")
  );
}

/**
 * @param {import("better-sqlite3").Database} database
 * @param {unknown[]} rows
 */
function replaceRulesContextTable(database, rows) {
  const tbl = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='rules'`)
    .get();
  if (!tbl) return;
  const arr = Array.isArray(rows) ? rows : [];
  const now = new Date().toISOString();
  database.prepare(`DELETE FROM rules`).run();
  const ins = database.prepare(
    `INSERT INTO rules (id, rule_type, title, content, priority, tags, is_active, created_at, updated_at)
     VALUES (@id, @ruleType, @title, @content, @priority, @tags, @isActive, @createdAt, @updatedAt)`,
  );
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (r);
    const id = String(o.id ?? "").trim();
    if (!id) continue;
    const ruleType = String(o.ruleType ?? o.rule_type ?? "").trim() || "context";
    const title = String(o.title ?? "").trim() || "(untitled)";
    const content = String(o.content ?? "").trim();
    const priority = String(o.priority ?? "").trim() || "0";
    const tags = o.tags != null ? String(o.tags) : null;
    const isActive = Number(o.isActive ?? o.is_active ?? 1) ? 1 : 0;
    const createdAt = String(o.createdAt ?? o.created_at ?? now).slice(0, 40) || now;
    const updatedAt = String(o.updatedAt ?? o.updated_at ?? now).slice(0, 40) || now;
    ins.run({
      id,
      ruleType,
      title,
      content,
      priority,
      tags,
      isActive,
      createdAt,
      updatedAt,
    });
  }
}

/**
 * @param {string} projectRoot
 * @param {string} extractDir
 */
function copyRulesKeeperFilesFromExtract(projectRoot, extractDir) {
  const destDir = path.join(projectRoot, RULES_SUBDIR);
  fs.mkdirSync(destDir, { recursive: true });
  const srcRules = path.join(extractDir, RULES_SUBDIR);
  for (const name of RULES_KEEPER_FILES) {
    const src = path.join(srcRules, name);
    const dest = path.join(destDir, name);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing rules file in archive: ${RULES_SUBDIR}/${name}`);
    }
    fs.copyFileSync(src, dest);
  }
}

/**
 * @param {string} projectRoot
 * @param {string} envText
 */
function writeEnvFileAtomic(projectRoot, envText) {
  const dest = path.join(projectRoot, ".env");
  const tmp = path.join(projectRoot, `.env.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, envText, "utf8");
  fs.renameSync(tmp, dest);
}

/**
 * @param {{
 *   projectRoot: string,
 *   database: import("better-sqlite3").Database,
 *   buffer: Buffer,
 *   archivePassphraseHex: string,
 *   normalizeCategory: (s: string) => string,
 *   normLabel: (s: string) => string,
 *   ensureMemoryGraphHubAnchorsPresent: () => void,
 * }} opts
 * @returns {Promise<{ summary: { memoryNodes: number, memoryEdges: number, accessRows: number, rulesRows: number }, aiModelsSnapshot: Record<string, string> }>}
 */
export async function importProjectProfileFromMfBuffer(opts) {
  const hex = String(opts.archivePassphraseHex ?? "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("INVALID_PASSPHRASE_ENCODING");
  }
  const buf = opts.buffer;
  if (!buf || buf.length < 64) {
    throw new Error("Archive body is too small.");
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mf0-profimp-"));
  const archivePath = path.join(tmpRoot, "bundle.mf");
  const extractDir = path.join(tmpRoot, "out");

  try {
    fs.writeFileSync(archivePath, buf);
    fs.mkdirSync(extractDir, { recursive: true });
    let stderr = "";
    try {
      stderr = await run7za(["x", `-p${hex}`, `-o${extractDir}`, "-y", archivePath], {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isWrong7zPassword(msg)) {
        const err = new Error("WRONG_ARCHIVE_PASSWORD");
        /** @type {Error & { code?: string }} */ (err).code = "WRONG_ARCHIVE_PASSWORD";
        throw err;
      }
      throw e;
    }
    if (isWrong7zPassword(stderr)) {
      const err = new Error("WRONG_ARCHIVE_PASSWORD");
      /** @type {Error & { code?: string }} */ (err).code = "WRONG_ARCHIVE_PASSWORD";
      throw err;
    }

    for (const rel of REQUIRED_ROOT_FILES) {
      const fp = path.join(extractDir, rel);
      if (!fs.existsSync(fp)) {
        throw new Error(`Archive is missing required file: ${rel}`);
      }
    }
    for (const name of RULES_KEEPER_FILES) {
      const fp = path.join(extractDir, RULES_SUBDIR, name);
      if (!fs.existsSync(fp)) {
        throw new Error(`Archive is missing required file: ${RULES_SUBDIR}/${name}`);
      }
    }

    const manifest = /** @type {Record<string, unknown>} */ (readJsonFile(path.join(extractDir, "mf0_manifest.json")));
    if (String(manifest.schema ?? "").trim() !== MANIFEST_SCHEMA) {
      throw new Error(`Invalid or unsupported manifest schema (expected ${MANIFEST_SCHEMA}).`);
    }

    const memoryRaw = readJsonFile(path.join(extractDir, "mf0_memory_graph_for_db.json"));
    const memoryPayload = normalizeImportPayload(memoryRaw, opts.normalizeCategory, opts.normLabel);

    const rulesCtx = /** @type {Record<string, unknown>} */ (
      readJsonFile(path.join(extractDir, "mf0_sqlite_rules_context_for_db.json"))
    );
    const rulesRows = Array.isArray(rulesCtx.rows) ? rulesCtx.rows : [];

    const accessRaw = /** @type {Record<string, unknown>} */ (
      readJsonFile(path.join(extractDir, "mf0_access_external_services_for_db.json"))
    );
    const accessEntries = Array.isArray(accessRaw.entries) ? accessRaw.entries : [];

    const enrichRaw = readJsonFile(path.join(extractDir, "mf0_access_data_dump_enrichment_for_db.json"));

    const aiRaw = /** @type {Record<string, unknown>} */ (
      readJsonFile(path.join(extractDir, "mf0_ai_models_local_storage_for_restore.json"))
    );
    const snap = aiRaw.snapshot && typeof aiRaw.snapshot === "object" ? aiRaw.snapshot : aiRaw;
    const keysObj = snap && typeof snap === "object" && snap.keys && typeof snap.keys === "object" ? snap.keys : {};
    /** @type {Record<string, string>} */
    const aiModelsSnapshot = {};
    for (const [k, v] of Object.entries(keysObj)) {
      if (typeof k === "string" && k.startsWith("mf0.settings.")) {
        aiModelsSnapshot[k] = String(v ?? "");
      }
    }

    const envText = fs.readFileSync(path.join(extractDir, "mf0_env_dotenv_for_restore.txt"), "utf8");

    const mem = replaceMemoryGraphInDatabase(
      opts.database,
      memoryPayload,
      opts.ensureMemoryGraphHubAnchorsPresent,
    );

    replaceRulesContextTable(opts.database, rulesRows);
    const rulesCountRow = opts.database.prepare(`SELECT COUNT(*) AS c FROM rules`).get();
    const accessRows = replaceAccessExternalServicesInDatabase(opts.database, accessEntries);

    copyRulesKeeperFilesFromExtract(opts.projectRoot, extractDir);
    writeEnvFileAtomic(opts.projectRoot, envText);
    writeAccessDataDumpEnrichmentImportFromArchivedPayload(opts.projectRoot, enrichRaw);

    return {
      summary: {
        memoryNodes: mem.nodesImported,
        memoryEdges: mem.edgesImported,
        accessRows,
        rulesRows: Number(rulesCountRow?.c) || 0,
      },
      aiModelsSnapshot,
    };
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
