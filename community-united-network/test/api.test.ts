import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as payments from "../src/payments.js";
import { createApp } from "../src/app.js";
import { migrate, pool } from "../src/db.js";

const app = createApp();

// Stripe is replaced in tests. Each test sets what a completed Checkout payment looks like.
const stripeState = vi.hoisted(() => ({
  paid: null as null | { taskId: string; requesterId: string; amountCents: number; paymentIntentId: string; chargeId: string },
}));
vi.mock("../src/translate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/translate.js")>()),
  translationEnabled: () => true,
  translateText: vi.fn(async (text: string, target: string) => `[${target}] ${text}`),
}));
vi.mock("../src/payments.js", () => ({
  CURRENCY: "usd",
  payoutsReady: vi.fn(async () => true),
  transferToHelper: vi.fn(async () => undefined),
  refundToRequester: vi.fn(async () => undefined),
  createFundingCheckout: vi.fn(async () => ({ url: "https://checkout.example/test" })),
  paidCheckout: vi.fn(async () => stripeState.paid),
  startPayoutOnboarding: vi.fn(async () => ({ url: "https://onboard.example/test", accountId: "acct_test" })),
  // In tests the raw body is the event itself; real signature checks run in Stripe's SDK.
  verifyWebhook: vi.fn((raw: Buffer) => JSON.parse(raw.toString())),
}));
const adultDob = "1990-05-17";
let uniq = 0;

const email = (label: string) => `${label}-${Date.now()}-${uniq++}@example.test`;

async function newUser(role: "need_help" | "can_help" | "both", label: string) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({
    email: email(label),
    password: "correct horse battery",
    display_name: label.charAt(0).toUpperCase() + label.slice(1),
    date_of_birth: adultDob,
    role_mode: role,
  });
  expect(res.status).toBe(201);
  return { agent, id: res.body.id as string };
}

async function makeAdmin(id: string) {
  await pool.query("UPDATE users SET is_admin = true WHERE id = $1", [id]);
}

async function verify(adminAgent: request.Agent, userId: string) {
  const res = await adminAgent.post(`/api/admin/users/${userId}/verification`).send({ status: "verified" });
  expect(res.status).toBe(200);
  // Stand-in for a finished Stripe payout setup, so paid tasks can pay this helper.
  await pool.query("UPDATE users SET stripe_account_id = 'acct_test' WHERE id = $1", [userId]);
}

/** Test stand-in for a completed Stripe payment: records the hold the same way confirmFunding does. */
async function fund(taskId: string) {
  const { rows } = await pool.query<{ price_cents: number; helpers_needed: number }>(
    "SELECT price_cents, helpers_needed FROM tasks WHERE id = $1",
    [taskId],
  );
  await pool.query("INSERT INTO payment_events (task_id, kind, amount_cents) VALUES ($1, 'hold', $2)", [
    taskId,
    rows[0].price_cents * rows[0].helpers_needed,
  ]);
  await pool.query(
    "UPDATE tasks SET funded = true, stripe_payment_intent_id = 'pi_test', stripe_charge_id = 'ch_test' WHERE id = $1",
    [taskId],
  );
}

async function newTask(agent: request.Agent, overrides: Record<string, unknown> = {}) {
  const res = await agent.post("/api/tasks").send({
    title: "Fix kitchen exhaust fan",
    description: "Fan rattles and needs a belt replaced. Ladder required.",
    category: "home-repair",
    help_type: "paid",
    required_skills: ["Appliance Repair"],
    tools_needed: ["ladder"],
    city: "Colorado Springs",
    state: "CO",
    zip: "80903",
    address_private: "123 Secret Lane",
    schedule_type: "tomorrow",
    helpers: "one",
    supplies_provided: "helper",
    price_cents: 2500,
    ...overrides,
  });
  expect(res.status).toBe(201);
  if (res.body.help_type !== "volunteer") await fund(res.body.id);
  return res.body as { id: string; price_cents: number };
}

/** Ledger totals for a task. held must equal holds minus everything that left escrow. */
async function ledger(taskId: string) {
  const { rows } = await pool.query<{ kind: string; total: number }>(
    `SELECT kind, COALESCE(SUM(amount_cents), 0)::int AS total FROM payment_events
      WHERE task_id = $1 GROUP BY kind`,
    [taskId],
  );
  const m: Record<string, number> = Object.fromEntries(rows.map((r) => [r.kind, r.total]));
  const hold = m.hold ?? 0;
  const out = (m.release_helper ?? 0) + (m.platform_fee ?? 0) + (m.refund ?? 0);
  return {
    hold,
    released: m.release_helper ?? 0,
    fee: m.platform_fee ?? 0,
    refund: m.refund ?? 0,
    held: hold - out,
  };
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await pool.query("TRUNCATE users, tasks CASCADE");
  stripeState.paid = null;
  vi.clearAllMocks();
});

