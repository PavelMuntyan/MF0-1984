import { deriveArchivePassphraseHex } from "./projectProfileCrypto.js";
import { exportProjectProfileMf } from "./chatPersistence.js";

/**
 * @returns {{ keys: Record<string, string> }}
 */
export function collectAiModelsLocalStorageSnapshot() {
  /** @type {Record<string, string>} */
  const keys = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith("mf0.settings.aiModel.") || k.startsWith("mf0.settings.chatModel.")) {
        keys[k] = localStorage.getItem(k) ?? "";
      }
    }
  } catch {
    /* ignore */
  }
  return { keys };
}

/**
 * @returns {string} e.g. Project_Profile_20260412_210530.mf
 */
export function projectProfileMfDownloadName() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `Project_Profile_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.mf`;
}

/**
 * @param {string} plainPassword
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} downloaded file name
 */
export async function runProjectProfileExportDownload(plainPassword, signal) {
  const hex = await deriveArchivePassphraseHex(plainPassword);
  const aiModelsSnapshot = collectAiModelsLocalStorageSnapshot();
  const blob = await exportProjectProfileMf(hex, aiModelsSnapshot, { signal });
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const name = projectProfileMfDownloadName();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  URL.revokeObjectURL(a.href);
  a.remove();
  return name;
}
