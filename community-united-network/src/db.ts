import pg from "pg";
import { config } from "./config.js";
import { SCHEMA_SQL } from "./schema.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

/** Either the shared pool or a checked-out client inside a transaction. */
export type Db = pg.Pool | pg.PoolClient;

export async function migrate(db: Db = pool): Promise<void> {
  await db.query(SCHEMA_SQL);
}

/** Runs fn inside a transaction, rolling back on any thrown error. */
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
