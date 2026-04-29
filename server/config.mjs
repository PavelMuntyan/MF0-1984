const raw = parseInt(String(process.env.API_MAX_BODY_BYTES ?? "").trim(), 10);
export const MAX_BODY_BYTES =
  Number.isFinite(raw) && raw >= 1024 * 1024 && raw <= 100 * 1024 * 1024
    ? raw
    : 48 * 1024 * 1024;
