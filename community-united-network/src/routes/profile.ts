import { Router } from "express";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { pool } from "../db.js";
import { HttpError } from "../errors.js";
import { rankHelpers } from "../matching.js";
import { tagList, zip } from "../validation.js";
import { payoutsReady, startPayoutOnboarding } from "../payments.js";
import { siteOrigin } from "../origin.js";

export const profileRouter = Router();

const profileSchema = z.object({
  display_name: z.string().trim().min(2).max(80).optional(),
  role_mode: z.enum(["need_help", "can_help", "both"]).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(40).optional(),
  zip: zip.optional(),
  bio: z.string().max(1000).optional(),
  availability: z.string().max(300).optional(),
  skills: tagList.optional(),
  tools: tagList.optional(),
  profile_public: z.boolean().optional(),
});

const PROFILE_COLUMNS = `id, display_name, role_mode, city, state, zip, bio, availability,
  skills, tools, verification_status, is_admin, founder_title, profile_public, created_at`;

profileRouter.get("/", requireUser, async (req, res) => {
  const { rows } = await pool.query(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = $1`, [req.user!.id]);
  if (!rows[0]) throw new HttpError(404, "Account not found");
  res.json(rows[0]);
});

profileRouter.put("/", requireUser, async (req, res) => {
  const input = profileSchema.parse(req.body);
  const entries = Object.entries(input).filter(([, v]) => v !== undefined);
  if (entries.length === 0) throw new HttpError(400, "Nothing to update");
  const sets = entries.map(([col], i) => `${col} = $${i + 1}`);
  const values = entries.map(([, v]) => v);
  values.push(req.user!.id);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING ${PROFILE_COLUMNS}`,
    values,
  );
  res.json(rows[0]);
});

/** Open tasks ranked for the signed-in person. Every eligible task is returned; ranking only orders them. */
profileRouter.get("/matches", requireUser, async (req, res) => {
  const { rows: meRows } = await pool.query(
    `SELECT id, role_mode, zip, city, skills, tools, verification_status FROM users WHERE id = $1`,
    [req.user!.id],
  );
  const me = meRows[0];
  const { rows: tasks } = await pool.query(
    `SELECT id, title, category, city, zip, required_skills, tools_needed, requester_id, price_cents, help_type
       FROM tasks WHERE status = 'open' AND requester_id <> $1 ORDER BY created_at DESC LIMIT 500`,
    [req.user!.id],
  );
  const ranked = tasks
    .map((t) => {
      const result = rankHelpers(
        {
          requesterId: t.requester_id,
          zip: t.zip,
          city: t.city,
          requiredSkills: t.required_skills,
          toolsNeeded: t.tools_needed,
        },
        [
          {
            id: me.id,
            roleMode: me.role_mode,
            verified: me.verification_status === "verified",
            zip: me.zip,
            city: me.city,
            skills: me.skills,
            tools: me.tools,
          },
        ],
      );
      return { task: t, match: result[0] ?? null };
    })
    .filter((r) => r.match !== null)
    .sort((a, b) => b.match!.score - a.match!.score)
    .map(({ task, match }) => ({
      id: task.id,
      title: task.title,
      category: task.category,
      city: task.city,
      zip: task.zip,
      price_cents: task.price_cents,
      help_type: task.help_type,
      score: match!.score,
      reasons: match!.reasons,
    }));
  res.json({ matches: ranked });
});

/** A person asks for identity verification. Admins approve or reject from the admin queue. */
profileRouter.post("/request-verification", requireUser, async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE users SET verification_status = 'pending'
      WHERE id = $1 AND verification_status IN ('unverified', 'rejected')`,
    [req.user!.id],
  );
  if (!rowCount) throw new HttpError(409, "Verification is already requested or complete");
  res.json({ verification_status: "pending" });
});

/** Public list of founders for the front page. */
export const foundersRouter = Router();

foundersRouter.get("/", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT display_name, founder_title FROM users WHERE founder_title IS NOT NULL ORDER BY display_name`,
  );
  res.json({ founders: rows });
});

/** Whether the signed-in helper's Stripe payout account is ready to receive paid-task money. */
profileRouter.get("/payout-account", requireUser, async (req, res) => {
  const { rows } = await pool.query<{ stripe_account_id: string | null }>(
    "SELECT stripe_account_id FROM users WHERE id = $1",
    [req.user!.id],
  );
  const accountId = rows[0]?.stripe_account_id ?? null;
  res.json({ has_account: Boolean(accountId), ready: await payoutsReady(accountId) });
});

/** Starts (or resumes) Stripe's hosted setup for the helper's payout account. */
profileRouter.post("/payout-account", requireUser, async (req, res) => {
  const { rows } = await pool.query<{ email: string; stripe_account_id: string | null }>(
    "SELECT email, stripe_account_id FROM users WHERE id = $1",
    [req.user!.id],
  );
  if (!rows[0]) throw new HttpError(404, "Account not found");
  const { url, accountId } = await startPayoutOnboarding(
    { id: req.user!.id, email: rows[0].email },
    rows[0].stripe_account_id,
    `${siteOrigin(req)}/?payouts=return`,
  );
  await pool.query("UPDATE users SET stripe_account_id = $2 WHERE id = $1", [req.user!.id, accountId]);
  res.json({ url });
});

/** Public community directory: only members who chose to be listed. Never includes email, birth date, ZIP, or address. */
export const membersRouter = Router();

const MEMBER_COLUMNS = `id, display_name, role_mode, city, state, bio, skills, tools,
  verification_status, founder_title`;

membersRouter.get("/", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT ${MEMBER_COLUMNS} FROM users
      WHERE profile_public = true AND verification_status <> 'rejected'
      ORDER BY founder_title IS NULL, display_name LIMIT 300`,
  );
  res.json({ members: rows.map(toPublicMember) });
});

membersRouter.get("/:id", async (req, res) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Member not found");
  const { rows } = await pool.query(
    `SELECT ${MEMBER_COLUMNS} FROM users
      WHERE id = $1 AND profile_public = true AND verification_status <> 'rejected'`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, "Member not found");
  res.json({ member: toPublicMember(rows[0]) });
});

function toPublicMember(r: Record<string, unknown>) {
  return {
    id: r.id,
    display_name: r.display_name,
    role_mode: r.role_mode,
    city: r.city,
    state: r.state,
    bio: r.bio,
    skills: r.skills,
    tools: r.tools,
    verified: r.verification_status === "verified",
    founder_title: r.founder_title,
  };
}
