import { Router } from "express";
import { z } from "zod";
import { requireAdmin, requireUser } from "../auth.js";
import * as tasks from "../services/tasks.js";

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
