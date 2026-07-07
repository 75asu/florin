// Split a SQL script into individual statements on top-level semicolons, while
// ignoring ';' that appears inside single-quoted strings, double-quoted
// identifiers, line/block comments, and dollar-quoted blocks ($tag$...$tag$).
// Good enough for hand-written admin scripts; not a full SQL parser.
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  const n = sql.length;
  let i = 0;

  while (i < n) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    if (two === '/*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const q = ch;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === q && sql[j + 1] === q) {
          j += 2; // escaped quote ('' or "")
          continue;
        }
        if (sql[j] === q) {
          j++;
          break;
        }
        j++;
      }
      cur += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '$') {
      const m = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        cur += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    if (ch === ';') {
      if (cur.trim()) {
        out.push(cur.trim());
      }
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }

  if (cur.trim()) {
    out.push(cur.trim());
  }
  return out;
}
