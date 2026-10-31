import { Router } from "express";
import { requireUser, requireVerified } from "../auth.js";
import * as tasks from "../services/tasks.js";

export const taskRouter = Router();

taskRouter.get("/", async (req, res) => {
  res.json(await tasks.listOpenTasks(req.query));
});

taskRouter.post("/", requireUser, async (req, res) => {
  res.status(201).json(await tasks.createTask(req.user!, req.body));
});

taskRouter.get("/mine", requireUser, async (req, res) => {
  res.json(await tasks.listMyTasks(req.user!));
});

taskRouter.get("/:id", async (req, res) => {
  res.json(await tasks.getTaskForViewer(req.user, req.params.id as string));
});

taskRouter.get("/:id/history", requireUser, async (req, res) => {
  res.json(await tasks.getTaskHistory(req.user!, req.params.id as string));
});

taskRouter.get("/:id/candidates", requireUser, async (req, res) => {
  res.json(await tasks.rankCandidates(req.user!, req.params.id as string));
});

taskRouter.post("/:id/accept", requireUser, requireVerified, async (req, res) => {
  res.json(await tasks.acceptTask(req.user!, req.params.id as string));
});

taskRouter.post("/:id/withdraw", requireUser, async (req, res) => {
  res.json(await tasks.withdrawTask(req.user!, req.params.id as string));
});

taskRouter.post("/:id/start", requireUser, async (req, res) => {
  res.json(await tasks.startTask(req.user!, req.params.id as string));
});

taskRouter.post("/:id/finish", requireUser, async (req, res) => {
  res.json(await tasks.finishTask(req.user!, req.params.id as string, req.body));
});

taskRouter.post("/:id/confirm", requireUser, async (req, res) => {
  res.json(await tasks.confirmTask(req.user!, req.params.id as string));
});

taskRouter.post("/:id/dispute", requireUser, async (req, res) => {
  res.json(await tasks.disputeTask(req.user!, req.params.id as string));
});

taskRouter.post("/:id/cancel", requireUser, async (req, res) => {
  res.json(await tasks.cancelTask(req.user!, req.params.id as string, req.body));
});

taskRouter.post("/:id/safety-reports", requireUser, async (req, res) => {
  res.status(201).json(await tasks.reportSafety(req.user!, req.params.id as string, req.body));
});

taskRouter.post("/:id/changes", requireUser, async (req, res) => {
  res.status(201).json(await tasks.createChangeRequest(req.user!, req.params.id as string, req.body));
});

taskRouter.post("/changes/:changeId/approve", requireUser, async (req, res) => {
  res.json(await tasks.resolveChangeRequest(req.user!, req.params.changeId as string, true));
});

taskRouter.post("/changes/:changeId/decline", requireUser, async (req, res) => {
  res.json(await tasks.resolveChangeRequest(req.user!, req.params.changeId as string, false));
});

taskRouter.post("/:id/reviews", requireUser, async (req, res) => {
  res.status(201).json(await tasks.reviewTask(req.user!, req.params.id as string, req.body));
});
