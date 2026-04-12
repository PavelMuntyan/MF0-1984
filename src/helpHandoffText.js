/** Full project HANDOFF (bundled at build time) — injected into every Help chat model request. */
import handoffRaw from "../HANDOFF.md?raw";

/**
 * Appended after HANDOFF in Help mode so models stay on product support only.
 */
export const HELP_CHAT_SCOPE_INSTRUCTION = `Help chat scope (mandatory):
- You are answering **only** questions about using this MF0-1984 application (UI, features, local setup, data flows described in the project handoff above).
- If the user asks about anything **not** related to help with this project (general knowledge, unrelated tasks, creative writing, politics, other products, etc.), reply briefly that this space is **only for MF0-1984 product help**, and they can continue that other topic in a **regular theme chat** — do **not** engage with the off-topic substance here.
- Do **not** claim that messages in this Help thread are saved into themes, Memory tree, Intro/Rules/Access stores, or user-interest pipelines; this thread is **ephemeral guidance** only.`;

export function getProjectHandoffDocumentForHelp() {
  return String(handoffRaw ?? "").trim();
}

export function buildHelpModeSystemInstruction() {
  const doc = getProjectHandoffDocumentForHelp();
  return [doc, HELP_CHAT_SCOPE_INSTRUCTION].filter(Boolean).join("\n\n");
}
