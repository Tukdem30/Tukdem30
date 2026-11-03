import express, { Router } from "express";
import type Stripe from "stripe";
import { HttpError } from "../errors.js";
import { verifyWebhook } from "../payments.js";
import { recordFundingFromWebhook, recordIdentityResult } from "../services/tasks.js";

export const stripeWebhookRouter = Router();

const FUNDING_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);

stripeWebhookRouter.post("/", express.raw({ type: "*/*" }), async (req, res) => {
  let event: Stripe.Event;
  try {
    event = verifyWebhook(req.body as Buffer, String(req.headers["stripe-signature"] ?? ""));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  if (FUNDING_EVENTS.has(event.type)) {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode === "payment" && session.payment_status === "paid" && session.metadata?.task_id) {
      // Errors here return 500, so Stripe retries the delivery later.
      await recordFundingFromWebhook(session.id);
    }
  }
  if (event.type === "identity.verification_session.verified" || event.type === "identity.verification_session.requires_input") {
    const check = event.data.object as Stripe.Identity.VerificationSession;
    const userId = check.metadata?.user_id;
    if (userId) {
      await recordIdentityResult(userId, event.type.endsWith("verified") ? "verified" : "pending");
    }
  }
  res.json({ received: true });
});
