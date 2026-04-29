import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cachePath = path.join(__dirname, "../..", "data", "ai-model-lists-cache.json");

const PROVIDERS = new Set(["openai", "perplexity", "gemini", "anthropic"]);
const ROLES = new Set(["dialogue", "images", "search", "research"]);

function sanitize(raw) {
  const out = { version: 1, updatedAt: "", lists: {} };
  const src = raw && typeof raw === "object" ? raw : {};
  out.updatedAt = String(src.updatedAt ?? "").trim().slice(0, 64);
  const lists = src.lists && typeof src.lists === "object" ? src.lists : {};
  for (const [provider, roles] of Object.entries(lists)) {
    if (!PROVIDERS.has(provider)) continue;
    const roleObj = roles && typeof roles === "object" ? roles : {};
    const clean = {};
    for (const [role, ids] of Object.entries(roleObj)) {
      if (!ROLES.has(role) || !Array.isArray(ids)) continue;
      const unique = [];
      const seen = new Set();
      for (const id of ids) {
        const v = String(id ?? "").trim().slice(0, 200);
        if (!v || seen.has(v)) continue;
        seen.add(v);
        unique.push(v);
        if (unique.length >= 500) break;
      }
      clean[role] = unique;
    }
    out.lists[provider] = clean;
  }
  return out;
}

export function readAiModelListsCachePayload() {
  if (!fs.existsSync(cachePath)) return { version: 1, updatedAt: "", lists: {} };
  try {
    return sanitize(JSON.parse(fs.readFileSync(cachePath, "utf8")));
  } catch {
    return { version: 1, updatedAt: "", lists: {} };
  }
}

export function writeAiModelListsCachePayload(body) {
  const base = sanitize(body?.cache);
  base.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(base, null, 2)}\n`, "utf8");
  return base;
}
