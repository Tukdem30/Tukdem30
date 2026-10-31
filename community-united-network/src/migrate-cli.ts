import { migrate, pool } from "./db.js";

await migrate();
console.log("Schema is up to date.");
await pool.end();
