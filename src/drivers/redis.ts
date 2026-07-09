import { Redis, type RedisOptions } from 'ioredis';
import type { Connection } from '../store';
import type { Driver, FlorinNode, QueryResult, SchemaMap } from './types';

// Redis driver, in-process. One short-lived client per operation, mirroring the
// Postgres driver's model. Redis has no schemas/tables; it maps onto the tree as
// connection -> keyspace (logical DB 0..15) -> keyprefix (':'-delimited folders,
// RedisInsight-style) -> key. Values are read into the same results grid the
// SQL console uses. The console's Run also works: each line is parsed as a raw
// Redis command (GET, HGETALL, ...) so the panel isn't dead for Redis.
const SCAN_CAP = 5000; // most keys surfaced per folder before we stop paging
const SCAN_COUNT = 500; // SCAN batch hint

export class RedisDriver implements Driver {
  constructor(
    private readonly conn: Connection,
    private readonly password: string | undefined,
  ) {}

  async children(node: FlorinNode): Promise<FlorinNode[]> {
    switch (node.kind) {
      case 'connection':
        return this.keyspaces(node);
      case 'keyspace':
        return this.keys(node, node.database ?? String(this.defaultDb), '');
      case 'keyprefix':
        return this.keys(node, node.database ?? String(this.defaultDb), node.prefix ?? '');
      default:
        return [];
    }
  }

  // Read a single key's value into the results grid, shaped per Redis type.
  async preview(node: FlorinNode, limit: number): Promise<QueryResult> {
    const db = Number(node.database ?? this.defaultDb) || 0;
    const key = node.key ?? node.label;
    return this.withClient(db, async (r) => {
      const type = await r.type(key);
      switch (type) {
        case 'string': {
          const v = await r.get(key);
          return { columns: ['value'], rows: v === null ? [] : [[v]], rowCount: v === null ? 0 : 1 };
        }
        case 'hash': {
          const h = await r.hgetall(key);
          const rows = Object.entries(h);
          return { columns: ['field', 'value'], rows, rowCount: rows.length };
        }
        case 'list': {
          const items = await r.lrange(key, 0, limit - 1);
          const rows = items.map((v, i) => [i, v]);
          return { columns: ['index', 'value'], rows, rowCount: rows.length };
        }
        case 'set': {
          const items = await r.smembers(key);
          const rows = items.slice(0, limit).map((v) => [v]);
          return { columns: ['member'], rows, rowCount: rows.length };
        }
        case 'zset': {
          const items = await r.zrange(key, 0, limit - 1, 'WITHSCORES');
          const rows: unknown[][] = [];
          for (let i = 0; i < items.length; i += 2) {
            rows.push([items[i], items[i + 1]]);
          }
          return { columns: ['member', 'score'], rows, rowCount: rows.length };
        }
        case 'stream': {
          const entries = await r.xrange(key, '-', '+', 'COUNT', limit);
          const rows = entries.map(([id, fields]) => [id, JSON.stringify(fields)]);
          return { columns: ['id', 'fields'], rows, rowCount: rows.length };
        }
        case 'none':
          return { columns: ['value'], rows: [], rowCount: 0 };
        default:
          return { columns: ['type'], rows: [[type]], rowCount: 1 };
      }
    });
  }

  // Run each line as a raw Redis command against the given logical DB. Not
  // transactional (Redis single commands are atomic); returns the last reply.
  async runScript(database: string, statements: string[]): Promise<QueryResult> {
    const db = Number(database) || 0;
    return this.withClient(db, async (r) => {
      let last: QueryResult = { columns: [], rows: [], rowCount: 0 };
      for (const stmt of statements) {
        const parts = tokenize(stmt);
        if (parts.length === 0) {
          continue;
        }
        const [cmd, ...args] = parts;
        const reply = await r.call(cmd, ...args);
        last = formatReply(reply);
      }
      return last;
    });
  }

  // Redis has no static schema to autocomplete against.
  async schema(): Promise<SchemaMap> {
    return {};
  }

  async test(): Promise<void> {
    await this.withClient(this.defaultDb, (r) => r.ping());
  }

  private get defaultDb(): number {
    const n = Number.parseInt(this.conn.database ?? '', 10);
    return Number.isFinite(n) ? n : 0;
  }

