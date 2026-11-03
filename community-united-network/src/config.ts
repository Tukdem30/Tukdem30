export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/cun",
  /** Platform fee on paid-task transactions, in basis points (1500 = 15%). */
  platformFeeBps: 1500,
  /** Minimum age to use the platform. Minors are not supported in the MVP. */
  minimumAge: 18,
  sessionDays: 14,
  /** Dispute window after completion, in days. */
  disputeWindowDays: 7,
  cookieSecure: process.env.NODE_ENV === "production",
};
