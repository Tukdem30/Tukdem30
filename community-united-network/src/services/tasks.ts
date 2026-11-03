import type pg from "pg";
import { z } from "zod";
import type { AuthUser } from "../auth.js";
import { config } from "../config.js";
import { type Db, pool, withTx } from "../db.js";
import {
  assertAllowed,
  cancellationCompensationPct,
  isWithinDisputeWindow,
  OUTCOMES,
  platformFee,
  RESOLVE_OUTCOMES,
  splitPayout,
  type TaskStatus,
} from "../domain.js";
import { HttpError } from "../errors.js";
import { rankHelpers } from "../matching.js";
import { createFundingCheckout, paidCheckout, payoutsReady, refundToRequester, transferToHelper } from "../payments.js";
import { tagList, UUID_RE, zip } from "../validation.js";
import { CATEGORY_VALUES } from "../categories.js";

type Client = pg.PoolClient;

export interface TaskRow {
  id: string;
  requester_id: string;
  title: string;
  description: string;
  category: string;
  help_type: "paid" | "volunteer";
  required_skills: string[];
  tools_needed: string[];
  city: string;
  state: string;
  zip: string;
  address_private: string;
  schedule_type: string;
  scheduled_for: Date | null;
  schedule_note: string;
  helpers_needed: number;
  helper_count_unsure: boolean;
  supplies_provided: string;
  supplies_note: string;
  price_cents: number;
  status: TaskStatus;
  proposed_outcome: string | null;
  proposed_earned_cents: number | null;
  earned_cents: number;
  funded: boolean;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  completed_at: Date | null;
  created_at: Date;
}

interface Assignment {
  helper_id: string;
  arrived_at: Date | null;
}

const HELPER_COUNT = { one: 1, two: 2, three_plus: 3, unsure: 1 } as const;
const SCHEDULE_TYPES = [
  "asap",
  "today",
  "tomorrow",
  "this_week",
  "specific_date",
  "flexible",
  "recurring",
  "appointment",
] as const;
const SUPPLIES = ["requester", "helper", "either", "unsure"] as const;

// ---------- input schemas ----------

export const taskInputSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    description: z.string().trim().min(10).max(4000),
    category: z.enum(CATEGORY_VALUES),
    help_type: z.enum(["paid", "volunteer"]).default("paid"),
    required_skills: tagList.default([]),
    tools_needed: tagList.default([]),
    city: z.string().trim().min(2).max(80),
    state: z.string().trim().max(40).default(""),
    zip,
    address_private: z.string().trim().max(200).default(""),
    schedule_type: z.enum(SCHEDULE_TYPES),
    scheduled_for: z.iso.datetime().optional(),
    schedule_note: z.string().trim().max(300).default(""),
    helpers: z.enum(["one", "two", "three_plus", "unsure"]).default("one"),
    supplies_provided: z.enum(SUPPLIES).default("unsure"),
    supplies_note: z.string().trim().max(500).default(""),
    price_cents: z.number().int().min(0).max(1_000_000).default(0),
  })
  .superRefine((v, ctx) => {
    if (v.help_type === "paid" && v.price_cents < 100) {
      ctx.addIssue({ code: "custom", path: ["price_cents"], message: "Paid tasks need a price of at least $1.00" });
    }
    if (v.help_type === "volunteer" && v.price_cents !== 0) {
      ctx.addIssue({ code: "custom", path: ["price_cents"], message: "Volunteer tasks cannot have a price" });
    }
    if (["specific_date", "appointment"].includes(v.schedule_type) && !v.scheduled_for) {
      ctx.addIssue({ code: "custom", path: ["scheduled_for"], message: "Pick a date and time for this schedule" });
    }
  });

const changeSchemas = {
  price: z.object({ price_cents: z.number().int().min(100).max(1_000_000) }),
  helper_count: z.object({ helpers: z.enum(["one", "two", "three_plus"]) }),
  schedule: z.object({
    schedule_type: z.enum(SCHEDULE_TYPES),
    scheduled_for: z.iso.datetime().nullable().default(null),
    schedule_note: z.string().trim().max(300).default(""),
  }),
  location: z.object({
    city: z.string().trim().min(2).max(80),
    state: z.string().trim().max(40).default(""),
    zip,
    address_private: z.string().trim().max(200).default(""),
  }),
  supplies: z.object({
    supplies_provided: z.enum(SUPPLIES),
    supplies_note: z.string().trim().max(500).default(""),
  }),
  scope: z.object({ description: z.string().trim().min(10).max(4000) }),
} as const;

export type ChangeKind = keyof typeof changeSchemas;

const changeInputSchema = z.object({
  kind: z.enum(Object.keys(changeSchemas) as [ChangeKind, ...ChangeKind[]]),
  proposed: z.record(z.string(), z.unknown()),
  reason: z.string().trim().max(500).default(""),
});

const outcomeSchema = z.object({
  outcome: z.enum(OUTCOMES),
  // Amount earned per helper. Required for partial and pause outcomes.
  earned_cents: z.number().int().min(0).max(1_000_000).optional(),
});

const cancelSchema = z.object({
  exception: z.boolean().default(false),
  reason: z.string().trim().max(500).default(""),
});

const safetySchema = z.object({
  description: z.string().trim().min(5).max(4000),
  stop_task: z.boolean().default(false),
});

const resolveSchema = z.object({
  outcome: z.enum(RESOLVE_OUTCOMES),
  earned_cents: z.number().int().min(0).max(1_000_000).optional(),
  note: z.string().trim().max(500).default(""),
});

