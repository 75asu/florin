// Engine-agnostic browse tree. Every DB engine (Postgres today, Redis/SQLite
// later) maps its own hierarchy onto these node kinds. The tree just asks a
// driver "what are the children of this node?" and never knows the engine.

// 'message' is a synthetic leaf used to surface errors (e.g. a dropped tunnel)
// inline in the tree instead of silently showing an empty node.
export type NodeKind = 'connection' | 'database' | 'schema' | 'table' | 'column' | 'message';

export interface FlorinNode {
  kind: NodeKind;
  label: string;
  connectionId: string;
  // Path context, filled in as we descend. A column node carries all of them.
  database?: string;
  schema?: string;
  table?: string;
  // Right-aligned hint in the tree (column type, "view", etc.).
  detail?: string;
}

// A tabular result set, engine-agnostic. rows are aligned to columns by index.
export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
}

// table (or schema.table) -> its column names, for editor autocomplete.
export type SchemaMap = Record<string, string[]>;

export interface Driver {
  // Given a node, return the next level down. Called lazily as the user expands.
  children(node: FlorinNode): Promise<FlorinNode[]>;
  // Preview the first `limit` rows of a table/view node.
  preview(node: FlorinNode, limit: number): Promise<QueryResult>;
  // Run one or more statements against a database, in a single transaction.
  // Returns the last statement's result set (or an affected-rows summary).
  runScript(database: string, statements: string[]): Promise<QueryResult>;
  // Full table+column map of a database, for autocomplete.
  schema(database: string): Promise<SchemaMap>;
}
