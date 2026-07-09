import type { Connection } from '../store';
import type { Driver } from './types';
import { PgDriver } from './pg';
import { RedisDriver } from './redis';

// Resolve the right driver for a connection. Add a case per engine as we grow
// (sqlite, mysql, ...); the tree code stays untouched.
export function getDriver(conn: Connection, password: string | undefined): Driver {
  switch (conn.driver) {
    case 'postgres':
    case 'postgresql':
      return new PgDriver(conn, password);
    case 'redis':
    case 'rediss':
      return new RedisDriver(conn, password);
    default:
      throw new Error(`no driver for "${conn.driver}" yet`);
  }
}

export type { Driver, FlorinNode, NodeKind } from './types';
