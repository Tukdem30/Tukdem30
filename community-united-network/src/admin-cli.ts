// Usage: npm run make-admin -- you@example.com
// Grants admin rights and marks the account identity-verified. Use only for the operator's own account in dev.
import { pool, migrate } from "./db.js";

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("Usage: npm run make-admin -- you@example.com");
  process.exit(1);
}
await migrate();
const { rowCount } = await pool.query(
  "UPDATE users SET is_admin = true, verification_status = 'verified' WHERE email = $1",
  [email],
);
await pool.end();
if (!rowCount) {
  console.error("No account with that email. Register it in the app first.");
  process.exit(1);
}
console.log("Admin granted and account verified.");