export const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).default(""),
  subject_id: z.string().regex(UUID_RE).optional(),
});

export const listSchema = z.object({
  zip: zip.optional(),
  city: z.string().trim().max(80).optional(),
  category: z.enum(CATEGORY_VALUES).optional(),
  help_type: z.enum(["paid", "volunteer"]).optional(),
  skill: z.string().trim().max(40).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---------- low-level helpers ----------

function assertUuid(id: string): void {
  if (!UUID_RE.test(id)) throw new HttpError(404, "Task not found");
}

async function lockTask(c: Client, id: string): Promise<TaskRow> {
  assertUuid(id);
  const { rows } = await c.query<TaskRow>("SELECT * FROM tasks WHERE id = $1 FOR UPDATE", [id]);
  if (!rows[0]) throw new HttpError(404, "Task not found");
  return rows[0];
}

async function activeAssignments(db: Db, taskId: string): Promise<Assignment[]> {
  const { rows } = await db.query<Assignment>(
    `SELECT helper_id, arrived_at FROM task_assignments
      WHERE task_id = $1 AND status = 'active' ORDER BY accepted_at`,
    [taskId],
  );
  return rows;
}

async function isActiveHelper(db: Db, taskId: string, userId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM task_assignments WHERE task_id = $1 AND helper_id = $2 AND status = 'active'`,
    [taskId, userId],
  );
  return (rowCount ?? 0) > 0;
}

/** Money held in escrow for a task: holds minus everything that has left escrow. */
async function heldCents(db: Db, taskId: string): Promise<number> {
  const { rows } = await db.query<{ held: string }>(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'hold' THEN amount_cents ELSE -amount_cents END), 0) AS held
       FROM payment_events WHERE task_id = $1`,
    [taskId],
  );
  return Number(rows[0].held);
}

async function addEvent(
  c: Client,
  taskId: string,
  kind: "hold" | "release_helper" | "platform_fee" | "refund",
  amount: number,
  helperId: string | null = null,
): Promise<void> {
  if (amount <= 0) return;
  await c.query(
    `INSERT INTO payment_events (task_id, helper_id, kind, amount_cents) VALUES ($1, $2, $3, $4)`,
    [taskId, helperId, kind, amount],
  );
}

/**
 * Pays each helper a gross amount. The fee stays with the platform; the helper's net goes to their
 * Stripe account. Refuses to overdraw what is held for the task.
 */
async function payOut(c: Client, t: TaskRow, payouts: { helperId: string; gross: number }[]): Promise<void> {
  const total = payouts.reduce((sum, p) => sum + p.gross, 0);
  if (total > (await heldCents(c, t.id))) {
    throw new HttpError(409, "Not enough funds are held for this payout");
  }
  const paying = payouts.filter((p) => p.gross > 0);
  if (paying.length === 0) return;
  if (!t.stripe_charge_id) throw new HttpError(409, "This task has no payment on file");

  const { rows } = await c.query<{ id: string; stripe_account_id: string | null }>(
    "SELECT id, stripe_account_id FROM users WHERE id = ANY($1)",
    [paying.map((p) => p.helperId)],
  );
  const accounts = new Map(rows.map((r) => [r.id, r.stripe_account_id]));

  for (const p of paying) {
    const { fee, net } = splitPayout(p.gross);
    const accountId = accounts.get(p.helperId);
    if (!accountId) throw new HttpError(409, "A helper has not set up a payout account");
    await transferToHelper({
      accountId,
      amountCents: net,
      chargeId: t.stripe_charge_id,
      taskId: t.id,
      helperId: p.helperId,
      idempotencyKey: `payout:${t.id}:${p.helperId}:${t.earned_cents}:${p.gross}`,
    });
    await addEvent(c, t.id, "release_helper", net, p.helperId);
    await addEvent(c, t.id, "platform_fee", fee, p.helperId);
  }
}

/** Returns whatever is still held to the requester's card. */
async function refundRemainder(c: Client, t: TaskRow): Promise<number> {
  const held = await heldCents(c, t.id);
  if (held > 0) {
    if (!t.stripe_payment_intent_id) throw new HttpError(409, "This task has no payment on file to refund");
    await refundToRequester({
      paymentIntentId: t.stripe_payment_intent_id,
      amountCents: held,
      taskId: t.id,
      idempotencyKey: `refund:${t.id}:${held}:${t.earned_cents}`,
    });
  }
  await addEvent(c, t.id, "refund", held);
  return held;
}

async function recordAgreement(c: Client, t: TaskRow, reason: string): Promise<void> {
  const snapshot = {
    title: t.title,
    description: t.description,
    category: t.category,
    help_type: t.help_type,
    required_skills: t.required_skills,
    tools_needed: t.tools_needed,
    city: t.city,
    state: t.state,
    zip: t.zip,
    schedule_type: t.schedule_type,
    scheduled_for: t.scheduled_for,
    schedule_note: t.schedule_note,
    helpers_needed: t.helpers_needed,
    supplies_provided: t.supplies_provided,
    supplies_note: t.supplies_note,
    price_cents: t.price_cents,
  };
  await c.query(
    `INSERT INTO agreement_history (task_id, version, snapshot, reason)
     VALUES ($1, (SELECT COALESCE(MAX(version), 0) + 1 FROM agreement_history WHERE task_id = $1), $2, $3)`,
    [t.id, JSON.stringify(snapshot), reason],
  );
}

/** Public view of a task. Address is included only for the requester, assigned helpers, and admins. */
function publicTask(t: TaskRow): Record<string, unknown> {
  const { address_private: _addr, stripe_payment_intent_id: _pi, stripe_charge_id: _ch, ...rest } = t;
  const fee = t.help_type === "paid" ? platformFee(t.price_cents) : 0;
  return { ...rest, helper_net_cents: t.price_cents - fee, platform_fee_cents: fee };
}

// ---------- reads ----------

export async function listOpenTasks(query: unknown) {
  const q = listSchema.parse(query);
  const where: string[] = ["t.status = 'open'", "(t.help_type = 'volunteer' OR t.funded = true)"];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (q.zip) add("t.zip = ?", q.zip);
  if (q.city) add("LOWER(t.city) = LOWER(?)", q.city);
  if (q.category) add("LOWER(t.category) = LOWER(?)", q.category);
  if (q.help_type) add("t.help_type = ?", q.help_type);
  if (q.skill) add("? = ANY(t.required_skills)", q.skill.toLowerCase());
  if (q.q) add("(t.title ILIKE '%' || ? || '%' OR t.description ILIKE '%' || ? || '%')", q.q);
  params.push(q.limit, q.offset);
  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.category, t.help_type, t.city, t.state, t.zip, t.schedule_type,
            t.scheduled_for, t.helpers_needed, t.price_cents, t.required_skills, t.tools_needed,
            t.created_at, u.display_name AS requester_name
       FROM tasks t JOIN users u ON u.id = t.requester_id
      WHERE ${where.join(" AND ")}
      ORDER BY t.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { tasks: rows };
}

/** Tasks the signed-in person requested or is helping on. */
export async function listMyTasks(user: AuthUser) {
  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.status, t.help_type, t.price_cents, t.city, t.zip, t.scheduled_for,
            t.created_at, (t.requester_id = $1) AS is_requester
       FROM tasks t
      WHERE t.requester_id = $1
         OR t.id IN (SELECT task_id FROM task_assignments WHERE helper_id = $1)
      ORDER BY t.created_at DESC LIMIT 100`,
    [user.id],
  );
  return { tasks: rows };
}

export async function getTaskForViewer(user: AuthUser | undefined, id: string) {
  assertUuid(id);
  const { rows } = await pool.query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [id]);
  const t = rows[0];
  if (!t) throw new HttpError(404, "Task not found");

  const isRequester = user?.id === t.requester_id;
  const isAdmin = Boolean(user?.is_admin);
  const assigned = user ? await isActiveHelper(pool, id, user.id) : false;
  const isParty = isRequester || assigned || isAdmin;

  if (!isParty && t.status !== "open") throw new HttpError(404, "Task not found");
  if (!isRequester && !isAdmin && user?.verification_status !== "verified") {
    throw new HttpError(403, "Verify your identity to view tasks");
  }
  if (!isParty && t.help_type === "paid" && !t.funded) throw new HttpError(404, "Task not found");

  const { rows: assignRows } = await pool.query(
    `SELECT a.helper_id, a.status, a.arrived_at, u.display_name
       FROM task_assignments a JOIN users u ON u.id = a.helper_id
      WHERE a.task_id = $1 ORDER BY a.accepted_at`,
    [id],
  );
  const activeCount = assignRows.filter((a) => a.status === "active").length;

  const view: Record<string, unknown> = {
    ...publicTask(t),
    active_helpers: activeCount,
    open_slots: Math.max(0, t.helpers_needed - activeCount),
    viewer_role: isRequester ? "requester" : assigned ? "helper" : isAdmin ? "admin" : "visitor",
  };
  if (isParty) view.address_private = t.address_private;
  if (isRequester || isAdmin) {
    view.held_cents = await heldCents(pool, id);
    view.assignments = assignRows;
  } else if (assigned) {
    view.assignments = assignRows.map((a) => ({ status: a.status, display_name: a.display_name }));
  } else {
    view.assignments = undefined;
  }

  if (isParty) {
    const { rows: changes } = await pool.query(
      `SELECT id, kind, proposed, reason, status, requested_by, created_at
         FROM change_requests WHERE task_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [id],
    );
    view.change_requests = changes;
  }

  return view;
}

