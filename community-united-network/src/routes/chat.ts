import { Router } from "express";
import { z } from "zod";
import type { AuthUser } from "../auth.js";
import { requireUser, requireVerified } from "../auth.js";
import { pool, withTx } from "../db.js";
import { HttpError } from "../errors.js";
import { translateText, translationEnabled } from "../translate.js";
import { UUID_RE } from "../validation.js";

/**
 * Member-to-member messages. Rules: both people verified, the recipient is in the community directory,
 * neither has blocked the other. Phone numbers and email addresses are not allowed in messages.
 * Messages are translated into each reader's language when translation is turned on.
 */
export const chatRouter = Router();
chatRouter.use(requireUser, requireVerified);

const MAX_MESSAGES_PER_10_MIN = 30;

const messageSchema = z.object({ body: z.string().trim().min(1).max(2000) });
const memberSchema = z.object({ member_id: z.string().regex(UUID_RE, "Choose a member") });
const reportSchema = z.object({ reason: z.string().trim().min(3).max(500) });

function assertUuid(id: string): void {
  if (!UUID_RE.test(id)) throw new HttpError(404, "Not found");
}

/** True when the text includes an email address or a phone number. */
export function containsContactDetails(text: string): boolean {
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) return true;
  const runs = text.match(/\+?\d[\d\s().-]{5,}\d/g) ?? [];
  return runs.some((run) => run.replace(/\D/g, "").length >= 7);
}

async function assertCanMessage(senderId: string, recipientId: string): Promise<void> {
  const { rows } = await pool.query<{ verification_status: string; profile_public: boolean }>(
    "SELECT verification_status, profile_public FROM users WHERE id = $1",
    [recipientId],
  );
  const other = rows[0];
  if (!other) throw new HttpError(404, "Member not found");
  if (other.verification_status !== "verified" || !other.profile_public) {
    throw new HttpError(403, "This member is not open to messages");
  }
  const blocked = await pool.query(
    `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
    [senderId, recipientId],
  );
  if ((blocked.rowCount ?? 0) > 0) throw new HttpError(403, "You can't message this member");
}

async function requireParticipant(userId: string, conversationId: string): Promise<{ member_a: string; member_b: string }> {
  assertUuid(conversationId);
  const { rows } = await pool.query<{ member_a: string; member_b: string }>(
    "SELECT member_a, member_b FROM conversations WHERE id = $1 AND (member_a = $2 OR member_b = $2)",
    [conversationId, userId],
  );
  if (!rows[0]) throw new HttpError(404, "Conversation not found");
  return rows[0];
}

function otherMember(conv: { member_a: string; member_b: string }, me: string): string {
  return conv.member_a === me ? conv.member_b : conv.member_a;
}

async function languageOf(userId: string): Promise<string> {
  const { rows } = await pool.query<{ language: string }>("SELECT language FROM users WHERE id = $1", [userId]);
  return rows[0]?.language ?? "en";
}

chatRouter.get("/conversations", async (req, res) => {
  const me = req.user!.id;
  const { rows } = await pool.query(
    `SELECT c.id, u.id AS member_id, u.display_name,
            (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_at
       FROM conversations c
       JOIN users u ON u.id = CASE WHEN c.member_a = $1 THEN c.member_b ELSE c.member_a END
      WHERE c.member_a = $1 OR c.member_b = $1
      ORDER BY last_at DESC NULLS LAST LIMIT 100`,
    [me],
  );
  res.json({ conversations: rows });
});

chatRouter.post("/conversations", async (req, res) => {
  const { member_id } = memberSchema.parse(req.body);
  const me = req.user!.id;
  if (member_id === me) throw new HttpError(400, "You can't message yourself");
  await assertCanMessage(me, member_id);
  const [a, b] = [me.toLowerCase(), member_id.toLowerCase()].sort();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO conversations (member_a, member_b) VALUES ($1, $2)
     ON CONFLICT (member_a, member_b) DO UPDATE SET member_a = EXCLUDED.member_a
     RETURNING id`,
    [a, b],
  );
  res.status(201).json({ id: rows[0].id });
});

