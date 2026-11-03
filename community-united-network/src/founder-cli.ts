// Usage: npm run set-founder -- you@example.com "Co-founder"
// Sets the founder title shown on the front page. Run by the operator only.
import { migrate, pool } from "./db.js";

const email = process.argv[2]?.trim().toLowerCase();
const title = process.argv[3]?.trim();
if (!email || !title) {
  console.error('Usage: npm run set-founder -- you@example.com "Co-founder"');
  process.exit(1);
}
await migrate();
const { rowCount } = await pool.query("UPDATE users SET founder_title = $2 WHERE email = $1", [email, title]);
await pool.end();
if (!rowCount) {
  console.error("No account with that email. Have them register first.");
  process.exit(1);
}
console.log(`Founder title set: ${title}`);
