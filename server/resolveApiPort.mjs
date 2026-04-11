/** Default local API port (5984 is often CouchDB — avoid clash). */
export const DEFAULT_API_PORT = 35184;

/**
 * Parse `API_PORT` (or any string) into a TCP port. Invalid / empty → default.
 * @param {string | undefined} raw
 * @returns {number}
 */
export function resolveApiPort(raw) {
  if (raw === undefined || raw === null) return DEFAULT_API_PORT;
  const s = String(raw).trim();
  if (s === "") return DEFAULT_API_PORT;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return DEFAULT_API_PORT;
  return n;
}
