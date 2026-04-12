/**
 * Syntax highlighting for assistant markdown fenced blocks (`<pre><code>`).
 * Uses highlight.js “common” bundle (popular languages only).
 */
import hljs from "highlight.js/lib/common";

/**
 * Highlight every `pre > code` under `root` (fenced code only; inline `code` is excluded).
 * @param {ParentNode | null | undefined} root
 */
export function highlightAssistantMarkdownCodeBlocks(root) {
  if (!root) return;
  root.querySelectorAll("pre > code").forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    const text = node.textContent ?? "";
    if (!text.trim()) return;
    try {
      hljs.highlightElement(node);
    } catch {
      /* ignore: unknown grammar, empty fragment, etc. */
    }
  });
}
