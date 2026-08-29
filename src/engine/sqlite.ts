// SQLite wrapper over Android SQLiteDatabase via Java bridge.
// Defensive notes (learned the hard way):
// - JS numbers bound into execSQL Object[] can silently become NULL -> bind as string (SQLite type affinity).
// - getLong() returns BigInt -> always wrap with Number().
// - is_binary is compared by content equality instead of the flag to dodge bridge-handle flakiness.

export interface SqlRow {
  [key: string]: any;
}

export function openDb(dbPath: string): any {
  const SQLiteDatabase = (Java as any).type('android.database.sqlite.SQLiteDatabase');
  return SQLiteDatabase.openOrCreateDatabase(dbPath, null);
}

export function dbExec(db: any, sql: string, args?: any[]): void {
  if (args && args.length) {
    const binds = args.map(function (v: any) {
      if (typeof v === 'number') return String(v);
      return v;
    });
    db.execSQL(sql, binds);
  } else {
    db.execSQL(sql);
  }
}

export function dbQuery(db: any, sql: string, args?: any[]): SqlRow[] {
  let binds: any[] | null = null;
  if (args && args.length) {
    binds = args.map(function (v: any) {
      // Same bridge hardening as dbExec: bind numbers as strings, and fail
      // loudly on null/undefined instead of letting rawQuery swallow them.
      if (v === null || v === undefined) throw new Error('Null bind value in query: ' + sql);
      if (typeof v === 'number') return String(v);
      return v;
    });
  }
  const cur = binds ? db.rawQuery(sql, binds) : db.rawQuery(sql, null);
  const rows: SqlRow[] = [];
  try {
    if (cur.moveToFirst()) {
      const cols: string[] = [];
      for (let i = 0; i < cur.getColumnCount(); i++) cols.push(String(cur.getColumnName(i)));
      do {
        const row: SqlRow = {};
        for (let i = 0; i < cols.length; i++) {
          const c = cols[i];
          const t = cur.getType(i);
          if (t === 0) row[c] = null;
          else if (t === 1) row[c] = Number(cur.getLong(i)); // long -> BigInt -> number
          else if (t === 2) row[c] = cur.getDouble(i);
          else if (t === 3) row[c] = cur.getString(i);
          else row[c] = cur.getBlob(i);
        }
        rows.push(row);
      } while (cur.moveToNext());
    }
  } finally {
    cur.close();
  }
  return rows;
}

export function dbInsert(db: any, table: string, fields: { [key: string]: any }): number {
  const ContentValues = (Java as any).type('android.content.ContentValues');
  const cv = ContentValues.newInstance();
  const keys = Object.keys(fields);
  for (const k of keys) {
    const v = fields[k];
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') cv.put(k, String(v));
    else if (typeof v === 'boolean') cv.put(k, v ? 1 : 0);
    else cv.put(k, String(v));
  }
  return Number(db.insert(table, null, cv));
}

export async function withTx(db: any, fn: () => Promise<any> | any): Promise<any> {
  db.beginTransaction();
  try {
    const result = await fn();
    db.setTransactionSuccessful();
    return result;
  } finally {
    db.endTransaction();
  }
}

export function dbClose(db: any): void {
  try { db.close(); } catch (e) { /* ignore */ }
}

export function ensureSchema(db: any): void {
  dbExec(db, 'CREATE TABLE IF NOT EXISTS snapshots (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'version_id INTEGER NOT NULL UNIQUE,' +
    'display_version TEXT NOT NULL UNIQUE,' +
    'description TEXT DEFAULT \'\',' +
    'author TEXT DEFAULT \'\',' +
    'created_at TEXT NOT NULL,' +
    'parent_id INTEGER)');
  dbExec(db, 'CREATE TABLE IF NOT EXISTS snapshot_files (' +
    'snapshot_id INTEGER NOT NULL,' +
    'mount TEXT NOT NULL,' +
    'rel_path TEXT NOT NULL,' +
    'change_type TEXT NOT NULL,' +
    'is_binary INTEGER DEFAULT 0,' +
    'content TEXT,' +
    'PRIMARY KEY (snapshot_id, mount, rel_path))');
  dbExec(db, 'CREATE INDEX IF NOT EXISTS idx_sf_snap ON snapshot_files(snapshot_id)');
  dbExec(db, 'CREATE TABLE IF NOT EXISTS staging (' +
    'mount TEXT NOT NULL,' +
    'rel_path TEXT NOT NULL,' +
    'content TEXT,' +
    'is_binary INTEGER DEFAULT 0,' +
    'state TEXT NOT NULL,' +
    'updated_at TEXT NOT NULL,' +
    'PRIMARY KEY (mount, rel_path))');
  dbExec(db, 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
}