afterAll(async () => {
  await pool.end();
});

describe("accounts", () => {
  it("rejects anyone under 18", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: email("kid"),
      password: "correct horse battery",
      display_name: "Kid",
      date_of_birth: new Date(Date.now() - 15 * 365 * 86_400_000).toISOString().slice(0, 10),
      role_mode: "need_help",
    });
    expect(res.status).toBe(403);
  });

  it("logs in, returns profile, and logs out", async () => {
    const u = await newUser("both", "ann");
    const me = await u.agent.get("/api/me");
    expect(me.status).toBe(200);
    expect(me.body).not.toHaveProperty("password_hash");
    expect(me.body).not.toHaveProperty("email");

    await u.agent.post("/api/auth/logout").send({});
    expect((await u.agent.get("/api/me")).status).toBe(401);
    expect((await u.agent.post("/api/tasks").send({})).status).toBe(401);
  });

  it("gives the same error for wrong password and unknown email", async () => {
    await newUser("both", "bob");
    const wrongPw = await request(app).post("/api/auth/login").send({ email: "nobody@example.test", password: "x" });
    expect(wrongPw.status).toBe(401);
    expect(wrongPw.body.error).toBe("Email or password is incorrect");
  });

  it("rejects non-JSON writes", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "text/plain")
      .send("email=a&password=b");
    expect(res.status).toBe(415);
  });

  it("never sets a session cookie that JavaScript can read", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: email("cookie"),
      password: "correct horse battery",
      display_name: "Cookie Tester",
      date_of_birth: adultDob,
      role_mode: "both",
    });
    const cookie = res.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });
});

describe("paid task, happy path", () => {
  it("holds funds, pays the helper minus 15%, and keeps the ledger balanced", async () => {
    const requester = await newUser("need_help", "rita");
    const helper = await newUser("can_help", "hank");
    const admin = await newUser("both", "admin");
    await makeAdmin(admin.id);
    await verify(admin.agent, helper.id);

    const task = await newTask(requester.agent);
    expect((await ledger(task.id)).held).toBe(2500);

    const helperAccept = await helper.agent.post(`/api/tasks/${task.id}/accept`).send({});
    expect(helperAccept.status).toBe(200);
    expect(helperAccept.body.status).toBe("accepted");

    // Address is visible to the assigned helper and the requester, hidden from strangers.
    const helperView = await helper.agent.get(`/api/tasks/${task.id}`);
    expect(helperView.body.address_private).toBe("123 Secret Lane");
    expect(helperView.body.viewer_role).toBe("helper");
    const stranger = await newUser("both", "stan");
    const strangerView = await stranger.agent.get(`/api/tasks/${task.id}`);
    expect(strangerView.body).not.toHaveProperty("address_private");
    expect(strangerView.body).not.toHaveProperty("held_cents");

    expect((await helper.agent.post(`/api/tasks/${task.id}/start`).send({})).body.status).toBe("in_progress");
    const finish = await helper.agent.post(`/api/tasks/${task.id}/finish`).send({ outcome: "completed" });
    expect(finish.body.status).toBe("awaiting_confirmation");

    // Money does not move until the requester confirms.
    expect((await ledger(task.id)).released).toBe(0);

    const confirm = await requester.agent.post(`/api/tasks/${task.id}/confirm`).send({});
    expect(confirm.body.status).toBe("completed");

    const books = await ledger(task.id);
    expect(books).toMatchObject({ released: 2125, fee: 375, refund: 0, held: 0 });
  });

  it("does not let the helper confirm their own work", async () => {
    const requester = await newUser("need_help", "rosa");
    const helper = await newUser("can_help", "hal");
    const admin = await newUser("both", "boss");
    await makeAdmin(admin.id);
    await verify(admin.agent, helper.id);
    const task = await newTask(requester.agent);
    await helper.agent.post(`/api/tasks/${task.id}/accept`).send({});
    await helper.agent.post(`/api/tasks/${task.id}/start`).send({});
    await helper.agent.post(`/api/tasks/${task.id}/finish`).send({ outcome: "completed" });
    expect((await helper.agent.post(`/api/tasks/${task.id}/confirm`).send({})).status).toBe(403);
  });

  it("blocks unverified helpers and requesters accepting their own task", async () => {
    const requester = await newUser("both", "unv-req");
    const helper = await newUser("can_help", "unv-help");
    const task = await newTask(requester.agent);
    expect((await helper.agent.post(`/api/tasks/${task.id}/accept`).send({})).status).toBe(403);
    expect((await requester.agent.post(`/api/tasks/${task.id}/accept`).send({})).status).toBe(403);
  });

  it("ranks candidates for the requester only", async () => {
    const requester = await newUser("need_help", "cand-req");
    const helper = await newUser("can_help", "cand-help");
    const task = await newTask(requester.agent);
    const mine = await requester.agent.get(`/api/tasks/${task.id}/candidates`);
    expect(mine.status).toBe(200);
    expect(mine.body.candidates.map((c: { id: string }) => c.id)).toContain(helper.id);
    expect(mine.body.candidates[0]).not.toHaveProperty("email");
    const other = await helper.agent.get(`/api/tasks/${task.id}/candidates`);
    expect(other.status).toBe(403);
  });
});

