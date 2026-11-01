import { Router } from "express";
import { z } from "zod";
import { requireAdmin, requireUser } from "../auth.js";
import * as tasks from "../services/tasks.js";
import { pool } from "../db.js";

export const adminRouter = Router();

adminRouter.use(requireUser, requireAdmin);

adminRouter.get("/queue", async (req, res) => {
  res.json(await tasks.adminQueue(req.user!));
});

adminRouter.get("/safety-reports", async (req, res) => {
  res.json(await tasks.listSafetyReports(req.user!));
});

adminRouter.post("/safety-reports/:id/review", async (req, res) => {
  res.json(await tasks.markSafetyReviewed(req.user!, req.params.id as string));
});

adminRouter.post("/users/:id/verification", async (req, res) => {
  const { status } = z.object({ status: z.string() }).parse(req.body);
  res.json(await tasks.setVerification(req.user!, req.params.id as string, status));
});

adminRouter.post("/tasks/:id/resolve", async (req, res) => {
  res.json(await tasks.resolveTask(req.user!, req.params.id as string, req.body));
});

adminRouter.get("/reports", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.reason, r.created_at, m.id AS message_id, m.body, m.source_lang,
            s.display_name AS sender_name, rp.display_name AS reporter_name
       FROM message_reports r
       JOIN messages m ON m.id = r.message_id
       JOIN users s ON s.id = m.sender_id
       JOIN users rp ON rp.id = r.reporter_id
      WHERE r.status = 'open' ORDER BY r.created_at LIMIT 100`,
  );
  res.json({ reports: rows });
});

adminRouter.post("/reports/:id/review", async (req, res) => {
  await pool.query("UPDATE message_reports SET status = 'reviewed' WHERE id = $1", [req.params.id as string]);
  res.json({ ok: true });
});