export async function getTaskHistory(user: AuthUser, id: string) {
  assertUuid(id);
  const { rows: t } = await pool.query<{ requester_id: string }>("SELECT requester_id FROM tasks WHERE id = $1", [id]);
  if (!t[0]) throw new HttpError(404, "Task not found");
  const allowed = t[0].requester_id === user.id || user.is_admin || (await isActiveHelper(pool, id, user.id));
  if (!allowed) throw new HttpError(403, "Only people on this task can view its history");
  const { rows } = await pool.query(
    `SELECT version, snapshot, reason, created_at FROM agreement_history WHERE task_id = $1 ORDER BY version`,
    [id],
  );
  return { history: rows };
}

/** Requester-only: every eligible helper, ranked. Nothing is filtered out except the requester. */
export async function rankCandidates(user: AuthUser, id: string) {
  assertUuid(id);
  const { rows: tr } = await pool.query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [id]);
  const t = tr[0];
  if (!t) throw new HttpError(404, "Task not found");
  if (t.requester_id !== user.id) throw new HttpError(403, "Only the requester can see candidates");

  const { rows: users } = await pool.query(
    `SELECT id, display_name, role_mode, city, zip, skills, tools, verification_status
       FROM users
      WHERE role_mode IN ('can_help', 'both') AND id <> $1
        AND verification_status <> 'rejected'
      ORDER BY created_at DESC LIMIT 300`,
    [user.id],
  );
  const ranked = rankHelpers(
    {
      requesterId: t.requester_id,
      zip: t.zip,
      city: t.city,
      requiredSkills: t.required_skills,
      toolsNeeded: t.tools_needed,
    },
    users.map((u) => ({
      id: u.id,
      roleMode: u.role_mode,
      verified: u.verification_status === "verified",
      zip: u.zip,
      city: u.city,
      skills: u.skills,
      tools: u.tools,
    })),
  );
  const byId = new Map(users.map((u) => [u.id, u]));
  return {
    candidates: ranked.map((r) => {
      const u = byId.get(r.helper.id)!;
      return {
        id: u.id,
        display_name: u.display_name,
        city: u.city,
        zip: u.zip,
        skills: u.skills,
        tools: u.tools,
        verified: r.helper.verified,
        score: r.score,
        reasons: r.reasons,
      };
    }),
  };
}

