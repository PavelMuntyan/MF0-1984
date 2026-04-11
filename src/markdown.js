import DOMPurify from "dompurify";
import { marked } from "marked";
import { preprocessMarkdownNumericFootnoteLinks } from "./footnoteCitations.js";

marked.setOptions({
  gfm: true,
  breaks: true,
});

const SANITIZE = {
  ALLOWED_TAGS: [
    "p",
    "br",
    "strong",
    "b",
    "em",
    "i",
    "del",
    "s",
    "ul",
    "ol",
    "li",
    "blockquote",
    "code",
    "pre",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "a",
    "hr",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "img",
  ],
  ALLOWED_ATTR: ["href", "title", "class", "src", "alt", "loading"],
};

/**
 * Markdown → безопасный HTML для ответа ассистента.
 * @param {string} source
 * @returns {string}
 */
export function renderAssistantMarkdown(source) {
  const s = String(source ?? "");
  if (!s.trim()) return "";
  const withFootnotes = preprocessMarkdownNumericFootnoteLinks(s);
  const raw = marked.parse(withFootnotes, { async: false });
  const clean = DOMPurify.sanitize(raw, SANITIZE);
  const wrap = document.createElement("div");
  wrap.innerHTML = clean;
  wrap.querySelectorAll("a[href]").forEach((a) => {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });
  return wrap.innerHTML;
}
