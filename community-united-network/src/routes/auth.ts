import { Router } from "express";
import { z } from "zod";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  getSessionToken,
  hashPassword,
  setSessionCookie,
  verifyPassword,
} from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db.js";
import { HttpError } from "../errors.js";

export const authRouter = Router();

const RoleMode = z.enum(["need_help", "can_help", "both"]);

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, "Use at least 10 characters").max(200),
  display_name: z.string().trim().min(2).max(80),
  date_of_birth: z.iso.date(),
  role_mode: RoleMode.default("both"),
});

function isAtLeast(age: number, dob: Date): boolean {
  const now = new Date();
  let years = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) years -= 1;
  return years >= age;
}

authRouter.post("/register", async (req, res) => {
  const input = registerSchema.parse(req.body);
  if (!isAtLeast(config.minimumAge, new Date(input.date_of_birth))) {
    throw new HttpError(403, `You must be at least ${config.minimumAge} to use this platform`);
  }
  const passwordHash = await hashPassword(input.password);
  let userId: string;
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, date_of_birth, role_mode)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.email, passwordHash, input.display_name, input.date_of_birth, input.role_mode],
    );
    userId = rows[0].id;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      // Generic message avoids confirming which emails already have accounts.
      throw new HttpError(409, "Could not create account with those details");
    }
    throw err;
  }
  const token = await createSession(userId);
  setSessionCookie(res, token);
  res.status(201).json({ id: userId });
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().max(200),
});

authRouter.post("/login", async (req, res) => {
  const input = loginSchema.parse(req.body);
  const { rows } = await pool.query<{ id: string; password_hash: string }>(
    "SELECT id, password_hash FROM users WHERE email = $1",
    [input.email],
  );
  const user = rows[0];
  // Verify against a dummy hash when the user is missing so timing does not reveal account existence.
  const ok = await verifyPassword(
    input.password,
    user?.password_hash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA",
  );
  if (!user || !ok) throw new HttpError(401, "Email or password is incorrect");
  const token = await createSession(user.id);
  setSessionCookie(res, token);
  res.json({ id: user.id });
});

authRouter.post("/logout", async (req, res) => {
  const token = getSessionToken(req);
  if (token) await destroySession(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});