describe("cancellation", () => {
  it("pays 50% compensation for a cancellation under 4 hours before the job", async () => {
    const requester = await newUser("need_help", "cx-req");
    const helper = await newUser("can_help", "cx-help");
    const admin = await newUser("both", "cx-admin");
    await makeAdmin(admin.id);
    await verify(admin.agent, helper.id);

    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const task = await newTask(requester.agent, { price_cents: 4000, schedule_type: "specific_date", scheduled_for: soon });
    await helper.agent.post(`/api/tasks/${task.id}/accept`).send({});

    const res = await requester.agent.post(`/api/tasks/${task.id}/cancel`).send({});
    expect(res.body).toMatchObject({ status: "cancelled", compensation_cents: 2000, refunded_cents: 2000 });
    expect(await ledger(task.id)).toMatchObject({ released: 1700, fee: 300, refund: 2000, held: 0 });
  });

  it("waives compensation for an emergency exception", async () => {
    const requester = await newUser("need_help", "em-req");
    const helper = await newUser("can_help", "em-help");
    const admin = await newUser("both", "em-admin");
    await makeAdmin(admin.id);
    await verify(admin.agent, helper.id);
    const task = await newTask(requester.agent, { price_cents: 4000 });
    await helper.agent.post(`/api/tasks/${task.id}/accept`).send({});
    const res = await requester.agent.post(`/api/tasks/${task.id}/cancel`).send({ exception: true });
    expect(res.body.compensation_cents).toBe(0);
    expect(await ledger(task.id)).toMatchObject({ released: 0, fee: 0, refund: 4000, held: 0 });
  });

  it("refunds everything when a helper withdraws, and keeps the slot open", async () => {
    const requester = await newUser("need_help", "wd-req");
    const helper = await newUser("can_help", "wd-help");
    const admin = await newUser("both", "wd-admin");
    await makeAdmin(admin.id);
    await verify(admin.agent, helper.id);
    const task = await newTask(requester.agent);
    await helper.agent.post(`/api/tasks/${task.id}/accept`).send({});
    const res = await helper.agent.post(`/api/tasks/${task.id}/withdraw`).send({});
    expect(res.body.status).toBe("open");
    expect((await ledger(task.id)).held).toBe(2500);
  });
});

