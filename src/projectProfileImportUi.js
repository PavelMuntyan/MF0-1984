import { deriveArchivePassphraseHex } from "./projectProfileCrypto.js";
import { importProjectProfileMf } from "./chatPersistence.js";

/**
 * @param {Record<string, string> | undefined} snapshot
 */
export function applyAiModelsSnapshotToLocalStorage(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith("mf0.settings.aiModel.") || k.startsWith("mf0.settings.chatModel."))) {
        toRemove.push(k);
      }
    }
    for (const k of toRemove) {
      localStorage.removeItem(k);
    }
    for (const [k, v] of Object.entries(snapshot)) {
      if (typeof k === "string" && k.startsWith("mf0.settings.") && typeof v === "string") {
        localStorage.setItem(k, v);
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * @param {File} file
 * @param {string} plainPassword
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ summary: { memoryNodes: number, memoryEdges: number, accessRows: number, rulesRows: number } }>}
 */
export async function runProjectProfileImportFromFile(file, plainPassword, signal) {
  const buf = await file.arrayBuffer();
  const hex = await deriveArchivePassphraseHex(plainPassword);
  const data = await importProjectProfileMf(buf, hex, { signal });
  applyAiModelsSnapshotToLocalStorage(
    data.aiModelsSnapshot && typeof data.aiModelsSnapshot === "object" ? data.aiModelsSnapshot : undefined,
  );
  return { summary: data.summary ?? {} };
}
