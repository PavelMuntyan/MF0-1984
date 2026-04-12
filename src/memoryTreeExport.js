import { fetchMemoryGraphFromApi } from "./chatPersistence.js";
import { gzipUint8Array, packUstarTarSingle } from "./tarGz.js";

/**
 * @returns {string} e.g. Memory_Tree_20260322_102419.tar.gz
 */
export function memoryTreeArchiveFilename() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `Memory_Tree_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.tar.gz`;
}

/**
 * Fetches the memory graph from the API, packs JSON + ustar + gzip, triggers download.
 * @param {AbortSignal} [signal] — when aborted (e.g. Settings closed), packing/download is skipped.
 * @returns {Promise<string>} downloaded file name
 */
export async function downloadMemoryTreeTarGz(signal) {
  if (typeof CompressionStream === "undefined") {
    throw new Error("This browser does not support CompressionStream (gzip).");
  }
  const graph = await fetchMemoryGraphFromApi({ signal });
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const payload = {
    schema: "mf0.memory_tree.v1",
    exportedAt: new Date().toISOString(),
    nodes: Array.isArray(graph?.nodes) ? graph.nodes : [],
    links: Array.isArray(graph?.links) ? graph.links : [],
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const te = new TextEncoder();
  const tar = packUstarTarSingle("memory_tree.json", te.encode(json));
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const gz = await gzipUint8Array(tar);
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const blob = new Blob([gz], { type: "application/gzip" });
  const name = memoryTreeArchiveFilename();
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
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