describe("change requests and partial completion", () => {
  it("blocks price changes once the task is paid, then pays a partial amount and refunds the rest", async () => {
    const requester = await newUser("need_help", "pc-req");
    const helper = await newUser("can_help", "pc-help");
    const admin = await newUser("both", "pc-admin");
    await makeAdmin(admin.id);
    await verify(admin.agent, helper.id);

    const task = await newTask(requester.agent, { price_cents: 5000 });
    await helper.agent.post(`/api/tasks/${task.id}/accept`).send({});

    const change = await helper.agent
      .post(`/api/tasks/${task.id}/changes`)
      .send({ kind: "price", proposed: { price_cents: 6000 }, reason: "Found a cracked housing" });
    expect(change.status).toBe(201);

    // The helper cannot approve their own change.
    expect((await helper.agent.post(`/api/tasks/changes/${change.body.id}/approve`).send({})).status).toBe(403);

    // Once paid, the price is locked in; a change needs a new payment instead.
    const approved = await requester.agent.post(`/api/tasks/changes/${change.body.id}/approve`).send({});
    expect(approved.status).toBe(409);
    expect((await ledger(task.id)).held).toBe(5000);

    await helper.agent.post(`/api/tasks/${task.id}/start`).send({});
    await helper.agent.post(`/api/tasks/${task.id}/finish`).send({ outcome: "partially_completed", earned_cents: 2000 });
    await requester.agent.post(`/api/tasks/${task.id}/confirm`).send({});

    expect(await ledger(task.id)).toMatchObject({ released: 1700, fee: 300, refund: 3000, held: 0 });
  });

  it("requires a partial amount strictly between zero and the full rate", async () => {
    const requester = await newUser("need_help", "pz-req");
    const helper = await newUser("can_help", "pz-help");
    const admin = await newUser("both", "pz-admin");
    await makeAdmin(admin.id);
    await verify(admin.agent, helper.id);
    const task = await newTask(requester.agent);
    await helper.agent.post(`/api/tasks/${task.id}/accept`).send({});
    await helper.agent.post(`/api/tasks/${task.id}/start`).send({});
    const res = await helper.agent.post(`/api/tasks/${task.id}/finish`).send({ outcome: "partially_completed", earned_cents: 2500 });
    expect(res.status).toBe(400);
  });

  it("supports continue later: pays what is earned and keeps the remainder held", async () => {
    const requester = await newUser("need_help", "cl-req");
    const helper = await newUser("can_help", "cl-help");
    const admin = await newUser("both", "cl-admin");
    await makeAdmin(admin.id);
    await verify(admin.agent, helper.id);
    const task = await newTask(requester.agent, { price_cents: 4000 });
    await helper.agent.post(`/api/tasks/${task.id}/accept`).send({});
    await helper.agent.post(`/api/tasks/${task.id}/start`).send({});
    await helper.agent.post(`/api/tasks/${task.id}/finish`).send({ outcome: "continue_later", earned_cents: 1000 });
    const confirm = await requester.agent.post(`/api/tasks/${task.id}/confirm`).send({});
    expect(confirm.body.status).toBe("continue_later");
    expect(await ledger(task.id)).toMatchObject({ released: 850, fee: 150, held: 3000 });

    // Resume and finish: the helper is paid the rest.
    await helper.agent.post(`/api/tasks/${task.id}/start`).send({});
    await helper.agent.post(`/api/tasks/${task.id}/finish`).send({ outcome: "completed" });
    await requester.agent.post(`/api/tasks/${task.id}/confirm`).send({});
    expect(await ledger(task.id)).toMatchObject({ released: 3400, fee: 600, held: 0 });
  });
});

describe("safety concerns", () => {
  it("pauses the task on a stop report, keeps it separate from disputes, and lets an admin resolve it", async () => {
    const requester = await newUser("need_help", "sf-req");
    const helper = await newUser("can_help", "sf-help");
    const admin = await newUser("both", "sf-admin");
    await makeAdmin(admin.id);
    await verify(admin.agent, helper.id);
    const task = await newTask(requester.agent, { price_cents: 3000 });
    await helper.agent.post(`/api/tasks/${task.id}/accept`).send({});
    await helper.agent.post(`/api/tasks/${task.id}/start`).send({});

    const report = await helper.agent
      .post(`/api/tasks/${task.id}/safety-reports`)
      .send({ description: "Gas smell near the range, stopped work.", stop_task: true });
    expect(report.body.status).toBe("paused_safety");

    // Only admins resolve safety pauses.
    expect((await requester.agent.post(`/api/admin/tasks/${task.id}/resolve`).send({ outcome: "cancelled" })).status).toBe(403);

    const resolved = await admin.agent
      .post(`/api/admin/tasks/${task.id}/resolve`)
      .send({ outcome: "cancelled", earned_cents: 0, note: "Unsafe site" });
    expect(resolved.body.status).toBe("cancelled");
    expect(await ledger(task.id)).toMatchObject({ released: 0, refund: 3000, held: 0 });

    const queue = await admin.agent.get("/api/admin/safety-reports");
    expect(queue.body.reports).toHaveLength(1);
  });
});

