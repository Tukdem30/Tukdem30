import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { migrate, pool } from "../src/db.js";

const app = createApp();
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
}

async function newTask(agent: request.Agent, overrides: Record<string, unknown> = {}) {
  const res = await agent.post("/api/tasks").send({
    title: "Fix kitchen exhaust fan",
    description: "Fan rattles and needs a belt replaced. Ladder required.",
    category: "repair",
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
    expect(cookie).toMatch(/SameSite=Strict/i);
  });
});

describe("paid task, happy path", () => {
  it("holds funds, pays the helper minus 10%, and keeps the ledger balanced", async () => {
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
    expect(books).toMatchObject({ released: 2250, fee: 250, refund: 0, held: 0 });
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
    expect(await ledger(task.id)).toMatchObject({ released: 1800, fee: 200, refund: 2000, held: 0 });
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
  it("applies an approved price change, then pays a partial amount and refunds the rest", async () => {
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

    const approved = await requester.agent.post(`/api/tasks/changes/${change.body.id}/approve`).send({});
    expect(approved.status).toBe(200);
    expect((await ledger(task.id)).held).toBe(6000);

    // The agreement history records the original terms and the approved change.
    const history = await requester.agent.get(`/api/tasks/${task.id}/history`);
    expect(history.body.history.map((h: { version: number }) => h.version)).toEqual([1, 2]);
    expect(history.body.history[1].snapshot.price_cents).toBe(6000);

    await helper.agent.post(`/api/tasks/${task.id}/start`).send({});
    await helper.agent.post(`/api/tasks/${task.id}/finish`).send({ outcome: "partially_completed", earned_cents: 2000 });
    await requester.agent.post(`/api/tasks/${task.id}/confirm`).send({});

    expect(await ledger(task.id)).toMatchObject({ released: 1800, fee: 200, refund: 4000, held: 0 });
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
    expect(await ledger(task.id)).toMatchObject({ released: 900, fee: 100, held: 3000 });

    // Resume and finish: the helper is paid the rest.
    await helper.agent.post(`/api/tasks/${task.id}/start`).send({});
    await helper.agent.post(`/api/tasks/${task.id}/finish`).send({ outcome: "completed" });
    await requester.agent.post(`/api/tasks/${task.id}/confirm`).send({});
    expect(await ledger(task.id)).toMatchObject({ released: 3600, fee: 400, held: 0 });
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
