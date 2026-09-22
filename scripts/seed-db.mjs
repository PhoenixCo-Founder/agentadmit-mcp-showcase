#!/usr/bin/env node
import { openDb, seed, listTables } from '../src/db.mjs';
const path = process.env.DEMO_DB_PATH || 'demo.db';
const db = openDb(path);
seed(db);
console.log(`seeded ${path}:`, listTables(db));
