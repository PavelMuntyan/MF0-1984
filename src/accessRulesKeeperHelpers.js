/** Align with server `ACCESS_ENTRY_NOTES_MAX` for Access store rows. */
export const ACCESS_ENTRY_NOTES_MAX = 12000;

/**
 * Merge Keeper 2 patches into the Access external-services list (key = normalized name).
 * @param {Array<{ id?: string, name?: string, description?: string, endpointUrl?: string, accessKey?: string, notes?: string, updatedAt?: string }>} existing
 * @param {Array<{ name?: string, description?: string, endpointUrl?: string, accessKey?: string, notes?: string }>} patch
 */
export function mergeAccessExternalServiceEntries(existing, patch) {
  const map = new Map();
  const keyOf = (n) => String(n ?? "").trim().toLowerCase();
  for (const e of existing) {
    const k = keyOf(e.name);
    if (k) map.set(k, { ...e, notes: String(e.notes ?? "").trim() });
  }
  const now = new Date().toISOString();
  for (const p of patch) {
    const name = String(p.name ?? "").trim().slice(0, 200);
    if (!name) continue;
    const k = keyOf(name);
    const prev = map.get(k) ?? {};
    const id = String(prev.id ?? "").trim() || crypto.randomUUID();
    const patchNotes = String(p.notes ?? "").trim();
    const notesOut = patchNotes
      ? patchNotes.slice(0, ACCESS_ENTRY_NOTES_MAX)
      : String(prev.notes ?? "").trim().slice(0, ACCESS_ENTRY_NOTES_MAX);
    map.set(k, {
      id,
      name,
      description: String(p.description ?? prev.description ?? "").trim().slice(0, 2000),
      endpointUrl: String(p.endpointUrl ?? prev.endpointUrl ?? "").trim().slice(0, 2000),
      accessKey: String(p.accessKey ?? prev.accessKey ?? "").trim().slice(0, 2000),
      notes: notesOut,
      updatedAt: now,
    });
  }
  return [...map.values()].slice(0, 200);
}

/**
 * Short text-only summary of saved Rules buckets for the extractor prompt.
 * @param {{
 *   core_rules: { text?: string }[],
 *   private_rules: { text?: string }[],
 *   forbidden_actions: { text?: string }[],
 *   workflow_rules: { text?: string }[],
 * }} bundle
 */
export function rulesKeeperExistingSummaryForExtract(bundle) {
  const slice = (arr, n) =>
    (Array.isArray(arr) ? arr : [])
      .slice(0, n)
      .map((x) => (x && typeof x === "object" ? String(x.text ?? "").trim() : String(x ?? "").trim()))
      .filter((s) => s.length > 0)
      .map((s) => s.slice(0, 120));
  return JSON.stringify({
    core_rules: slice(bundle.core_rules, 24),
    private_rules: slice(bundle.private_rules, 24),
    forbidden_actions: slice(bundle.forbidden_actions, 24),
    workflow_rules: slice(bundle.workflow_rules, 24),
  }).slice(0, 12000);
}

/**
 * @param {{
 *   core_rules: string[],
 *   private_rules: string[],
 *   forbidden_actions: string[],
 *   workflow_rules: string[],
 * }} a
 * @param {typeof a} b
 */
export function mergeRulesKeeperClientPatches(a, b) {
  return {
    core_rules: [...(a.core_rules ?? []), ...(b.core_rules ?? [])],
    private_rules: [...(a.private_rules ?? []), ...(b.private_rules ?? [])],
    forbidden_actions: [...(a.forbidden_actions ?? []), ...(b.forbidden_actions ?? [])],
    workflow_rules: [...(a.workflow_rules ?? []), ...(b.workflow_rules ?? [])],
  };
}