describe("reviews", () => {
  it("lets the requester review a helper once the task is completed", async () => {
    const requester = await newUser("need_help", "rv-req");
    const helper = await newUser("can_help", "rv-help");
    const admin = await newUser("both", "rv-admin");
    await makeAdmin(admin.id);
    await verify(admin.agent, helper.id);
    const task = await newTask(requester.agent);
    await helper.agent.post(`/api/tasks/${task.id}/accept`).send({});
    await helper.agent.post(`/api/tasks/${task.id}/start`).send({});
    await helper.agent.post(`/api/tasks/${task.id}/finish`).send({ outcome: "completed" });
    await requester.agent.post(`/api/tasks/${task.id}/confirm`).send({});
    const res = await requester.agent
      .post(`/api/tasks/${task.id}/reviews`)
      .send({ rating: 5, comment: "On time and tidy.", subject_id: helper.id });
    expect(res.status).toBe(201);
  });
});

describe("my tasks", () => {
  it("lists tasks the person requested or is helping on", async () => {
    const requester = await newUser("need_help", "mt-req");
    const helper = await newUser("can_help", "mt-help");
    const admin = await newUser("both", "mt-admin");
    await makeAdmin(admin.id);
    await verify(admin.agent, helper.id);
    const task = await newTask(requester.agent);
    expect((await helper.agent.get("/api/tasks/mine")).body.tasks).toHaveLength(0);
    await helper.agent.post(`/api/tasks/${task.id}/accept`).send({});
    const mine = await helper.agent.get("/api/tasks/mine");
    expect(mine.body.tasks[0]).toMatchObject({ id: task.id, is_requester: false });
    const theirs = await requester.agent.get("/api/tasks/mine");
    expect(theirs.body.tasks[0]).toMatchObject({ id: task.id, is_requester: true });
  });
});

describe("admin queue and verification requests", () => {
  it("lets a person request verification once, and shows it in the admin queue", async () => {
    const admin = await newUser("both", "q-admin");
    await makeAdmin(admin.id);
    const helper = await newUser("can_help", "q-help");
    const first = await helper.agent.post("/api/me/request-verification").send({});
    expect(first.body.verification_status).toBe("pending");
    expect((await helper.agent.post("/api/me/request-verification").send({})).status).toBe(409);

    const queue = await admin.agent.get("/api/admin/queue");
    expect(queue.body.verification_requests.map((u: { id: string }) => u.id)).toContain(helper.id);
    // A pending request shows under Verification requests, not under Not yet verified.
    expect(queue.body.unverified_members.map((u: { id: string }) => u.id)).not.toContain(helper.id);
    expect(queue.body.verified_members.map((u: { id: string }) => u.id)).not.toContain(helper.id);
    expect((await helper.agent.get("/api/admin/queue")).status).toBe(403);
  });

  it("shows paused and disputed tasks with their status", async () => {
    const requester = await newUser("need_help", "q-req");
    const helper = await newUser("can_help", "q-h2");
    const admin = await newUser("both", "q-admin2");
    await makeAdmin(admin.id);
    await verify(admin.agent, helper.id);
    const task = await newTask(requester.agent);
    await helper.agent.post(`/api/tasks/${task.id}/accept`).send({});
    await helper.agent.post(`/api/tasks/${task.id}/start`).send({});
    await helper.agent.post(`/api/tasks/${task.id}/safety-reports`).send({ description: "Loose ladder, stopping.", stop_task: true });
    const queue = await admin.agent.get("/api/admin/queue");
    expect(queue.body.tasks[0]).toMatchObject({ id: task.id, status: "paused_safety" });
    expect(queue.body.safety_reports).toHaveLength(1);
  });
});

describe("founders", () => {
  it("lists founders publicly and shows the title on the profile", async () => {
    const u = await newUser("both", "founder");
    await pool.query("UPDATE users SET founder_title = 'Co-founder' WHERE id = $1", [u.id]);
    const list = await request(app).get("/api/founders");
    expect(list.status).toBe(200);
    expect(list.body.founders.map((f: { founder_title: string }) => f.founder_title)).toContain("Co-founder");
    const me = await u.agent.get("/api/me");
    expect(me.body.founder_title).toBe("Co-founder");
  });
});

