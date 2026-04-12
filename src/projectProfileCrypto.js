/**
 * Project profile .mf / 7z passphrase: hex( SHA256( digest(SHA384, UTF-8(password)) ) ).
 * Same derivation must be used on import.
 */

/**
 * @param {string} password
 * @returns {boolean}
 */
export function isProjectProfilePasswordValid(password) {
  return getProjectProfilePasswordErrors(password).length === 0;
}

/**
 * @param {string} password
 * @returns {string[]} human-readable missing rules (English)
 */
export function getProjectProfilePasswordErrors(password) {
  const s = String(password ?? "");
  /** @type {string[]} */
  const e = [];
  if (s.length < 8) e.push("at least 8 characters");
  if (!/[A-Z]/.test(s)) e.push("one uppercase letter (A–Z)");
  if (!/[a-z]/.test(s)) e.push("one lowercase letter (a–z)");
  if (!/[0-9]/.test(s)) e.push("one digit");
  if (!/[^A-Za-z0-9]/.test(s)) e.push("one special character (not a letter or digit)");
  return e;
}

/**
 * @param {string} plainPassword
 * @returns {Promise<string>} 64 lowercase hex chars
 */
export async function deriveArchivePassphraseHex(plainPassword) {
  const enc = new TextEncoder();
  const d384 = await crypto.subtle.digest("SHA-384", enc.encode(plainPassword));
  const d256 = await crypto.subtle.digest("SHA-256", d384);
  return Array.from(new Uint8Array(d256), (b) => b.toString(16).padStart(2, "0")).join("");
}
