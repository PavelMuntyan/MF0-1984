/**
 * Creates data/mf-lab.sqlite and applies db/schema.sql (sql.js — no native addon).
 * Run from project root: npm run db:init
 * Recreate: npm run db:init -- --force
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "db", "schema.sql");
const dataDir = path.join(root, "data");
const dbPath = path.join(dataDir, "mf-lab.sqlite");
const force = process.argv.includes("--force");

if (!fs.existsSync(schemaPath)) {
  console.error(`Schema not found: ${schemaPath}`);
  process.exit(1);
}

if (fs.existsSync(dbPath)) {
  if (!force) {
    console.error(
      `Database already exists: ${dbPath}\nDelete it or run: npm run db:init -- --force`,
    );
    process.exit(1);
  }
  fs.unlinkSync(dbPath);
}

fs.mkdirSync(dataDir, { recursive: true });

const schema = fs.readFileSync(schemaPath, "utf8");
const SQL = await initSqlJs();
const db = new SQL.Database();
db.exec(schema);
const binary = db.export();
fs.writeFileSync(dbPath, Buffer.from(binary));
db.close();

console.log(`SQLite database created: ${dbPath}`);
