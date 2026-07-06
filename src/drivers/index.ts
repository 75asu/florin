import type { Connection } from '../store';
import type { Driver } from './types';
import { PgDriver } from './pg';

// Resolve the right driver for a connection. Add a case per engine as we grow
// (redis, sqlite, ...); the tree code stays untouched.
export function getDriver(conn: Connection, password: string | undefined): Driver {
  switch (conn.driver) {
    case 'postgres':
    case 'postgresql':
      return new PgDriver(conn, password);
    default:
      throw new Error(`no driver for "${conn.driver}" yet`);
  }
}

export type { Driver, FlorinNode, NodeKind } from './types';
