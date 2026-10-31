import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { type Db, pool } from "./db.js";
import { HttpError } from "./errors.js";

const scryptAsync = promisify(_scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const COOKIE = "cun_session";

export interface AuthUser {
  id: string;
  is_admin: boolean;
  verification_status: string;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(expected, actual);
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Only the hash of the session token is stored, so a database leak does not expose live sessions. */
export async function createSession(userId: string, db: Db = pool): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), userId, config.sessionDays],
  );
  return token;
}

export async function destroySession(token: string): Promise<void> {
  await pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.cookieSecure,
    path: "/",
    maxAge: config.sessionDays * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE, { path: "/", sameSite: "strict", secure: config.cookieSecure });
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function getSessionToken(req: Request): string | undefined {
  return readCookie(req.headers.cookie, COOKIE);
}

/** Attaches req.user when a valid session cookie is present. Never rejects by itself. */
export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = getSessionToken(req);
  if (!token) return next();
  const { rows } = await pool.query<AuthUser>(
    `SELECT u.id, u.is_admin, u.verification_status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  if (rows[0]) req.user = rows[0];
  next();
}

export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new HttpError(401, "Please log in"));
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user?.is_admin) return next(new HttpError(403, "Admins only"));
  next();
}

export function requireVerified(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.verification_status !== "verified") {
    return next(new HttpError(403, "Identity verification is required before you can help on tasks"));
  }
  next();
}
