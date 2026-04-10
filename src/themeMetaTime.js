/**
 * Starter / Last action на карточке темы: YY-MM-DD HH:MM в локальной TZ браузера.
 * @param {string | null | undefined} value — ISO или строка из SQLite, как отдаёт API
 */
export function formatThemeMetaLocal(value) {
  if (value == null || value === "") return "";
  const d = new Date(String(value).trim());
  if (Number.isNaN(d.getTime())) return String(value);
  const yy = String(d.getFullYear()).slice(-2);
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yy}-${mo}-${day} ${h}:${min}`;
}
