import { z } from "zod";

/** Lowercased, de-duplicated list of skill or tool tags. */
export const tagList = z
  .array(z.string().trim().min(1).max(40))
  .max(50)
  .transform((tags) => [...new Set(tags.map((t) => t.toLowerCase()))]);

export const zip = z.string().trim().regex(/^\d{5}$/, "ZIP must be 5 digits");

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
