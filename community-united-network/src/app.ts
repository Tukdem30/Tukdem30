import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadUser } from "./auth.js";
import { config } from "./config.js";
import { errorHandler, HttpError } from "./errors.js";
import { authRouter } from "./routes/auth.js";
import { profileRouter, foundersRouter } from "./routes/profile.js";
import { taskRouter } from "./routes/tasks.js";
import { adminRouter } from "./routes/admin.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          // Only force HTTPS subresources in production; local http dev would break otherwise.
          upgradeInsecureRequests: config.cookieSecure ? [] : null,
        },
      },
    }),
  );
  app.use(express.json({ limit: "64kb" }));
  app.use(express.static(publicDir));

  // Cross-site forms cannot send application/json without a CORS preflight,
  // which we never allow. Requiring JSON on writes is a cheap CSRF defense
  // on top of SameSite=Strict cookies.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !req.is("application/json")) {
      return next(new HttpError(415, "Requests must be JSON"));
    }
    next();
  });

  app.use(loadUser);

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    skip: () => process.env.NODE_ENV === "test",
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many attempts. Try again in a few minutes." },
  });
  app.use("/api/auth/login", authLimiter);
  app.use("/api/auth/register", authLimiter);

  app.use("/api/auth", authRouter);
  app.use("/api/me", profileRouter);
  app.use("/api/founders", foundersRouter);
  app.use("/api/tasks", taskRouter);
  app.use("/api/admin", adminRouter);

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "Not found")));
  app.use(errorHandler);
  return app;
}