// ---------- writes ----------

export async function createTask(user: AuthUser, raw: unknown) {
  const v = taskInputSchema.parse(raw);
  const helpersNeeded = HELPER_COUNT[v.helpers];
  const scheduled = v.scheduled_for ? new Date(v.scheduled_for) : null;
  if (scheduled && scheduled.getTime() < Date.now() - 60_000) {
    throw new HttpError(400, "Scheduled time is in the past");
  }
  return withTx(async (c) => {
    const { rows } = await c.query<TaskRow>(
      `INSERT INTO tasks (requester_id, title, description, category, help_type, required_skills,
         tools_needed, city, state, zip, address_private, schedule_type, scheduled_for, schedule_note,
         helpers_needed, helper_count_unsure, supplies_provided, supplies_note, price_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        user.id,
        v.title,
        v.description,
        v.category,
        v.help_type,
        v.required_skills,
        v.tools_needed,
        v.city,
        v.state,
        v.zip,
        v.address_private,
        v.schedule_type,
        scheduled,
        v.schedule_note,
        helpersNeeded,
        v.helpers === "unsure",
        v.supplies_provided,
        v.supplies_note,
        v.price_cents,
      ],
    );
    const t = rows[0];
    // Paid tasks stay unfunded until the requester pays through Stripe Checkout.
    if (t.help_type === "volunteer") {
      await c.query("UPDATE tasks SET funded = true WHERE id = $1", [t.id]);
      t.funded = true;
    }
    await recordAgreement(c, t, "Original terms");
    return publicTask(t);
  });
}

export async function acceptTask(user: AuthUser, id: string) {
  return withTx(async (c) => {
    const t = await lockTask(c, id);
    if (t.requester_id === user.id) throw new HttpError(403, "You cannot accept your own task");
    assertAllowed("accept", t.status);

    const { rows: me } = await c.query<{ role_mode: string; stripe_account_id: string | null }>(
      "SELECT role_mode, stripe_account_id FROM users WHERE id = $1",
      [user.id],
    );
    if (me[0].role_mode === "need_help") {
      throw new HttpError(403, "Your profile is set to need help only. Change it to accept tasks.");
    }
    if (t.help_type === "paid") {
      if (!t.funded) throw new HttpError(409, "The requester has not paid for this task yet");
      if (!(await payoutsReady(me[0].stripe_account_id))) {
        throw new HttpError(403, "Set up your payout account in your profile before accepting paid tasks");
      }
    }

    const active = await activeAssignments(c, id);
    if (active.some((a) => a.helper_id === user.id)) throw new HttpError(409, "You are already on this task");
    if (active.length >= t.helpers_needed) throw new HttpError(409, "This task already has enough helpers");

    await c.query(
      `INSERT INTO task_assignments (task_id, helper_id) VALUES ($1, $2)
       ON CONFLICT (task_id, helper_id)
       DO UPDATE SET status = 'active', accepted_at = now(), arrived_at = NULL, ended_at = NULL`,
      [id, user.id],
    );
    const filled = active.length + 1 >= t.helpers_needed;
    const nextStatus: TaskStatus = filled ? "accepted" : t.status;
    await c.query("UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1", [id, nextStatus]);
    return { status: nextStatus, open_slots: Math.max(0, t.helpers_needed - (active.length + 1)) };
  });
}

export async function withdrawTask(user: AuthUser, id: string) {
  return withTx(async (c) => {
    const t = await lockTask(c, id);
    assertAllowed("withdraw", t.status);
    const { rowCount } = await c.query(
      `UPDATE task_assignments SET status = 'withdrawn', ended_at = now()
        WHERE task_id = $1 AND helper_id = $2 AND status = 'active'`,
      [id, user.id],
    );
    if (!rowCount) throw new HttpError(403, "You are not an active helper on this task");

    // Withdrawing forfeits pay for the withdrawing helper. The requester's escrow for that slot stays held
    // until a replacement is found or the task ends.
    const remaining = (await activeAssignments(c, id)).length;
    let nextStatus: TaskStatus = t.status;
    if (remaining < t.helpers_needed) {
      const started = t.status === "in_progress" || t.status === "continue_later";
      nextStatus = started ? "continue_later" : "open";
    }
    await c.query("UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1", [id, nextStatus]);
    return { status: nextStatus };
  });
}

export async function startTask(user: AuthUser, id: string) {
  return withTx(async (c) => {
    const t = await lockTask(c, id);
    assertAllowed("start", t.status);
    // Only an assigned helper can mark arrival; this is what starts the work.
    const { rowCount } = await c.query(
      `UPDATE task_assignments SET arrived_at = now()
        WHERE task_id = $1 AND helper_id = $2 AND status = 'active'`,
      [id, user.id],
    );
    if (!rowCount) throw new HttpError(403, "Only an assigned helper can start this task");
    await c.query("UPDATE tasks SET status = 'in_progress', updated_at = now() WHERE id = $1", [id]);
    return { status: "in_progress" };
  });
}

/**
 * Either party proposes how the task ended. Money moves only after the requester confirms.
 * earned_cents is the amount earned per helper (cumulative across continue-later sessions).
 */
export async function finishTask(user: AuthUser, id: string, raw: unknown) {
  const input = outcomeSchema.parse(raw);
  return withTx(async (c) => {
    const t = await lockTask(c, id);
    const isRequester = t.requester_id === user.id;
    if (!isRequester && !(await isActiveHelper(c, id, user.id))) {
      throw new HttpError(403, "Only people on this task can finish it");
    }
    assertAllowed("finish", t.status);

    const rate = t.price_cents;
    let earned: number;
    if (input.outcome === "completed") {
      earned = rate;
    } else {
      earned = input.earned_cents ?? 0;
      if (input.outcome === "partially_completed" && (earned <= 0 || earned >= rate)) {
        throw new HttpError(400, "Partial completion needs an amount above $0 and below the full rate");
      }
      if (earned > rate) throw new HttpError(400, "Earned amount cannot exceed the agreed rate");
    }
    if (earned < t.earned_cents) {
      throw new HttpError(400, "Earned amount cannot be less than what has already been paid");
    }

    await c.query(
      `UPDATE tasks SET status = 'awaiting_confirmation', proposed_outcome = $2,
              proposed_earned_cents = $3, updated_at = now() WHERE id = $1`,
      [id, input.outcome, earned],
    );
    return { status: "awaiting_confirmation", proposed_outcome: input.outcome, proposed_earned_cents: earned };
  });
}

/** Requester confirms the proposed outcome, which releases money according to the agreement. */
export async function confirmTask(user: AuthUser, id: string) {
  return withTx(async (c) => {
    const t = await lockTask(c, id);
    if (t.requester_id !== user.id) throw new HttpError(403, "Only the requester can confirm");
    assertAllowed("confirm", t.status);
    const outcome = t.proposed_outcome as "completed" | "partially_completed" | "continue_later";
    const target = t.proposed_earned_cents ?? 0;
    await settle(c, t, outcome, target);
    return { status: outcome };
  });
}

/** Moves money for the given outcome. continue_later pays what is earned and keeps the rest held. */
async function settle(
  c: Client,
  t: TaskRow,
  outcome: "completed" | "partially_completed" | "continue_later" | "cancelled",
  perHelperTarget: number,
): Promise<void> {
  const actives = await activeAssignments(c, t.id);
  const gross = Math.max(0, perHelperTarget - t.earned_cents);
  await payOut(
    c,
    t,
    actives.map((a) => ({ helperId: a.helper_id, gross })),
  );

  if (outcome === "continue_later") {
    await c.query(
      `UPDATE tasks SET status = 'continue_later', earned_cents = $2,
              proposed_outcome = NULL, proposed_earned_cents = NULL, updated_at = now() WHERE id = $1`,
      [t.id, perHelperTarget],
    );
    return;
  }

  await refundRemainder(c, t);
  await c.query(
    `UPDATE task_assignments SET status = $2, ended_at = now() WHERE task_id = $1 AND status = 'active'`,
    [t.id, outcome === "cancelled" ? "cancelled" : "completed"],
  );
  await c.query(
    `UPDATE tasks SET status = $2, earned_cents = $3, completed_at = $4,
            proposed_outcome = NULL, proposed_earned_cents = NULL, updated_at = now() WHERE id = $1`,
    [t.id, outcome, outcome === "cancelled" ? t.earned_cents : perHelperTarget, outcome === "cancelled" ? null : new Date()],
  );
}

export async function disputeTask(user: AuthUser, id: string) {
  return withTx(async (c) => {
    const t = await lockTask(c, id);
    const { rows: history } = await c.query(
      "SELECT 1 FROM task_assignments WHERE task_id = $1 AND helper_id = $2",
      [id, user.id],
    );
    const isParty = t.requester_id === user.id || history.length > 0 || user.is_admin;
    if (!isParty) throw new HttpError(403, "Only people on this task can raise a dispute");
    assertAllowed("dispute", t.status);
    if (t.status !== "awaiting_confirmation" && !(t.completed_at && isWithinDisputeWindow(t.completed_at))) {
      throw new HttpError(409, `Disputes must be raised within ${config.disputeWindowDays} days of completion`);
    }
    await c.query("UPDATE tasks SET status = 'disputed', updated_at = now() WHERE id = $1", [id]);
    return { status: "disputed" };
  });
}

export async function cancelTask(user: AuthUser, id: string, raw: unknown) {
  const input = cancelSchema.parse(raw ?? {});
  return withTx(async (c) => {
    const t = await lockTask(c, id);
    if (t.requester_id !== user.id) throw new HttpError(403, "Only the requester can cancel");
    assertAllowed("cancel", t.status);

    const actives = await activeAssignments(c, id);
    const hoursNotice = t.scheduled_for ? (t.scheduled_for.getTime() - Date.now()) / 3_600_000 : null;
    const payouts = actives.map((a) => {
      const pct = cancellationCompensationPct({
        helperArrived: t.status === "in_progress" && a.arrived_at !== null,
        hoursNotice,
        exception: input.exception,
      });
      return { helperId: a.helper_id, gross: Math.max(0, Math.round(t.price_cents * pct) - t.earned_cents) };
    });

    await payOut(c, t, payouts);
    const refunded = await refundRemainder(c, t);
    await c.query(
      `UPDATE task_assignments SET status = 'cancelled', ended_at = now() WHERE task_id = $1 AND status = 'active'`,
      [id],
    );
    await c.query(
      `UPDATE tasks SET status = 'cancelled', updated_at = now() WHERE id = $1`,
      [id],
    );
    return {
      status: "cancelled",
      compensation_cents: payouts.reduce((s, p) => s + p.gross, 0),
      refunded_cents: refunded,
    };
  });
}

export async function reportSafety(user: AuthUser, id: string, raw: unknown) {
  const input = safetySchema.parse(raw);
  return withTx(async (c) => {
    const t = await lockTask(c, id);
    if (t.requester_id !== user.id && !(await isActiveHelper(c, id, user.id))) {
      throw new HttpError(403, "Only people on this task can report a safety concern");
    }
    await c.query(
      `INSERT INTO safety_reports (task_id, reporter_id, description, stopped_task) VALUES ($1, $2, $3, $4)`,
      [id, user.id, input.description, input.stop_task],
    );
    if (input.stop_task) {
      assertAllowed("report_safety", t.status);
      await c.query("UPDATE tasks SET status = 'paused_safety', updated_at = now() WHERE id = $1", [id]);
      return { status: "paused_safety" };
    }
    return { status: t.status };
  });
}

// ---------- change requests ----------

const CHANGEABLE = ["open", "accepted", "in_progress", "continue_later"] as const;

export async function createChangeRequest(user: AuthUser, id: string, raw: unknown) {
  const input = changeInputSchema.parse(raw);
  const proposed = changeSchemas[input.kind].parse(input.proposed);
  return withTx(async (c) => {
    const t = await lockTask(c, id);
    const isRequester = t.requester_id === user.id;
    if (!isRequester && !(await isActiveHelper(c, id, user.id))) {
      throw new HttpError(403, "Only people on this task can request a change");
    }
    if (!(CHANGEABLE as readonly string[]).includes(t.status)) {
      throw new HttpError(409, `Changes cannot be requested while the task is ${t.status}`);
    }
    if ((input.kind === "price" || input.kind === "helper_count") && t.earned_cents > 0) {
      throw new HttpError(409, "Price and helper changes are closed once payment has been earned");
    }
    if (input.kind === "price" && t.help_type === "volunteer") {
      throw new HttpError(400, "Volunteer tasks have no price");
    }
    const { rows } = await c.query(
      `INSERT INTO change_requests (task_id, requested_by, kind, proposed, reason)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, kind, status, created_at`,
      [id, user.id, input.kind, JSON.stringify(proposed), input.reason],
    );
    return rows[0];
  });
}

export async function resolveChangeRequest(user: AuthUser, changeId: string, approve: boolean) {
  if (!UUID_RE.test(changeId)) throw new HttpError(404, "Change request not found");
  return withTx(async (c) => {
    const { rows: crRows } = await c.query<{ task_id: string; requested_by: string; kind: ChangeKind; proposed: unknown; status: string }>(
      "SELECT task_id, requested_by, kind, proposed, status FROM change_requests WHERE id = $1",
      [changeId],
    );
    const cr = crRows[0];
    if (!cr) throw new HttpError(404, "Change request not found");
    const t = await lockTask(c, cr.task_id);
    if (cr.status !== "pending") throw new HttpError(409, "This change request is already resolved");
    if (cr.requested_by === user.id) throw new HttpError(403, "You cannot approve your own change request");

    // The other side must approve: helpers approve requester changes, and the requester approves helper changes.
    const requesterAsked = cr.requested_by === t.requester_id;
    const approverIsOtherSide = requesterAsked
      ? await isActiveHelper(c, t.id, user.id)
      : user.id === t.requester_id;
    if (!approverIsOtherSide) throw new HttpError(403, "The other party on this task must approve this change");

    if (!approve) {
      await c.query(
        "UPDATE change_requests SET status = 'declined', resolved_at = now() WHERE id = $1",
        [changeId],
      );
      return { status: "declined" };
    }

    if (t.funded && (cr.kind === "price" || cr.kind === "helper_count")) {
      throw new HttpError(409, "This task is already paid. Price and helper changes need a new payment; cancel and repost instead.");
    }
    const p = cr.proposed as Record<string, unknown>;
    switch (cr.kind) {
      case "price":
        await c.query("UPDATE tasks SET price_cents = $2 WHERE id = $1", [t.id, p.price_cents]);
        break;
      case "helper_count": {
        const needed = HELPER_COUNT[p.helpers as keyof typeof HELPER_COUNT];
        const active = (await activeAssignments(c, t.id)).length;
        if (needed < active) throw new HttpError(409, "More helpers are already assigned than the new count");
        await c.query(
          "UPDATE tasks SET helpers_needed = $2, helper_count_unsure = false WHERE id = $1",
          [t.id, needed],
        );
        break;
      }
      case "schedule":
        await c.query(
          `UPDATE tasks SET schedule_type = $2, scheduled_for = $3, schedule_note = $4 WHERE id = $1`,
          [t.id, p.schedule_type, p.scheduled_for, p.schedule_note],
        );
        break;
      case "location":
        await c.query(
          `UPDATE tasks SET city = $2, state = $3, zip = $4, address_private = $5 WHERE id = $1`,
          [t.id, p.city, p.state, p.zip, p.address_private],
        );
        break;
      case "supplies":
        await c.query(
          "UPDATE tasks SET supplies_provided = $2, supplies_note = $3 WHERE id = $1",
          [t.id, p.supplies_provided, p.supplies_note],
        );
        break;
      case "scope":
        await c.query("UPDATE tasks SET description = $2 WHERE id = $1", [t.id, p.description]);
        break;
    }

    if (cr.kind === "price" || cr.kind === "helper_count") {
      // Keep open/accepted in sync with whether the slot count is now filled.
      const active = (await activeAssignments(c, t.id)).length;
      const { rows: fresh } = await c.query<{ helpers_needed: number; status: TaskStatus }>(
        "SELECT helpers_needed, status FROM tasks WHERE id = $1",
        [t.id],
      );
      const { helpers_needed, status } = fresh[0];
      if (status === "open" && active >= helpers_needed && helpers_needed > 0) {
        await c.query("UPDATE tasks SET status = 'accepted' WHERE id = $1", [t.id]);
      } else if (status === "accepted" && active < helpers_needed) {
        await c.query("UPDATE tasks SET status = 'open' WHERE id = $1", [t.id]);
      }
    }

    await c.query(
      "UPDATE change_requests SET status = 'approved', resolved_at = now() WHERE id = $1",
      [changeId],
    );
    const { rows: updated } = await c.query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [t.id]);
    await recordAgreement(c, updated[0], `Approved change: ${cr.kind}`);
    return { status: "approved" };
  });
}

// ---------- reviews ----------

export async function reviewTask(user: AuthUser, id: string, raw: unknown) {
  const input = reviewSchema.parse(raw);
  return withTx(async (c) => {
    const t = await lockTask(c, id);
    if (t.status !== "completed" && t.status !== "partially_completed") {
      throw new HttpError(409, "Reviews open after a task is completed");
    }
    let subject: string;
    if (t.requester_id === user.id) {
      if (!input.subject_id) throw new HttpError(400, "Choose which helper to review");
      const { rowCount } = await c.query(
        "SELECT 1 FROM task_assignments WHERE task_id = $1 AND helper_id = $2 AND status = 'completed'",
        [id, input.subject_id],
      );
      if (!rowCount) throw new HttpError(400, "That person did not help on this task");
      subject = input.subject_id;
    } else {
      const { rowCount } = await c.query(
        "SELECT 1 FROM task_assignments WHERE task_id = $1 AND helper_id = $2 AND status = 'completed'",
        [id, user.id],
      );
      if (!rowCount) throw new HttpError(403, "Only people who worked on this task can review it");
      subject = t.requester_id;
    }
    await c.query(
      `INSERT INTO reviews (task_id, reviewer_id, subject_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (task_id, reviewer_id, subject_id) DO NOTHING`,
      [id, user.id, subject, input.rating, input.comment],
    );
    return { ok: true };
  });
}

// ---------- admin ----------

export async function resolveTask(admin: AuthUser, id: string, raw: unknown) {
  if (!admin.is_admin) throw new HttpError(403, "Admins only");
  const input = resolveSchema.parse(raw);
  return withTx(async (c) => {
    const t = await lockTask(c, id);
    assertAllowed("resolve", t.status);

    if (input.outcome === "in_progress") {
      await c.query("UPDATE tasks SET status = 'in_progress', updated_at = now() WHERE id = $1", [id]);
      return { status: "in_progress" };
    }
    if (input.outcome === "cancelled") {
      const target = input.earned_cents ?? 0;
      await settle(c, t, "cancelled", target);
      return { status: "cancelled" };
    }
    const target = input.outcome === "completed" ? t.price_cents : (input.earned_cents ?? 0);
    if (target > t.price_cents) throw new HttpError(400, "Amount cannot exceed the agreed rate");
    if (target < t.earned_cents) throw new HttpError(400, "Amount cannot be less than what has already been paid");
    await settle(c, t, input.outcome, target);
    return { status: input.outcome };
  });
}

export async function setVerification(admin: AuthUser, userId: string, status: string) {
  if (!admin.is_admin) throw new HttpError(403, "Admins only");
  if (!UUID_RE.test(userId)) throw new HttpError(404, "User not found");
  if (!["pending", "verified", "rejected", "unverified"].includes(status)) {
    throw new HttpError(400, "Invalid verification status");
  }
  const { rowCount } = await pool.query("UPDATE users SET verification_status = $2 WHERE id = $1", [userId, status]);
  if (!rowCount) throw new HttpError(404, "User not found");
  return { ok: true };
}

export async function listSafetyReports(admin: AuthUser) {
  if (!admin.is_admin) throw new HttpError(403, "Admins only");
  const { rows } = await pool.query(
    `SELECT s.id, s.task_id, s.description, s.stopped_task, s.status, s.created_at, t.status AS task_status
       FROM safety_reports s JOIN tasks t ON t.id = s.task_id
      WHERE s.status = 'open' ORDER BY s.created_at`,
  );
  return { reports: rows };
}

export async function markSafetyReviewed(admin: AuthUser, reportId: string) {
  if (!admin.is_admin) throw new HttpError(403, "Admins only");
  if (!UUID_RE.test(reportId)) throw new HttpError(404, "Report not found");
  const { rowCount } = await pool.query("UPDATE safety_reports SET status = 'reviewed' WHERE id = $1", [reportId]);
  if (!rowCount) throw new HttpError(404, "Report not found");
  return { ok: true };
}

/** Everything an admin needs in one place: tasks needing a decision, verification requests, and safety reports. */
export async function adminQueue(admin: AuthUser) {
  if (!admin.is_admin) throw new HttpError(403, "Admins only");
  const [tasksRes, usersRes, reportsRes] = await Promise.all([
    pool.query(
      `SELECT t.id, t.title, t.status, t.price_cents, t.helpers_needed, t.updated_at,
              r.display_name AS requester_name
         FROM tasks t JOIN users r ON r.id = t.requester_id
        WHERE t.status IN ('paused_safety', 'disputed')
        ORDER BY t.updated_at DESC LIMIT 100`,
    ),
    pool.query(
      `SELECT id, display_name, email, role_mode, city, zip, created_at
         FROM users WHERE verification_status = 'pending'
        ORDER BY created_at LIMIT 100`,
    ),
    pool.query(
      `SELECT s.id, s.task_id, s.description, s.stopped_task, s.created_at, t.title, t.status AS task_status
         FROM safety_reports s JOIN tasks t ON t.id = s.task_id
        WHERE s.status = 'open' ORDER BY s.created_at LIMIT 100`,
    ),
  ]);
  const [verifiedRes, unverifiedRes] = await Promise.all([
    pool.query(
      `SELECT id, display_name, email, role_mode, city, zip, created_at
         FROM users WHERE verification_status = 'verified'
        ORDER BY created_at DESC LIMIT 200`,
    ),
    pool.query(
      `SELECT id, display_name, email, role_mode, city, zip, verification_status, created_at
         FROM users WHERE verification_status IN ('unverified', 'rejected')
        ORDER BY created_at DESC LIMIT 200`,
    ),
  ]);
  return {
    tasks: tasksRes.rows,
    verification_requests: usersRes.rows,
    safety_reports: reportsRes.rows,
    verified_members: verifiedRes.rows,
    unverified_members: unverifiedRes.rows,
  };
}

// ---------- payment (Stripe Checkout, test mode first) ----------

/** Requester starts paying for a paid task. Returns a Stripe Checkout link. */
export async function startFunding(user: AuthUser, id: string, origin: string) {
  const { rows } = await pool.query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [id]);
  const t = rows[0];
  if (!t) throw new HttpError(404, "Task not found");
  if (t.requester_id !== user.id) throw new HttpError(403, "Only the requester can pay for this task");
  if (t.help_type !== "paid") throw new HttpError(400, "Volunteer tasks have no payment");
  if (t.funded) throw new HttpError(409, "This task is already paid for");
  if (!["open", "accepted", "continue_later"].includes(t.status)) {
    throw new HttpError(409, `Payment cannot be started while the task is ${t.status}`);
  }
  const amount = t.price_cents * t.helpers_needed;
  return createFundingCheckout({
    taskId: t.id,
    title: t.title,
    amountCents: amount,
    requesterId: user.id,
    origin,
  });
}

/**
 * Applies a paid Checkout session to its task. Safe to run more than once: a repeat is ignored,
 * a second payment for the same task is refunded, and a payment that no longer matches the task price is refunded.
 */
async function applyPaidSession(sessionId: string, requesterId: string | null, taskId: string | null) {
  const paid = await paidCheckout(sessionId);
  if (taskId && paid.taskId !== taskId) throw new HttpError(400, "This payment is for a different task");
  if (requesterId && paid.requesterId !== requesterId) throw new HttpError(403, "Only the requester can confirm payment");
  return withTx(async (c) => {
    const t = await lockTask(c, paid.taskId);
    if (paid.requesterId !== t.requester_id) throw new HttpError(400, "This payment does not match the task requester");

    if (t.funded) {
      if (t.stripe_payment_intent_id !== paid.paymentIntentId) {
        // A second payment for the same task: return it so the requester is not charged twice.
        await refundToRequester({
          paymentIntentId: paid.paymentIntentId,
          amountCents: paid.amountCents,
          taskId: t.id,
          idempotencyKey: `duplicate-refund:${paid.paymentIntentId}`,
        });
      }
      return { status: t.status, funded: true };
    }

    const expected = t.price_cents * t.helpers_needed;
    if (paid.amountCents !== expected) {
      // The task changed after payment started. Return the money so the requester can pay again.
      await refundToRequester({
        paymentIntentId: paid.paymentIntentId,
        amountCents: paid.amountCents,
        taskId: t.id,
        idempotencyKey: `mismatch-refund:${paid.paymentIntentId}`,
      });
      throw new HttpError(409, "The task changed after payment started. Your payment was refunded; please pay again.");
    }

    await addEvent(c, t.id, "hold", expected);
    await c.query(
      `UPDATE tasks SET funded = true, stripe_payment_intent_id = $2, stripe_charge_id = $3, updated_at = now()
        WHERE id = $1`,
      [t.id, paid.paymentIntentId, paid.chargeId],
    );
    return { status: t.status, funded: true };
  });
}

/** Browser return from Stripe Checkout. Only the requester who started the payment can use it. */
export async function confirmFunding(user: AuthUser, id: string, sessionId: string) {
  if (!sessionId || sessionId.length > 255) throw new HttpError(400, "Missing payment reference");
  return applyPaidSession(sessionId, user.id, id);
}

/** Stripe webhook: records a payment even if the browser never returned to the site. */
export async function recordFundingFromWebhook(sessionId: string) {
  return applyPaidSession(sessionId, null, null);
}