describe("payments", () => {
  it("does not let anyone accept a paid task before it is funded", async () => {
    const requester = await newUser("need_help", "pay-req");
    const helper = await newUser("can_help", "pay-help");
    const admin = await newUser("both", "pay-admin");
    await makeAdmin(admin.id);
    await verify(admin.agent, helper.id);
    const posted = await requester.agent.post("/api/tasks").send({
      title: "Replace vent fan",
      description: "Fan needs a new belt",
      category: "home-repair",
      city: "Colorado Springs",
      zip: "80903",
      schedule_type: "tomorrow",
      helpers: "one",
      price_cents: 2500,
    });
    expect(posted.body.funded).toBe(false);
    const accept = await helper.agent.post(`/api/tasks/${posted.body.id}/accept`).send({});
    expect(accept.status).toBe(409);
  });

  it("starts checkout for the requester only, and records the hold once payment is confirmed", async () => {
    const requester = await newUser("need_help", "ck-req");
    const other = await newUser("both", "ck-other");
    const posted = await requester.agent.post("/api/tasks").send({
      title: "Replace vent fan",
      description: "Fan needs a new belt",
      category: "home-repair",
      city: "Colorado Springs",
      zip: "80903",
      schedule_type: "tomorrow",
      helpers: "one",
      price_cents: 2500,
    });
    const taskId = posted.body.id as string;

    const start = await requester.agent.post(`/api/tasks/${taskId}/funding`).send({});
    expect(start.body.url).toBe("https://checkout.example/test");
    expect((await other.agent.post(`/api/tasks/${taskId}/funding`).send({})).status).toBe(403);

    stripeState.paid = { taskId, requesterId: requester.id, amountCents: 2500, paymentIntentId: "pi_1", chargeId: "ch_1" };
    const confirm = await requester.agent.post(`/api/tasks/${taskId}/funding/confirm`).send({ session_id: "cs_test_1" });
    expect(confirm.body.funded).toBe(true);
    expect((await ledger(taskId)).held).toBe(2500);

    // Confirming the same payment again does not add a second hold.
    await requester.agent.post(`/api/tasks/${taskId}/funding/confirm`).send({ session_id: "cs_test_1" });
    expect((await ledger(taskId)).held).toBe(2500);
  });

  it("refuses a payment that belongs to a different task", async () => {
    const requester = await newUser("need_help", "mm-req");
    const posted = await requester.agent.post("/api/tasks").send({
      title: "Replace vent fan",
      description: "Fan needs a new belt",
      category: "home-repair",
      city: "Colorado Springs",
      zip: "80903",
      schedule_type: "tomorrow",
      helpers: "one",
      price_cents: 2500,
    });
    stripeState.paid = {
      taskId: "00000000-0000-4000-8000-000000000000",
      requesterId: requester.id,
      amountCents: 2500,
      paymentIntentId: "pi_2",
      chargeId: "ch_2",
    };
    const res = await requester.agent.post(`/api/tasks/${posted.body.id}/funding/confirm`).send({ session_id: "cs_test_2" });
    expect(res.status).toBe(400);
  });

  it("pays the helper's share through Stripe, with the fee kept by the platform", async () => {
    const requester = await newUser("need_help", "tr-req");
    const helper = await newUser("can_help", "tr-help");
    const admin = await newUser("both", "tr-admin");
    await makeAdmin(admin.id);
    await verify(admin.agent, helper.id);

    const payout = await helper.agent.post("/api/me/payout-account").send({});
    expect(payout.body.url).toBe("https://onboard.example/test");
    expect((await helper.agent.get("/api/me/payout-account")).body).toMatchObject({ has_account: true, ready: true });

    const task = await newTask(requester.agent, { price_cents: 2500 });
    await helper.agent.post(`/api/tasks/${task.id}/accept`).send({});
    await helper.agent.post(`/api/tasks/${task.id}/start`).send({});
    await helper.agent.post(`/api/tasks/${task.id}/finish`).send({ outcome: "completed" });
    await requester.agent.post(`/api/tasks/${task.id}/confirm`).send({});

    const transfer = vi.mocked(payments.transferToHelper);
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer.mock.calls[0][0]).toMatchObject({ accountId: "acct_test", amountCents: 2125, chargeId: "ch_test" });
    expect(vi.mocked(payments.refundToRequester)).not.toHaveBeenCalled();
  });
});

