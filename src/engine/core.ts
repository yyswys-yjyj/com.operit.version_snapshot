// Snapshot query engine: file-state lookup, tree rebuild, commit/show/list/diff.

import {
  openDb, dbQuery, dbExec, dbInsert, dbClose, dbClose as _dc, ensureSchema, withTx, SqlRow,
} from './sqlite';
import { requireProject, normalizeMounts, parseRelPath } from './paths';
import { nowIso } from './base64';
import { packDr, getFinalContent, getOriginalContent } from './format';
import type { Manifest } from './paths';
export { dbClose };

const dbListSnapshots = (db: any) =>
  dbQuery(db, 'SELECT id, version_id, display_version, description, author, created_at, parent_id FROM snapshots ORDER BY id DESC');

function findSnapshotByDisplay(db: any, displayVersion: string): SqlRow {
  const rows = dbQuery(db, 'SELECT id, version_id, display_version FROM snapshots WHERE display_version=? LIMIT 1', [displayVersion]);
  if (!rows.length) throw new Error('Version not found: ' + displayVersion);
  return rows[0];
}

function findFileRecord(db: any, snapshotId: number, mount: string, relPath: string): SqlRow | null {
  const rows = dbQuery(db, 'SELECT * FROM snapshot_files WHERE mount=? AND rel_path=? AND snapshot_id<=? ORDER BY snapshot_id DESC LIMIT 1',
    [mount, relPath, snapshotId]);
  return rows.length ? rows[0] : null;
}

// File state at a given snapshot; deleted records -> exists=false.
function fileStateAt(db: any, snapshotId: number, mount: string, relPath: string): { exists: boolean; isBinary: number; content: string } {
  const rec = findFileRecord(db, snapshotId, mount, relPath);
  if (!rec) return { exists: false, isBinary: 0, content: '' };
  if (rec.change_type === 'delete' || rec.change_type === 'remove') {
    return { exists: false, isBinary: Number(rec.is_binary), content: getOriginalContent(rec.content) || '' };
  }
  return { exists: true, isBinary: Number(rec.is_binary), content: getFinalContent(rec.content) };
}

function snapshotHead(db: any): SqlRow | null {
  const rows = dbQuery(db, 'SELECT id, version_id, display_version FROM snapshots ORDER BY id DESC LIMIT 1');
  return rows.length ? rows[0] : null;
}

// Rebuild full file tree up to a snapshot; key = mount + \0 + rel.
export function rebuildSnapshotTree(db: any, snapshotId: number): { [key: string]: { isBinary: number; content: string } } {
  const rows = dbQuery(db, 'SELECT mount, rel_path, change_type, is_binary, content FROM snapshot_files WHERE snapshot_id<=? ORDER BY snapshot_id ASC', [snapshotId]);
  const tree: { [key: string]: { isBinary: number; content: string } } = {};
  for (const r of rows) {
    const key = r.mount + '\u0000' + r.rel_path;
    if (r.change_type === 'delete' || r.change_type === 'remove') {
      delete tree[key];
    } else {
      tree[key] = { isBinary: Number(r.is_binary), content: getFinalContent(r.content) };
    }
  }
  return tree;
}

// Line-level diff summary between two texts.
export function lineDiff(oldText: string | null | undefined, newText: string | null | undefined): string {
  const a = String(oldText === null || oldText === undefined ? '' : oldText).split('\n');
  const b = String(newText === null || newText === undefined ? '' : newText).split('\n');
  const maxLines = 10;
  const out: string[] = [];
  let shown = 0;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if ((a[i] || '') !== (b[i] || '')) {
      if (shown >= maxLines) { out.push('... (diff too large, truncated)'); break; }
      if (i < a.length) out.push('- ' + a[i]);
      if (i < b.length) out.push('+ ' + b[i]);
      shown++;
    }
  }
  return out.join('\n');
}

// Changes between the staging area and the latest snapshot (used by commit).
function computeChanges(db: any, head: SqlRow | null) {
  const stagingRows = dbQuery(db, 'SELECT mount, rel_path, content, is_binary, state FROM staging');
  const changes: Array<{ mount: string; rel_path: string; change_type: string; is_binary: number; content: string }> = [];
  const headId = head ? head.id : 0;
  for (const st of stagingRows) {
    if (st.state === 'pending_delete') {
      changes.push({ mount: st.mount, rel_path: st.rel_path, change_type: 'delete', is_binary: Number(st.is_binary), content: st.content });
      continue;
    }
    const prev = fileStateAt(db, headId, st.mount, st.rel_path);
    if (prev.exists && prev.content === st.content) continue; // identical -> skip
    let content: string;
    if (prev.exists) {
      content = packDr(prev.content, st.content);
    } else {
      content = st.content;
    }
    changes.push({
      mount: st.mount,
      rel_path: st.rel_path,
      change_type: prev.exists ? 'modify' : 'add',
      is_binary: Number(st.is_binary),
      content,
    });
  }
  return changes;
}

