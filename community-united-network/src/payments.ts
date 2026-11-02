import Stripe from "stripe";
import { HttpError } from "./errors.js";

/**
 * The only module that talks to Stripe. Test mode uses sk_test_ keys; live mode needs a
 * legal review first (see README). All amounts are integer cents in USD.
 */
export const CURRENCY = "usd";

let client: Stripe | null = null;

function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new HttpError(503, "Payments are not set up yet");
  client ??= new Stripe(key);
  return client;
}

// ---------- helper payout accounts (Stripe Express) ----------

/** Creates the helper's Express account if needed and returns a Stripe onboarding link. */
export async function startPayoutOnboarding(
  user: { id: string; email: string },
  existingAccountId: string | null,
  returnUrl: string,
): Promise<{ url: string; accountId: string }> {
  const s = stripe();
  let accountId = existingAccountId;
  if (!accountId) {
    const account = await s.accounts.create({
      type: "express",
      email: user.email,
      capabilities: { transfers: { requested: true } },
      metadata: { user_id: user.id },
    });
    accountId = account.id;
  }
  const link = await s.accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    refresh_url: returnUrl,
    return_url: returnUrl,
  });
  return { url: link.url, accountId };
}

/** True only when Stripe reports the helper can receive transfers. */
export async function payoutsReady(accountId: string | null): Promise<boolean> {
  if (!accountId) return false;
  const account = await stripe().accounts.retrieve(accountId);
  return account.capabilities?.transfers === "active";
}

/** Sends a helper's share of a task payment. The transfer draws on the requester's charge. */
export async function transferToHelper(args: {
  accountId: string;
  amountCents: number;
  chargeId: string;
  taskId: string;
  helperId: string;
  idempotencyKey: string;
}): Promise<void> {
  if (args.amountCents <= 0) return;
  await stripe().transfers.create(
    {
      amount: args.amountCents,
      currency: CURRENCY,
      destination: args.accountId,
      source_transaction: args.chargeId,
      transfer_group: `task_${args.taskId}`,
      metadata: { task_id: args.taskId, helper_id: args.helperId },
    },
    { idempotencyKey: args.idempotencyKey },
  );
}

/** Returns unused funds to the requester's card. */
export async function refundToRequester(args: {
  paymentIntentId: string;
  amountCents: number;
  taskId: string;
  idempotencyKey: string;
}): Promise<void> {
  if (args.amountCents <= 0) return;
  await stripe().refunds.create(
    {
      payment_intent: args.paymentIntentId,
      amount: args.amountCents,
      metadata: { task_id: args.taskId },
    },
    { idempotencyKey: args.idempotencyKey },
  );
}

// ---------- requester checkout ----------

export async function createFundingCheckout(args: {
  taskId: string;
  title: string;
  amountCents: number;
  requesterId: string;
  origin: string;
}): Promise<{ url: string }> {
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: args.amountCents,
          product_data: { name: `Task funding: ${args.title}`.slice(0, 250) },
        },
      },
    ],
    success_url: `${args.origin}/?funded_task=${args.taskId}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${args.origin}/?funding_cancelled=${args.taskId}`,
    metadata: { task_id: args.taskId, requester_id: args.requesterId },
    payment_intent_data: { metadata: { task_id: args.taskId } },
  });
  if (!session.url) throw new HttpError(502, "Stripe did not return a checkout link");
  return { url: session.url };
}

/** Confirms a paid checkout session and returns the ids needed to settle later. */
export async function paidCheckout(sessionId: string): Promise<{
  taskId: string;
  requesterId: string;
  amountCents: number;
  paymentIntentId: string;
  chargeId: string;
}> {
  const session = await stripe().checkout.sessions.retrieve(sessionId, {
    expand: ["payment_intent.latest_charge"],
  });
  if (session.payment_status !== "paid") throw new HttpError(402, "Payment is not complete yet");
  const pi = session.payment_intent as Stripe.PaymentIntent | null;
  if (!pi || typeof pi === "string") throw new HttpError(502, "Payment details are missing");
  const charge = pi.latest_charge;
  const chargeId = typeof charge === "string" ? charge : charge?.id;
  if (!chargeId) throw new HttpError(502, "Payment charge is missing");
  return {
    taskId: session.metadata?.task_id ?? "",
    requesterId: session.metadata?.requester_id ?? "",
    amountCents: session.amount_total ?? 0,
    paymentIntentId: pi.id,
    chargeId,
  };
}

/** Checks that a webhook really came from Stripe. Throws if the signature is wrong. */
export function verifyWebhook(rawBody: Buffer, signature: string): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, "Webhook is not configured");
  return stripe().webhooks.constructEvent(rawBody, signature, secret);
}
