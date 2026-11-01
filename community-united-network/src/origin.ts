import type { Request } from "express";

/** Public site address used for Stripe return links. Uses APP_URL when set, otherwise the request host. */
export function siteOrigin(req: Request): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}
