import { Router } from "express";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { pool } from "../db.js";
import { HttpError } from "../errors.js";
import { rankHelpers } from "../matching.js";
import { tagList, zip } from "../validation.js";

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
});

const PROFILE_COLUMNS = `id, display_name, role_mode, city, state, zip, bio, availability,
  skills, tools, verification_status, created_at`;

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