/** Shows each message in the reader's language. Keeps the original, and caches translations. */
async function presentMessages(
  messages: Array<{ id: string; sender_id: string; body: string; source_lang: string; created_at: Date }>,
  me: AuthUser,
  readerLang: string,
) {
  const out = [];
  for (const m of messages) {
    let body = m.body;
    let translated = false;
    if (translationEnabled() && m.source_lang !== readerLang) {
      const cached = await pool.query<{ body: string }>(
        "SELECT body FROM message_translations WHERE message_id = $1 AND target_lang = $2",
        [m.id, readerLang],
      );
      if (cached.rows[0]) {
        body = cached.rows[0].body;
        translated = true;
      } else {
        try {
          body = await translateText(m.body, readerLang, m.source_lang);
          translated = true;
          await pool.query(
            "INSERT INTO message_translations (message_id, target_lang, body) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            [m.id, readerLang, body],
          );
        } catch {
          body = m.body; // Show the original if translation is unavailable.
        }
      }
    }
    out.push({
      id: m.id,
      mine: m.sender_id === me.id,
      body,
      original: m.body,
      source_lang: m.source_lang,
      translated,
      created_at: m.created_at,
    });
  }
  return out;
}

chatRouter.get("/conversations/:id/messages", async (req, res) => {
  const id = String(req.params.id);
  await requireParticipant(req.user!.id, id);
  const { rows } = await pool.query(
    `SELECT id, sender_id, body, source_lang, created_at FROM messages
      WHERE conversation_id = $1 ORDER BY id DESC LIMIT 50`,
    [id],
  );
  const readerLang = await languageOf(req.user!.id);
  const messages = await presentMessages(rows.reverse(), req.user!, readerLang);
  res.json({ messages, reader_language: readerLang, translation_on: translationEnabled() });
});

chatRouter.post("/conversations/:id/messages", async (req, res) => {
  const id = String(req.params.id);
  const conv = await requireParticipant(req.user!.id, id);
  const { body } = messageSchema.parse(req.body);
  if (containsContactDetails(body)) {
    throw new HttpError(400, "For your privacy, keep phone numbers and email addresses out of messages. Use the app to talk.");
  }
  const other = otherMember(conv, req.user!.id);
  await assertCanMessage(req.user!.id, other);

  const senderLang = await languageOf(req.user!.id);
  const message = await withTx(async (c) => {
    const { rows: recent } = await c.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM messages WHERE sender_id = $1 AND created_at > now() - interval '10 minutes'",
      [req.user!.id],
    );
    if (Number(recent[0].n) >= MAX_MESSAGES_PER_10_MIN) {
      throw new HttpError(429, "You're sending messages too quickly. Try again in a few minutes.");
    }
    const { rows } = await c.query(
      `INSERT INTO messages (conversation_id, sender_id, body, source_lang) VALUES ($1, $2, $3, $4)
       RETURNING id, sender_id, body, source_lang, created_at`,
      [id, req.user!.id, body, senderLang],
    );
    return rows[0];
  });
  const [presented] = await presentMessages([message], req.user!, senderLang);
  res.status(201).json(presented);
});

chatRouter.post("/blocks", async (req, res) => {
  const { member_id } = memberSchema.parse(req.body);
  if (member_id === req.user!.id) throw new HttpError(400, "You can't block yourself");
  await pool.query(
    "INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [req.user!.id, member_id],
  );
  res.status(201).json({ ok: true });
});

chatRouter.delete("/blocks/:member_id", async (req, res) => {
  const memberId = String(req.params.member_id);
  assertUuid(memberId);
  await pool.query("DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2", [req.user!.id, memberId]);
  res.json({ ok: true });
});

chatRouter.post("/messages/:id/report", async (req, res) => {
  const messageId = Number(req.params.id);
  if (!Number.isInteger(messageId) || messageId < 1) throw new HttpError(404, "Message not found");
  const { reason } = reportSchema.parse(req.body);
  const { rows } = await pool.query<{ conversation_id: string }>(
    `SELECT m.conversation_id FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND (c.member_a = $2 OR c.member_b = $2)`,
    [messageId, req.user!.id],
  );
  if (!rows[0]) throw new HttpError(404, "Message not found");
  await pool.query(
    "INSERT INTO message_reports (message_id, reporter_id, reason) VALUES ($1, $2, $3)",
    [messageId, req.user!.id, reason],
  );
  res.status(201).json({ ok: true });
});