export async function doCommit(ProjectID: string, params: any): Promise<any> {
  const { pdir } = await requireProject(ProjectID);
  const VersionID = String(params.VersionID === undefined ? '' : params.VersionID).trim();
  if (!/^\d+$/.test(VersionID)) throw new Error('VersionID must be a pure number string');
  const displayVersion = String(params.DisplayVersion === undefined ? '' : params.DisplayVersion).trim();
  if (!displayVersion) throw new Error('DisplayVersion cannot be empty');
  const db = openDb(pdir + '/data.db');
  try {
    ensureSchema(db);
    const head = snapshotHead(db);
    if (head && parseInt(VersionID, 10) <= head.version_id) {
      throw new Error('VersionID must be greater than current max ' + head.version_id);
    }
    const dup = dbQuery(db, 'SELECT id FROM snapshots WHERE display_version=? LIMIT 1', [displayVersion]);
    if (dup.length) throw new Error('DisplayVersion already exists: ' + displayVersion);
    const changes = computeChanges(db, head);
    if (!changes.length) throw new Error('Staging matches the latest snapshot; nothing to commit (run manage add first)');
    const vid = parseInt(VersionID, 10);
    const newId = await withTx(db, () => {
      const sid = dbInsert(db, 'snapshots', {
        version_id: vid,
        display_version: displayVersion,
        description: params.description || '',
        author: params.author || '',
        created_at: nowIso(),
        parent_id: head ? head.id : null,
      });
      for (const c of changes) {
        dbExec(db, 'INSERT INTO snapshot_files (snapshot_id, mount, rel_path, change_type, is_binary, content) VALUES (?,?,?,?,?,?)',
          [sid, c.mount, c.rel_path, c.change_type, c.is_binary, c.content]);
      }
      return sid;
    });
    return {
      success: true,
      message: 'Committed with ' + changes.length + ' file changes',
      data: {
        snapshotId: newId,
        displayVersion,
        versionId: vid,
        changeCount: changes.length,
        changes: changes.map((c) => ({ mount: c.mount, rel_path: c.rel_path, change_type: c.change_type })),
      },
    };
  } finally {
    dbClose(db);
  }
}

export async function doShow(ProjectID: string, params: any): Promise<any> {
  const { pdir, mf } = await requireProject(ProjectID);
  const db = openDb(pdir + '/data.db');
  try {
    ensureSchema(db);
    const head = snapshotHead(db);
    const headId = head ? head.id : 0;
    const mounts = normalizeMounts(mf);
    const staged = dbQuery(db, 'SELECT mount, rel_path, content, is_binary, state FROM staging ORDER BY mount, rel_path');
    if (params.FileRelPath) {
      const pr = parseRelPath(mf, params.FileRelPath);
      const rows = staged.filter((r: any) => r.mount === pr.mount && r.rel_path === pr.relPath);
      if (!rows.length) return { success: true, message: 'File not staged: ' + params.FileRelPath, data: null };
      const r = rows[0];
      const prev = fileStateAt(db, headId, r.mount, r.rel_path);
      return {
        success: true,
        message: 'Staged file detail',
        data: {
          mount: r.mount,
          rel_path: r.rel_path,
          state: r.state,
          prevExists: prev.exists,
          prevIsBinary: prev.isBinary,
          prevContent: prev.exists ? prev.content : null,
          isBinary: r.is_binary,
          content: r.state === 'pending_delete' ? '(pending_delete) ' + r.content : r.content,
        },
      };
    }
    const byMount: { [k: string]: any[] } = {};
    for (const k of Object.keys(mounts)) byMount[k] = [];
    for (const r of staged) {
      if (!byMount[r.mount]) byMount[r.mount] = [];
      byMount[r.mount].push(r);
    }
    const lines: string[] = [];
    const order = Object.keys(mounts);
    for (const m of order) {
      const list = byMount[m] || [];
      let changed = 0;
      for (const r of list) {
        if (r.state === 'pending_delete') { changed++; continue; }
        const prev = fileStateAt(db, headId, m, r.rel_path);
        if (!prev.exists || prev.content !== r.content) changed++;
      }
      lines.push('========================================');
      lines.push('Mount: ' + m + ' | staged ' + list.length + ' files | changed ' + changed);
      lines.push('========================================');
      for (const r of list) {
        const tag = r.state === 'pending_delete' ? '[DEL]' : (r.state === 'pending_add' ? '[ADD]' : '[MOD]');
        lines.push(tag + ' ' + r.rel_path);
      }
      lines.push('');
    }
    const byMountOut: { [k: string]: any[] } = {};
    for (const m of order) {
      byMountOut[m] = (byMount[m] || []).map((r: any) => ({ rel_path: r.rel_path, state: r.state }));
    }
    return { success: true, message: 'Staging overview', data: { text: lines.join('\n'), byMount: byMountOut, totalStaged: staged.length } };
  } finally {
    dbClose(db);
  }
}

