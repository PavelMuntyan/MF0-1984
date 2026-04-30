import { Router } from "express";
import { extractAttachmentText } from "../attachmentTextExtract.mjs";
import { attachmentFilePath } from "../services/attachmentStorage.mjs";

const router = Router();

const SAFE_FILENAME_RE = /^[A-Za-z0-9_-]{8,64}\.[a-z0-9]{1,8}$/;

router.get("/files/attachments/:fileName", (req, res) => {
  const raw = String(req.params.fileName ?? "").trim();
  if (!SAFE_FILENAME_RE.test(raw)) {
    return res.status(400).json({ ok: false, error: "Invalid file name." });
  }
  const filePath = attachmentFilePath(raw);
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.sendFile(filePath, (err) => {
    if (!err) return;
    if (res.headersSent) return;
    const status = err.code === "ENOENT" ? 404 : (err.status ?? 500);
    res.status(status).json({ ok: false, error: "Attachment not found." });
  });
});

router.post("/attachments/extract", async (req, res) => {
  const body = req.body ?? {};
  const filename = String(body.filename ?? "").trim();
  const mimeType = String(body.mimeType ?? "").trim();
  const base64 = String(body.base64 ?? "").trim();
  if (!filename || !base64) {
    return res.status(400).json({ ok: false, error: "filename and base64 are required" });
  }
  try {
    const out = await extractAttachmentText({ filename, mimeType, base64 });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
