// Demo database: node:sqlite (built into Node 22.13+, no native build step).
import { DatabaseSync } from 'node:sqlite';

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

export function seed(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, plan TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), total_cents INTEGER NOT NULL, status TEXT NOT NULL);
  `);
  const n = db.prepare('SELECT count(*) AS n FROM customers').get().n;
  if (n > 0) return;
  const c = db.prepare('INSERT INTO customers (name, email, plan) VALUES (?, ?, ?)');
  for (const [name, email, plan] of [
    ['Ada Lovelace', 'ada@example.com', 'pro'], ['Grace Hopper', 'grace@example.com', 'builder'],
    ['Linus Torvalds', 'linus@example.com', 'starter'], ['Margaret Hamilton', 'margaret@example.com', 'pro'],
    ['Ken Thompson', 'ken@example.com', 'builder'], ['Barbara Liskov', 'barbara@example.com', 'starter'],
  ]) c.run(name, email, plan);
  const o = db.prepare('INSERT INTO orders (customer_id, total_cents, status) VALUES (?, ?, ?)');
  for (const [cid, cents, status] of [[1, 20000, 'paid'], [1, 5000, 'refunded'], [2, 10000, 'paid'], [3, 5000, 'paid'], [4, 20000, 'pending'], [5, 10000, 'paid'], [6, 5000, 'paid']]) o.run(cid, cents, status);
}

const READ_ONLY = /^\s*(SELECT|WITH|EXPLAIN|PRAGMA table_info)\b/i;
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|VACUUM|PRAGMA\s+(?!table_info))\b/i;

export function runQuery(db, sql) {
  if (!READ_ONLY.test(sql) || FORBIDDEN.test(sql)) {
    throw new Error('run_query accepts a single read-only statement (SELECT/WITH). Use insert_row, delete_rows, or drop_table for changes.');
  }
  return db.prepare(sql).all();
}

export function listTables(db) {
  return db.prepare("SELECT name, (SELECT count(*) FROM sqlite_master m2 WHERE m2.tbl_name = m.name AND m2.type='index') AS indexes FROM sqlite_master m WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map((t) => ({ ...t, rows: db.prepare(`SELECT count(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).get().n }));
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function assertIdent(name, what) {
  if (!IDENT.test(name)) throw new Error(`${what} must be a plain identifier`);
  return name;
}

export function insertRow(db, table, data) {
  assertIdent(table, 'table');
  const cols = Object.keys(data);
  if (cols.length === 0) throw new Error('data must have at least one column');
  cols.forEach((c) => assertIdent(c, 'column'));
  const stmt = db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  const info = stmt.run(...cols.map((c) => data[c]));
  return { inserted: Number(info.changes), id: Number(info.lastInsertRowid) };
}

export function countWhere(db, table, where) {
  assertIdent(table, 'table');
  if (FORBIDDEN.test(where) || /;/.test(where)) throw new Error('where must be a plain predicate');
  return db.prepare(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`).get().n;
}

export function deleteRows(db, table, where) {
  assertIdent(table, 'table');
  if (FORBIDDEN.test(where) || /;/.test(where)) throw new Error('where must be a plain predicate');
  const info = db.prepare(`DELETE FROM "${table}" WHERE ${where}`).run();
  return { deleted: Number(info.changes) };
}

export function dropTable(db, table) {
  assertIdent(table, 'table');
  const rows = db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n;
  db.exec(`DROP TABLE "${table}"`);
  return { dropped: table, rows_lost: rows };
}
