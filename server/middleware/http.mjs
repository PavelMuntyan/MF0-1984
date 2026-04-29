export function normalizePathname(p) {
  const s = String(p || "/");
  const collapsed = s.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/")) return collapsed.slice(0, -1);
  return collapsed;
}

export function securityHeaders(_req, res, next) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
  });
  next();
}

export function notFound(_req, res) {
  res.status(404).json({ ok: false, error: "Not found" });
}

/** Express 5 error-handler (4-arg signature required). */
export function errorHandler(err, _req, res, _next) {
  if (err.type === "entity.too.large") {
    return res.status(413).json({ ok: false, error: err.message });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "Invalid JSON body" });
  }
  console.error(err);
  res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
