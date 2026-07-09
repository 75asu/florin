import { Client } from 'pg';
import type { Connection } from '../store';
import type { Driver, FlorinNode, QueryResult, SchemaMap } from './types';

// Postgres driver, in-process (no language server). One short-lived Client per
// query keeps it simple; pooling can come later if it matters. Postgres
// connections are per-database, so when we descend into a database we reconnect
// to that database to read its schemas/tables/columns.
//
// We read the pg_catalog (pg_class / pg_attribute), NOT information_schema.
// information_schema is privilege-filtered: it only lists objects the current
// role has grants on, so a connection that can browse a database it doesn't own
// would see zero tables. pg_catalog shows the real structure regardless.
export class PgDriver implements Driver {
  constructor(
    private readonly conn: Connection,
    private readonly password: string | undefined,
  ) {}

  async children(node: FlorinNode): Promise<FlorinNode[]> {
    switch (node.kind) {
      case 'connection':
        return this.databases(node);
      case 'database':
        return this.schemas(node);
      case 'schema':
        return this.tables(node);
      case 'table':
        return this.columns(node);
      default:
        return [];
    }
  }

  async preview(node: FlorinNode, limit: number): Promise<QueryResult> {
    const ident = `${quoteIdent(node.schema!)}.${quoteIdent(node.table!)}`;
    return this.withClient(node.database!, (client) =>
      this.exec(client, `SELECT * FROM ${ident} LIMIT $1`, [limit]),
    );
  }

  // Run all statements on one connection inside a transaction (all-or-nothing).
  // Returns the last result set that had columns; otherwise an affected-rows
  // summary. Rolls back and rethrows on any error.
  runScript(database: string, statements: string[]): Promise<QueryResult> {
    return this.withClient(database, async (client) => {
      let last: QueryResult = { columns: [], rows: [], rowCount: 0 };
      let affected = 0;
      let sawResultSet = false;
      await client.query('BEGIN');
      try {
        for (const stmt of statements) {
          const r = await this.exec(client, stmt);
          if (r.columns.length) {
            last = r;
            sawResultSet = true;
          } else {
            affected += r.rowCount;
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
      return sawResultSet ? last : { columns: [], rows: [], rowCount: affected };
    });
  }

  async schema(database: string): Promise<SchemaMap> {
    const rows = await this.run<{ nspname: string; relname: string; attname: string }>(
      database,
      `SELECT n.nspname, c.relname, a.attname
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND a.attnum > 0 AND NOT a.attisdropped
         AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
       ORDER BY n.nspname, c.relname, a.attnum`,
    );
    const map: SchemaMap = {};
    for (const r of rows) {
      // Expose both the bare table and schema-qualified names for completion.
      (map[r.relname] ??= []).push(r.attname);
      const qualified = `${r.nspname}.${r.relname}`;
      (map[qualified] ??= []).push(r.attname);
    }
    return map;
  }

  async test(): Promise<void> {
    await this.withClient(this.conn.database, (client) => client.query('SELECT 1'));
  }

  private async exec(client: Client, sql: string, params: unknown[] = []): Promise<QueryResult> {
    const res = await client.query({ text: sql, values: params, rowMode: 'array' });
    const columns = res.fields.map((f) => f.name);
    const rows = res.rows as unknown[][];
    return { columns, rows, rowCount: res.rowCount ?? rows.length };
  }

  private async withClient<T>(database: string, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({
      host: this.conn.host,
      port: this.conn.port,
      user: this.conn.user,
      password: this.password,
      database,
      // ENCRYPTED_ONLY servers (e.g. Cloud SQL over WARP) reject plaintext.
      // rejectUnauthorized:false = encrypt without verifying the CA (no client
      // cert needed), which is the common managed-DB case.
      ssl: this.conn.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 8000,
      statement_timeout: 15000,
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  private run<T extends Record<string, unknown>>(
    database: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.withClient(database, async (client) => {
      const res = await client.query(sql, params);
      return res.rows as T[];
    });
  }

  private async databases(node: FlorinNode): Promise<FlorinNode[]> {
    // Scope to the connection's own database, exactly like SQLTools/Beekeeper.
    // Enumerating every database on the server lets the user drill into DBs
    // they have no SELECT grant on, producing confusing "permission denied".
    const rows = await this.run<{ datname: string }>(
      this.conn.database,
      `SELECT datname FROM pg_database
       WHERE datistemplate = false AND datallowconn = true AND datname = current_database()
       ORDER BY datname`,
    );
    return rows.map((r) => ({
      kind: 'database',
      label: r.datname,
      connectionId: node.connectionId,
      database: r.datname,
    }));
  }

  private async schemas(node: FlorinNode): Promise<FlorinNode[]> {
    const rows = await this.run<{ nspname: string }>(
      node.database!,
      `SELECT nspname FROM pg_namespace
       WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
       ORDER BY nspname`,
    );
    return rows.map((r) => ({
      kind: 'schema',
      label: r.nspname,
      connectionId: node.connectionId,
      database: node.database,
      schema: r.nspname,
    }));
  }

  private async tables(node: FlorinNode): Promise<FlorinNode[]> {
    const rows = await this.run<{ relname: string; relkind: string }>(
      node.database!,
      `SELECT c.relname, c.relkind
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       ORDER BY c.relname`,
      [node.schema],
    );
    return rows.map((r) => ({
      kind: 'table',
      label: r.relname,
      connectionId: node.connectionId,
      database: node.database,
      schema: node.schema,
      table: r.relname,
      detail: RELKIND_LABEL[r.relkind],
    }));
  }

  private async columns(node: FlorinNode): Promise<FlorinNode[]> {
    const rows = await this.run<{ attname: string; type: string; attnotnull: boolean }>(
      node.database!,
      `SELECT a.attname,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2
         AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [node.schema, node.table],
    );
    return rows.map((r) => ({
      kind: 'column',
      label: r.attname,
      connectionId: node.connectionId,
      database: node.database,
      schema: node.schema,
      table: node.table,
      detail: r.attnotnull ? `${r.type} not null` : r.type,
    }));
  }
}

// relkind -> a short right-aligned label; base tables get no tag.
const RELKIND_LABEL: Record<string, string | undefined> = {
  r: undefined,
  p: 'partitioned',
  v: 'view',
  m: 'matview',
  f: 'foreign',
};

// Double-quote a Postgres identifier, escaping embedded quotes.
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
