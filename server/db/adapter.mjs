/**
 * Database adapter layer.
 *
 * All DB modules (turns.mjs, analytics.mjs, …) use this interface instead of
 * calling better-sqlite3 directly. This lets the local build run SQLite while
 * the hosted build uses PostgreSQL — same code, different adapter.
 *
 * Interface:
 *   get(sql, params?)  → Promise<row | null>
 *   all(sql, params?)  → Promise<row[]>
 *   run(sql, params?)  → Promise<{ changes: number }>
 *   exec(sql)          → Promise<void>
 *   transaction(fn)    → Promise<T>  — fn(adapter) must be synchronous for SQLite
 *
 * SQL dialect: use ? placeholders everywhere (SQLite style).
 * The Postgres adapter converts ? → $1, $2, … automatically.
 */

/**
 * Wraps a better-sqlite3 Database as the shared async adapter.
 * All calls resolve synchronously (no real I/O latency added).
 * @param {import("better-sqlite3").Database} sqliteDb
 * @returns {DbAdapter}
 */
export function createSqliteAdapter(sqliteDb) {
  /** @type {DbAdapter} */
  const adapter = {
    async get(sql, params = []) {
      return sqliteDb.prepare(sql).get(...params) ?? null;
    },
    async all(sql, params = []) {
      return sqliteDb.prepare(sql).all(...params);
    },
    async run(sql, params = []) {
      const info = sqliteDb.prepare(sql).run(...params);
      return { changes: Number(info.changes) };
    },
    async exec(sql) {
      sqliteDb.exec(sql);
    },
    transaction(fn) {
      const tx = sqliteDb.transaction(() => fn(adapter));
      return Promise.resolve(tx());
    },
  };
  return adapter;
}

/**
 * Wraps a pg Pool as the shared async adapter.
 * ? placeholders are converted to $1, $2, … before sending to Postgres.
 * @param {import("pg").Pool} pool
 * @returns {DbAdapter}
 */
export function createPostgresAdapter(pool) {
  function toPositional(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  function makeClientAdapter(client) {
    /** @type {DbAdapter} */
    return {
      async get(sql, params = []) {
        const res = await client.query(toPositional(sql), params);
        return res.rows[0] ?? null;
      },
      async all(sql, params = []) {
        const res = await client.query(toPositional(sql), params);
        return res.rows;
      },
      async run(sql, params = []) {
        const res = await client.query(toPositional(sql), params);
        return { changes: res.rowCount ?? 0 };
      },
      async exec(sql) {
        await client.query(sql);
      },
      async transaction(fn) {
        return fn(this);
      },
    };
  }

  /** @type {DbAdapter} */
  const adapter = {
    async get(sql, params = []) {
      const res = await pool.query(toPositional(sql), params);
      return res.rows[0] ?? null;
    },
    async all(sql, params = []) {
      const res = await pool.query(toPositional(sql), params);
      return res.rows;
    },
    async run(sql, params = []) {
      const res = await pool.query(toPositional(sql), params);
      return { changes: res.rowCount ?? 0 };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(makeClientAdapter(client));
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
  };
  return adapter;
}

/**
 * @typedef {{
 *   get(sql: string, params?: unknown[]): Promise<Record<string, unknown> | null>,
 *   all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>,
 *   run(sql: string, params?: unknown[]): Promise<{ changes: number }>,
 *   exec(sql: string): Promise<void>,
 *   transaction<T>(fn: (adapter: DbAdapter) => T): Promise<T>,
 * }} DbAdapter
 */
