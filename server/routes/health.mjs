import { Router } from "express";
import { resolveApiPort } from "../resolveApiPort.mjs";

const router = Router();
const PORT = resolveApiPort(process.env.API_PORT);

router.get("/health", (_req, res) => {
  res.json({ ok: true, mfLabApi: true, port: PORT });
});

export default router;
