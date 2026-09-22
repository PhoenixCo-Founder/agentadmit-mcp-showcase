// The scope catalog: one line per risk level, exactly what the user sees on
// the hosted consent page. Tool → scope mapping lives next to it.
export const SCOPES = [
  { name: 'db:read', description: 'List tables and run read-only SELECT queries', category: 'Database' },
  { name: 'db:write', description: 'Insert rows into existing tables', category: 'Database' },
  { name: 'db:delete', description: 'Delete rows or drop whole tables (irreversible)', category: 'Database', confirm_each_time: true },
];

export const TOOL_SCOPE = {
  list_tables: 'db:read',
  run_query: 'db:read',
  insert_row: 'db:write',
  delete_rows: 'db:delete',
  drop_table: 'db:delete',
};

export const ALL_SCOPES = SCOPES.map((s) => s.name);
export const RECOMMENDED_SCOPES = ['db:read'];
