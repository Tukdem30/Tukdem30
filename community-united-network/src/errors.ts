import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { TransitionError } from "./domain.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Last-resort handler. Internal details are logged server-side, never sent to the client. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Invalid input",
      details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof TransitionError) {
    res.status(409).json({ error: err.message });
    return;
  }
  console.error("Unhandled error:", err instanceof Error ? err.message : "unknown");
  res.status(500).json({ error: "Something went wrong" });
}