  private async keyspaces(node: FlorinNode): Promise<FlorinNode[]> {
    // INFO keyspace lists only non-empty DBs (db0:keys=3,expires=0,...). Always
    // include the connection's own DB so an empty instance still browses.
    const info = await this.withClient(this.defaultDb, (r) => r.info('keyspace'));
    const counts = new Map<number, number>();
    for (const line of info.split('\n')) {
      const m = line.match(/^db(\d+):keys=(\d+)/);
      if (m) {
        counts.set(Number(m[1]), Number(m[2]));
      }
    }
    if (!counts.has(this.defaultDb)) {
      counts.set(this.defaultDb, 0);
    }
    return [...counts.keys()]
      .sort((a, b) => a - b)
      .map((db) => ({
        kind: 'keyspace' as const,
        label: `db${db}`,
        connectionId: node.connectionId,
        database: String(db),
        detail: `${counts.get(db)} keys`,
      }));
  }

  // Group the keys under `prefix` by their next ':'-delimited segment: segments
  // with more depth become folders (keyprefix), the rest are leaf keys.
  private async keys(node: FlorinNode, dbStr: string, prefix: string): Promise<FlorinNode[]> {
    const db = Number(dbStr) || 0;
    const { keys, capped } = await this.withClient(db, (r) => scan(r, `${prefix}*`, SCAN_CAP));

    const folders = new Map<string, number>();
    const leaves: string[] = [];
    for (const key of keys) {
      const rest = key.slice(prefix.length);
      const i = rest.indexOf(':');
      if (i === -1) {
        leaves.push(key);
      } else {
        const seg = rest.slice(0, i + 1); // keep the trailing ':'
        folders.set(seg, (folders.get(seg) ?? 0) + 1);
      }
    }

    const out: FlorinNode[] = [];
    for (const [seg, count] of [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push({
        kind: 'keyprefix',
        label: seg,
        connectionId: node.connectionId,
        database: dbStr,
        prefix: prefix + seg,
        detail: `${count}`,
      });
    }
    for (const key of leaves.sort()) {
      out.push({
        kind: 'key',
        label: prefix ? key.slice(prefix.length) : key,
        connectionId: node.connectionId,
        database: dbStr,
        key,
      });
    }
    if (capped) {
      out.push({
        kind: 'message',
        label: `Showing first ${SCAN_CAP} keys , more exist`,
        connectionId: node.connectionId,
        detail: `SCAN capped at ${SCAN_CAP} for pattern ${prefix}*`,
      });
    }
    return out;
  }

  private async withClient<T>(db: number, fn: (r: Redis) => Promise<T>): Promise<T> {
    const useTls = this.conn.ssl || this.conn.driver === 'rediss';
    const opts: RedisOptions = {
      host: this.conn.host,
      port: this.conn.port,
      username: this.conn.user || undefined,
      password: this.password || undefined,
      db,
      tls: useTls ? { rejectUnauthorized: false } : undefined,
      lazyConnect: true,
      connectTimeout: 8000,
      commandTimeout: 15000,
      maxRetriesPerRequest: 1,
      // Fail fast instead of looping reconnects when the host is unreachable.
      retryStrategy: () => null,
    };
    const client = new Redis(opts);
    // Swallow async 'error' events; connect()/commands still reject, and an
    // unhandled 'error' would otherwise crash the extension host.
    client.on('error', () => undefined);
    try {
      await client.connect();
      return await fn(client);
    } finally {
      client.disconnect();
    }
  }
}

// SCAN the keyspace for a MATCH pattern, paging until the cursor wraps or we hit
// `cap`. Stateless per call, matching florin's short-lived-client model.
async function scan(r: Redis, match: string, cap: number): Promise<{ keys: string[]; capped: boolean }> {
  let cursor = '0';
  const keys: string[] = [];
  do {
    const [next, batch] = await r.scan(cursor, 'MATCH', match, 'COUNT', SCAN_COUNT);
    cursor = next;
    for (const k of batch) {
      keys.push(k);
      if (keys.length >= cap) {
        return { keys, capped: true };
      }
    }
  } while (cursor !== '0');
  return { keys, capped: false };
}

// Split a command line into tokens, honouring single/double quotes so keys with
// spaces work: HGETALL "some key" -> ["HGETALL", "some key"].
function tokenize(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

// Shape a raw RESP reply into the results grid.
function formatReply(reply: unknown): QueryResult {
  if (reply === null || reply === undefined) {
    return { columns: ['reply'], rows: [], rowCount: 0 };
  }
  if (Array.isArray(reply)) {
    const rows = reply.map((v) => [v !== null && typeof v === 'object' ? JSON.stringify(v) : v]);
    return { columns: ['value'], rows, rowCount: rows.length };
  }
  if (typeof reply === 'object') {
    const rows = Object.entries(reply as Record<string, unknown>);
    return { columns: ['field', 'value'], rows, rowCount: rows.length };
  }
  return { columns: ['reply'], rows: [[reply]], rowCount: 1 };
}