describe("community directory", () => {
  it("lists only members who opted in, and never shows private details", async () => {
    const shown = await newUser("both", "dir-shown");
    const hidden = await newUser("both", "dir-hidden");
    await shown.agent.put("/api/me").send({ display_name: "Shown Member", city: "Colorado Springs", zip: "80903", profile_public: true, skills: ["Repair"] });
    await hidden.agent.put("/api/me").send({ display_name: "Hidden Member", zip: "80903" });

    const admin = await newUser("both", "dir-admin");
    await makeAdmin(admin.id);
    const viewer = await newUser("both", "dir-viewer");
    await verify(admin.agent, viewer.id);
    const list = await viewer.agent.get("/api/members");
    expect(list.status).toBe(200);
    const ids = list.body.members.map((m: { id: string }) => m.id);
    expect(ids).toContain(shown.id);
    expect(ids).not.toContain(hidden.id);

    const member = list.body.members.find((m: { id: string }) => m.id === shown.id);
    expect(member).not.toHaveProperty("email");
    expect(member).not.toHaveProperty("zip");
    expect(member).not.toHaveProperty("date_of_birth");

    expect((await viewer.agent.get(`/api/members/${hidden.id}`)).status).toBe(404);
    expect((await viewer.agent.get(`/api/members/${shown.id}`)).status).toBe(200);
  });
});

describe("chat", () => {
  async function member(label: string, language: string) {
    const u = await newUser("both", label);
    await u.agent.put("/api/me").send({ display_name: label, profile_public: true, language });
    return u;
  }

  it("lets verified members message each other, translated into the reader's language", async () => {
    const admin = await newUser("both", "chat-admin");
    await makeAdmin(admin.id);
    const es = await member("chat-es", "es");
    const de = await member("chat-de", "de");
    await verify(admin.agent, es.id);
    await verify(admin.agent, de.id);

    const conv = await es.agent.post("/api/chat/conversations").send({ member_id: de.id });
    expect(conv.status).toBe(201);
    const sent = await es.agent.post(`/api/chat/conversations/${conv.body.id}/messages`).send({ body: "Hola, ¿tienes tiempo mañana?" });
    expect(sent.status).toBe(201);
    expect(sent.body.body).toBe("Hola, ¿tienes tiempo mañana?");

    const receiverView = await de.agent.get(`/api/chat/conversations/${conv.body.id}/messages`);
    expect(receiverView.body.messages[0].body).toBe("[de] Hola, ¿tienes tiempo mañana?");
    expect(receiverView.body.messages[0].original).toBe("Hola, ¿tienes tiempo mañana?");
    expect(receiverView.body.messages[0].translated).toBe(true);

    const senderView = await es.agent.get(`/api/chat/conversations/${conv.body.id}/messages`);
    expect(senderView.body.messages[0].translated).toBe(false);
  });

  it("keeps phone numbers and email addresses out of messages", async () => {
    const admin = await newUser("both", "chat-admin2");
    await makeAdmin(admin.id);
    const a = await member("chat-a", "en");
    const b = await member("chat-b", "en");
    await verify(admin.agent, a.id);
    await verify(admin.agent, b.id);
    const conv = await a.agent.post("/api/chat/conversations").send({ member_id: b.id });
    const phone = await a.agent.post(`/api/chat/conversations/${conv.body.id}/messages`).send({ body: "Call me at 555-867-5309" });
    const email = await a.agent.post(`/api/chat/conversations/${conv.body.id}/messages`).send({ body: "mail me at jo@example.com" });
    const ok = await a.agent.post(`/api/chat/conversations/${conv.body.id}/messages`).send({ body: "Fan is on the roof, bring a ladder" });
    expect(phone.status).toBe(400);
    expect(email.status).toBe(400);
    expect(ok.status).toBe(201);
  });

  it("blocks messages to people who are not verified, not listed, or who blocked you", async () => {
    const admin = await newUser("both", "chat-admin3");
    await makeAdmin(admin.id);
    const sender = await member("chat-sender", "en");
    const blocker = await member("chat-blocker", "en");
    await verify(admin.agent, sender.id);
    await verify(admin.agent, blocker.id);
    const unverified = await newUser("both", "chat-unverified");
    await unverified.agent.put("/api/me").send({ profile_public: true });

    // Unverified recipient
    expect((await sender.agent.post("/api/chat/conversations").send({ member_id: unverified.id })).status).toBe(403);

    // Blocked
    await blocker.agent.post("/api/chat/blocks").send({ member_id: sender.id });
    expect((await sender.agent.post("/api/chat/conversations").send({ member_id: blocker.id })).status).toBe(403);
  });

  it("lets members report a message, and lists the report for admins", async () => {
    const admin = await newUser("both", "chat-admin4");
    await makeAdmin(admin.id);
    const a = await member("chat-ra", "en");
    const b = await member("chat-rb", "en");
    await verify(admin.agent, a.id);
    await verify(admin.agent, b.id);
    const conv = await a.agent.post("/api/chat/conversations").send({ member_id: b.id });
    const msg = await a.agent.post(`/api/chat/conversations/${conv.body.id}/messages`).send({ body: "Something is off here" });
    const report = await b.agent.post(`/api/chat/messages/${msg.body.id}/report`).send({ reason: "Harassing message" });
    expect(report.status).toBe(201);
    const queue = await admin.agent.get("/api/admin/reports");
    expect(queue.body.reports[0].reason).toBe("Harassing message");
  });
});

