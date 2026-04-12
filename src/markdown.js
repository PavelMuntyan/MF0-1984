import DOMPurify from "dompurify";
import { marked } from "marked";
import { preprocessMarkdownNumericFootnoteLinks } from "./footnoteCitations.js";

marked.setOptions({
  gfm: true,
  breaks: true,
});

const SVG_NS = "http://www.w3.org/2000/svg";

/** Small download glyph for the per-image control in assistant markdown. */
function createMsgMdDownloadIconSvg() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3");
  svg.appendChild(path);
  return svg;
}

/**
 * Wrap each markdown image so a download control can sit in the corner (see theme + main.js).
 * @param {HTMLDivElement} wrap
 */
function wrapAssistantMarkdownImagesForDownload(wrap) {
  wrap.querySelectorAll("img[src]").forEach((img) => {
    if (img.closest(".msg-md-inline-image-wrap")) return;
    const span = document.createElement("span");
    span.className = "msg-md-inline-image-wrap";
    const parent = img.parentNode;
    if (!parent) return;
    parent.insertBefore(span, img);
    span.appendChild(img);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "msg-md-image-download";
    btn.setAttribute("aria-label", "Download image");
    btn.appendChild(createMsgMdDownloadIconSvg());
    span.appendChild(btn);
  });
}

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
    "span",
  ],
  ALLOWED_ATTR: ["href", "title", "class", "src", "alt", "loading", "referrerpolicy", "decoding"],
};

/**
 * Markdown → sanitized HTML for assistant replies.
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
  /* OpenAI / other CDNs often 403 hotlinked images when Referer is the app origin (see index.html referrer). */
  wrap.querySelectorAll("img[src]").forEach((img) => {
    const src = String(img.getAttribute("src") ?? "").trim();
    if (/^https?:\/\//i.test(src)) {
      img.setAttribute("referrerpolicy", "no-referrer");
      if (!img.hasAttribute("loading")) img.setAttribute("loading", "lazy");
    }
  });
  wrapAssistantMarkdownImagesForDownload(wrap);
  return wrap.innerHTML;
}