export async function doList(ProjectID: string, params: any): Promise<any> {
  const { pdir } = await requireProject(ProjectID);
  const db = openDb(pdir + '/data.db');
  try {
    ensureSchema(db);
    const page = Math.max(1, parseInt(params.page || 1, 10) || 1);
    const limit = Math.max(1, Math.min(50, parseInt(params.limit || 5, 10) || 5));
    const totalRow = dbQuery(db, 'SELECT COUNT(*) AS c FROM snapshots');
    const total = totalRow.length ? totalRow[0].c : 0;
    const offset = (page - 1) * limit;
    const snaps = dbQuery(db, 'SELECT id, version_id, display_version, description, author, created_at FROM snapshots ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset]);
    const items: any[] = [];
    for (const s of snaps) {
      const cntRow = dbQuery(db, 'SELECT COUNT(*) AS c FROM snapshot_files WHERE snapshot_id=?', [s.id]);
      items.push({
        version_id: s.version_id,
        display_version: s.display_version,
        description: s.description,
        author: s.author,
        created_at: s.created_at,
        changeFiles: cntRow.length ? cntRow[0].c : 0,
      });
    }
    return { success: true, message: 'Snapshot list', data: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), items } };
  } finally {
    dbClose(db);
  }
}

export async function doDiff(ProjectID: string, params: any): Promise<any> {
  const { pdir } = await requireProject(ProjectID);
  const db = openDb(pdir + '/data.db');
  try {
    ensureSchema(db);
    const target = findSnapshotByDisplay(db, params.TargetVersion);
    const targetTree = rebuildSnapshotTree(db, target.id);
    const staged = dbQuery(db, 'SELECT mount, rel_path, content, is_binary, state FROM staging');
    const stagedMap: { [k: string]: any } = {};
    for (const st of staged) stagedMap[st.mount + '\u0000' + st.rel_path] = st;
    const keys: { [k: string]: number } = {};
    for (const k of Object.keys(targetTree)) keys[k] = 1;
    for (const k of Object.keys(stagedMap)) keys[k] = 1;
    const files: any[] = [];
    for (const key of Object.keys(keys)) {
      const t = targetTree[key];
      const s = stagedMap[key];
      const sep = key.indexOf('\u0000');
      const mount = key.slice(0, sep);
      const rel = key.slice(sep + 1);
      if (!s) {
        if (t) files.push({ mount, rel_path: rel, change_type: 'delete', isBinary: t.isBinary, detail: '(deleted in target snapshot)' });
        continue;
      }
      if (s.state === 'pending_delete') {
        files.push({ mount, rel_path: rel, change_type: 'delete', isBinary: s.is_binary, detail: '(staged deletion)' });
        continue;
      }
      if (!t) {
        files.push({ mount, rel_path: rel, change_type: 'add', isBinary: s.is_binary, detail: s.is_binary ? '(binary)' : lineDiff('', s.content) });
      } else if (t.content !== s.content) {
        const bin = Number(s.is_binary) || Number(t.isBinary);
        files.push({ mount, rel_path: rel, change_type: 'modify', isBinary: s.is_binary, detail: bin ? '(binary diff)' : lineDiff(t.content, s.content) });
      }
    }
    return {
      success: true,
      message: 'Diff done, ' + files.length + ' file differences',
      data: { target: params.TargetVersion, totalChanged: files.length, files },
    };
  } finally {
    dbClose(db);
  }
}

export { dbListSnapshots, findFileRecord, fileStateAt, snapshotHead, findSnapshotByDisplay, computeChanges };