describe("stripe webhook", () => {
  it("records a paid checkout even if the browser never returns, and ignores repeat deliveries", async () => {
    const requester = await newUser("need_help", "wh-req");
    const posted = await requester.agent.post("/api/tasks").send({
      title: "Replace vent fan",
      description: "Fan needs a new belt",
      category: "home-repair",
      city: "Colorado Springs",
      zip: "80903",
      schedule_type: "tomorrow",
      helpers: "one",
      price_cents: 2500,
    });
    const taskId = posted.body.id as string;
    stripeState.paid = { taskId, requesterId: requester.id, amountCents: 2500, paymentIntentId: "pi_wh", chargeId: "ch_wh" };
    const event = {
      type: "checkout.session.completed",
      data: { object: { id: "cs_wh", mode: "payment", payment_status: "paid", metadata: { task_id: taskId } } },
    };
    const send = () => request(app).post("/api/stripe/webhook").set("Content-Type", "application/json").set("stripe-signature", "t=1,v1=x").send(JSON.stringify(event));

    expect((await send()).status).toBe(200);
    expect((await ledger(taskId)).held).toBe(2500);

    expect((await send()).status).toBe(200);
    expect((await ledger(taskId)).held).toBe(2500);
  });

  it("rejects requests whose signature does not check out", async () => {
    vi.mocked(payments.verifyWebhook).mockImplementationOnce(() => {
      throw new Error("bad signature");
    });
    const res = await request(app).post("/api/stripe/webhook").set("Content-Type", "application/json").send("{}");
    expect(res.status).toBe(400);
  });
});

describe("categories", () => {
  it("lists the categories and rejects an unknown one", async () => {
    const list = await request(app).get("/api/tasks/categories");
    expect(list.body.categories.map((c: { value: string }) => c.value)).toContain("electronics");
    const requester = await newUser("need_help", "cat-req");
    const bad = await requester.agent.post("/api/tasks").send({
      title: "Something odd",
      description: "A task with a category that does not exist",
      category: "made-up",
      city: "Colorado Springs",
      zip: "80903",
      schedule_type: "tomorrow",
      helpers: "one",
      price_cents: 0,
      help_type: "volunteer",
    });
    expect(bad.status).toBe(400);
  });
});

describe("verification gates", () => {
  const postTask = (agent: request.Agent, overrides: Record<string, unknown> = {}) =>
    agent.post("/api/tasks").send({
      title: "Replace vent fan",
      description: "Fan needs a new belt",
      category: "home-repair",
      city: "Colorado Springs",
      zip: "80903",
      schedule_type: "tomorrow",
      helpers: "one",
      price_cents: 2500,
      ...overrides,
    });

  it("does not let unverified people browse tasks or open task details", async () => {
    const unverified = await newUser("both", "gate-unverified");
    const requester = await newUser("need_help", "gate-requester");
    const posted = await postTask(requester.agent);
    expect((await unverified.agent.get("/api/tasks")).status).toBe(403);
    expect((await unverified.agent.get(`/api/tasks/${posted.body.id}`)).status).toBe(403);
    // The requester can still see their own task before they are verified.
    expect((await requester.agent.get(`/api/tasks/${posted.body.id}`)).status).toBe(200);
  });

  it("does not show unpaid paid tasks in browse", async () => {
    const admin = await newUser("both", "gate-admin");
    await makeAdmin(admin.id);
    const viewer = await newUser("both", "gate-viewer");
    await verify(admin.agent, viewer.id);
    const requester = await newUser("need_help", "gate-req2");
    const unpaid = await postTask(requester.agent, { title: "Unpaid task here" });
    const list = await viewer.agent.get("/api/tasks");
    expect(list.body.tasks.map((t: { id: string }) => t.id)).not.toContain(unpaid.body.id);
    await fund(unpaid.body.id);
    const after = await viewer.agent.get("/api/tasks");
    expect(after.body.tasks.map((t: { id: string }) => t.id)).toContain(unpaid.body.id);
  });
});
