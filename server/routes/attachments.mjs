import { Router } from "express";
import { extractAttachmentText } from "../attachmentTextExtract.mjs";

const router = Router();

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
