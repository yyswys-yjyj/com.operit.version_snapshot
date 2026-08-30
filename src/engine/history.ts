// Write-side engine: init/manage/ChangeCommitNode/PullFromHistory/Rollback.

import {
  openDb, dbQuery, dbExec, dbInsert, dbClose, ensureSchema, withTx,
} from './sqlite';
import {
  projectDir, requireProject, normalizeMounts, parseRelPath, loadIgnoreRulesAll, scanTree, saveManifest,
  updateManifestMetadata,
  Manifest,
} from './paths';
import { nowIso, DEFAULT_MAX_FILE_MB, fsExists, fsCopy, fsMkdir, fsDelete, readFileToEntry, writeEntryToFile } from './base64';
import { packDr, getFinalContent, getOriginalContent, makeDeleteContent, splitDr } from './format';
import { fileStateAt, snapshotHead, findSnapshotByDisplay, rebuildSnapshotTree } from './core';

// ---- DestroyDatabase ----
export async function doDestroyDatabase(ProjectID: string, params: any): Promise<any> {
  const pdir = projectDir(ProjectID);
  if (String(params.confirm) !== 'true') {
    return {
      success: false,
      code: 'CONFIRM_REQUIRED',
      message: 'DestroyDatabase is IRREVERSIBLE - it permanently deletes ' + pdir +
        ' (manifest.json + data.db + all history). Pass confirm=true to proceed.',
      data: { ProjectID, pdir },
    };
  }
  if (!(await fsExists(pdir))) throw new Error('Project database not found: ' + ProjectID);
  await fsDelete(pdir, true);
  return { success: true, message: 'Destroyed database: ' + ProjectID, data: { ProjectID, pdir } };
}

// ---- init ----
export async function doInit(ProjectID: string, params: any): Promise<any> {
  const pdir = projectDir(ProjectID);
  if (await fsExists(pdir)) throw new Error('Project already exists: ' + ProjectID);
  if (!params.rootPath) throw new Error('rootPath cannot be empty');
  const rootPath = String(params.rootPath).replace(/\/+$/, '');
  if (!(await fsExists(rootPath))) throw new Error('rootPath does not exist: ' + rootPath);
  const maxMB = params.maxFileSizeMB === undefined || params.maxFileSizeMB === null ? DEFAULT_MAX_FILE_MB : Number(params.maxFileSizeMB);
  const multiple = !!params.IsMultiple;
  const mounts: { [key: string]: { path: string; ignorePath?: string | null } } = { _main: { path: rootPath } };
  let ignorePath: string | null = null;
  if (multiple) {
    if (!params.MultiplePathArray) throw new Error('IsMultiple=true requires MultiplePathArray');
    let arr: any[];
    try { arr = JSON.parse(params.MultiplePathArray); } catch (e) { throw new Error('MultiplePathArray is not a valid JSON array: ' + (e as Error).message); }
    if (!Array.isArray(arr)) throw new Error('MultiplePathArray must be an array');
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const hasMount = !!(item.id && item.path);
      const hasIgnore = !!item.UseIgnore;
      if (hasMount) {
        const p = String(item.path).replace(/\/+$/, '');
        if (!(await fsExists(p))) throw new Error('Mount directory does not exist: ' + p);
        const mo: { path: string; ignorePath?: string | null } = { path: p };
        if (hasIgnore) {
          // UseIgnore inside a mount entry = mount-local (isolated) ignore file.
          const ip = String(item.UseIgnore);
          if (!(await fsExists(ip))) throw new Error('Mount ignorePath does not exist: ' + ip);
          mo.ignorePath = ip;
        }
        mounts[String(item.id)] = mo;
      } else if (hasIgnore) {
        // Top-level UseIgnore entry (no id/path) = GLOBAL ignore path for all mounts.
        const ip = String(item.UseIgnore);
        if (!(await fsExists(ip))) throw new Error('ignorePath does not exist: ' + ip);
        ignorePath = ip;
      }
    }
  } else if (params.MultiplePathArray) {
    // Single-mount mode: MultiplePathArray only carries global UseIgnore entries.
    let arr: any[];
    try { arr = JSON.parse(params.MultiplePathArray); } catch (e) { throw new Error('MultiplePathArray is not a valid JSON array: ' + (e as Error).message); }
    if (!Array.isArray(arr)) throw new Error('MultiplePathArray must be an array');
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      if (item.UseIgnore && !item.id && !item.path) {
        const ip = String(item.UseIgnore);
        if (!(await fsExists(ip))) throw new Error('ignorePath does not exist: ' + ip);
        ignorePath = ip;
      } else if (item.id || item.path) {
        throw new Error('IsMultiple=false: MultiplePathArray only accepts {"UseIgnore":"..."} entries (mounts require IsMultiple=true)');
      }
    }
  }
  let extendFrom: string | null = null;
  if (params.extendProjectID) {
    const srcPdir = projectDir(params.extendProjectID);
    if (!(await fsExists(srcPdir))) throw new Error('Inherited project does not exist: ' + params.extendProjectID);
    await fsMkdir(pdir, true);
    const srcDb = srcPdir + '/data.db';
    if (await fsExists(srcDb)) await fsCopy(srcDb, pdir + '/data.db', false);
    extendFrom = params.extendProjectID;
  } else {
    await fsMkdir(pdir, true);
  }
  const manifest: Manifest = {
    projectId: ProjectID,
    rootPath,
    createdAt: nowIso(),
    extendsFrom: extendFrom,
    multiple,
    maxFileSizeMB: maxMB,
    mounts,
    ignorePath,
  };
  await saveManifest(pdir, manifest);
  const db = openDb(pdir + '/data.db');
  try { ensureSchema(db); } finally { dbClose(db); }
  return {
    success: true,
    message: 'Initialized',
    data: { ProjectID, pdir, rootPath, multiple, mounts: Object.keys(mounts), extendFrom, ignorePath, maxFileSizeMB: maxMB },
  };
}

// ---- manage (staging) ----
function upsertStaging(db: any, mount: string, relPath: string, content: string, isBinary: number, state: string): void {
  dbExec(db, 'INSERT OR REPLACE INTO staging (mount, rel_path, content, is_binary, state, updated_at) VALUES (?,?,?,?,?,?)',
    [mount, relPath, content, isBinary, state, nowIso()]);
}
function stagingStateFor(db: any, headId: number, mount: string, relPath: string): string {
  const prev = fileStateAt(db, headId, mount, relPath);
  return prev.exists ? 'pending_modify' : 'pending_add';
}
// True when the given content differs from the head snapshot state (or the
// file is brand-new). manage add uses this to keep the staging area limited
// to real changes instead of marking every file on disk.
function stagingChanged(db: any, headId: number, mount: string, relPath: string, content: string, isBinary: number): boolean {
  const prev = fileStateAt(db, headId, mount, relPath);
  if (!prev.exists) return true;
  return prev.isBinary !== isBinary || prev.content !== content;
}
// Unchanged state used by Rollback to seed the staging area with the
// rolled-back head's whole tree (baseline anchors, never real changes).
export const ST_UNCHANGED = 'unchanged';
// Drop any staging entry for an unchanged file so stale pending_add /
// pending_modify markers do not accumulate after a refresh. Baseline
// anchors (state=unchanged) are kept: they mirror the head tree.
function clearStagingIfUnchanged(db: any, headId: number, mount: string, relPath: string, content: string, isBinary: number): void {
  if (!stagingChanged(db, headId, mount, relPath, content, isBinary)) {
    const ex = dbQuery(db, 'SELECT state FROM staging WHERE mount=? AND rel_path=?', [mount, relPath]);
    if (ex.length && ex[0].state === ST_UNCHANGED) return;
    dbExec(db, 'DELETE FROM staging WHERE mount=? AND rel_path=?', [mount, relPath]);
  }
}

export async function doManage(ProjectID: string, params: any): Promise<any> {
  const { pdir, mf } = await requireProject(ProjectID);
  // OtherParam: optional JSON object for auxiliary operations. Supported
  // shape: {"metadata":{"ignorePath":"/abs/.gitignore"|null,"maxFileSizeMB":10}}
  // Updates whitelisted manifest metadata (only ignorePath / maxFileSizeMB).
  if (params.OtherParam !== undefined && params.OtherParam !== null && String(params.OtherParam).trim() !== '') {
    let other: any;
    try { other = JSON.parse(String(params.OtherParam)); } catch (e) { throw new Error('OtherParam is not a valid JSON object: ' + (e as Error).message); }
    if (!other || typeof other !== 'object' || Array.isArray(other)) throw new Error('OtherParam must be a JSON object');
    if (other.metadata !== undefined) {
      const updated = await updateManifestMetadata(mf, pdir, other.metadata);
      return {
        success: true,
        message: 'Metadata updated',
        data: {
          ignorePath: updated.ignorePath ?? null,
          maxFileSizeMB: updated.maxFileSizeMB ?? DEFAULT_MAX_FILE_MB,
        },
      };
    }
    throw new Error('OtherParam has no supported operation; currently supported: {"metadata":{...}}');
  }
  const action = String(params.action || '').trim().toLowerCase();
  if (action !== 'add' && action !== 'remove') throw new Error('action must be add or remove');
  const db = openDb(pdir + '/data.db');
  try {
    ensureSchema(db);
    const head = snapshotHead(db);
    const headId = head ? head.id : 0;
    const mounts = normalizeMounts(mf);
    const ignoreCtx = await loadIgnoreRulesAll(mf);
    // Rules for one mount = global rules + that mount's isolated rules.
    const rulesForMount = (m: string) => {
      const per = ignoreCtx.perMount[m];
      return per && per.length ? ignoreCtx.global.concat(per) : ignoreCtx.global;
    };
    const pr = parseRelPath(mf, params.RelPath);
    const maxMB = mf.maxFileSizeMB && mf.maxFileSizeMB > 0 ? mf.maxFileSizeMB : DEFAULT_MAX_FILE_MB;
    const headTree = rebuildSnapshotTree(db, headId);
    // In-memory views: stage every entry once, then serve every per-file
    // lookup from a Map instead of hitting the Java SQLite bridge per file.
    // This removes O(files) bridge round-trips that stalled large add/remove.
    const allStaging = dbQuery(db, 'SELECT mount, rel_path, content, is_binary, state FROM staging');
    const stagingMap: { [key: string]: any } = {};
    for (const st of allStaging) stagingMap[st.mount + '\u0000' + st.rel_path] = st;
    const keyOf = (mount: string, rel: string) => mount + '\u0000' + rel;
    const isPendingDelete = (key: string) => {
      const e = stagingMap[key];
      return !!(e && e.state === 'pending_delete');
    };
    // True when the on-disk content differs from the head snapshot state.
    const changedVsHead = (key: string, content: string, isBinary: number) => {
      const h = headTree[key];
      if (!h) return true;
      return h.isBinary !== isBinary || h.content !== content;
    };
    const upsertMem = (mount: string, rel: string, content: string, isBinary: number, state: string) => {
      upsertStaging(db, mount, rel, content, isBinary, state);
      stagingMap[keyOf(mount, rel)] = { mount, rel_path: rel, content, is_binary: isBinary, state };
    };
    // Unchanged vs head: keep rollback anchors, drop stale pending_* entries.
    const clearOrKeepMem = (key: string, mount: string, rel: string, content: string, isBinary: number) => {
      if (changedVsHead(key, content, isBinary)) return false;
      if (stagingMap[key] && stagingMap[key].state === ST_UNCHANGED) return false;
      dbExec(db, 'DELETE FROM staging WHERE mount=? AND rel_path=?', [mount, rel]);
      delete stagingMap[key];
      return true;
    };
    // Per-mount tracked rel-path sets, built once for scanTree filtering.
    const trackedByMount: { [mount: string]: { [rel: string]: boolean } } = {};
    for (const mount of Object.keys(mounts)) trackedByMount[mount] = {};
    for (const key of Object.keys(headTree)) {
      const sep = key.indexOf('\u0000');
      if (sep < 0) continue;
      const mount = key.slice(0, sep);
      if (trackedByMount[mount]) trackedByMount[mount][key.slice(sep + 1)] = true;
    }
    const warnings: string[] = [];
    let touched = 0;
    // Phase 1 (outside any transaction): scan the tree, read file contents and
    // decide every staging mutation in memory. Never hold a SQLite transaction
    // while awaiting Java bridge file I/O - that combination deadlocks the
    // host's serialized engine (the large-directory hang we hunted).
    const upserts: Array<[string, string, string, number, string]> = [];
    const deletes: Array<[string, string]> = [];
    const planUpsert = (mount: string, rel: string, content: string, isBinary: number, state: string) => {
      upserts.push([mount, rel, content, isBinary, state]);
      stagingMap[keyOf(mount, rel)] = { mount, rel_path: rel, content, is_binary: isBinary, state };
    };
    const planClear = (key: string, mount: string, rel: string, content: string, isBinary: number) => {
      if (changedVsHead(key, content, isBinary)) return false;
      if (stagingMap[key] && stagingMap[key].state === ST_UNCHANGED) return false;
      deletes.push([mount, rel]);
      delete stagingMap[key];
      return true;
    };
    if (pr.all) {
      const scanned: { [key: string]: boolean } = {};
      for (const m of Object.keys(mounts)) {
        const base = mounts[m];
        const files = await scanTree(base, rulesForMount(m), pdir, trackedByMount[m]);
        for (const f of files) {
          const key = keyOf(m, f.rel);
          scanned[key] = true;
          if (action === 'add') {
            if (maxMB > 0 && f.size > maxMB * 1024 * 1024) {
              warnings.push('Skipped oversized file: ' + m + '/' + f.rel + ' (' + f.size + ' B)');
              continue;
            }
            // A full refresh must not resurrect files explicitly staged
            // for deletion (remove only marks; the file may still exist).
            if (isPendingDelete(key)) continue;
            const fe = await readFileToEntry(f.full);
            if (planClear(key, m, f.rel, fe.content, fe.isBinary)) continue;
            // Keep rollback baseline anchors (unchanged) untouched: if on-disk
            // content matches the head AND the staging row is already an
            // unchanged anchor, do not upgrade it to pending_add/modify.
            if (!changedVsHead(key, fe.content, fe.isBinary) && stagingMap[key] && stagingMap[key].state === ST_UNCHANGED) {
              planUpsert(m, f.rel, fe.content, fe.isBinary, ST_UNCHANGED);
              continue;
            }
            planUpsert(m, f.rel, fe.content, fe.isBinary, stagingStateFor(db, headId, m, f.rel));
            touched++;
          } else {
            const fe = await readFileToEntry(f.full);
            planUpsert(m, f.rel, fe.content, fe.isBinary, 'pending_delete');
            touched++;
          }
        }
      }
      if (action === 'add') {
        // Files present in the head snapshot but missing from disk are
        // deletions: record them as pending_delete so add "." also picks
        // up files removed outside the tool.
        for (const key of Object.keys(headTree)) {
          if (scanned[key]) continue;
          const sep = key.indexOf('\u0000');
          if (sep < 0) continue;
          const m = key.slice(0, sep);
          const rel = key.slice(sep + 1);
          if (!mounts[m]) continue;
          planUpsert(m, rel, headTree[key].content, headTree[key].isBinary || 0, 'pending_delete');
          touched++;
        }
      }
      if (action === 'remove') {
        // Any staged-but-not-yet-deleted file that vanished from disk is a
        // pending_delete; never resurrect, never drop.
        for (const key of Object.keys(stagingMap)) {
          const st = stagingMap[key];
          if (st.state === 'pending_delete') continue;
          const base = mounts[st.mount];
          if (!base) continue;
          if (!(await fsExists(base + '/' + st.rel_path))) planUpsert(st.mount, st.rel_path, st.content, Number(st.is_binary), 'pending_delete');
        }
      }
    } else {
      const m = pr.mount as string;
      const base = mounts[m];
      const abs = pr.relPath ? base + '/' + pr.relPath : base;
      if (action === 'add') {
        const existsRes = await (Tools as any).Files.exists(abs, 'android');
        if (!existsRes || !existsRes.exists) throw new Error('File does not exist: ' + abs);
        if (existsRes.isDirectory) {
          const relRoot = pr.relPath ? pr.relPath + '/' : '';
          const files = await scanTree(abs, rulesForMount(m), pdir, trackedByMount[m]);
          for (const f of files) {
            if (maxMB > 0 && f.size > maxMB * 1024 * 1024) {
              warnings.push('Skipped oversized file: ' + relRoot + f.rel + ' (' + f.size + ' B)');
              continue;
            }
            const fullRel = relRoot + f.rel;
            const key = keyOf(m, fullRel);
            if (isPendingDelete(key)) continue;
            const fe = await readFileToEntry(f.full);
            if (planClear(key, m, fullRel, fe.content, fe.isBinary)) continue;
            planUpsert(m, fullRel, fe.content, fe.isBinary, stagingStateFor(db, headId, m, fullRel));
            touched++;
          }
        } else {
          if (maxMB > 0 && existsRes.size > maxMB * 1024 * 1024) {
            warnings.push('Skipped oversized file: ' + pr.relPath + ' (' + existsRes.size + ' B)');
          } else {
            const key = keyOf(m, pr.relPath as string);
            const fe = await readFileToEntry(abs);
            if (planClear(key, m, pr.relPath as string, fe.content, fe.isBinary)) {
              // Explicit add of an unchanged file: undo any previous
              // staging entry (including a pending_delete marker).
            } else {
              planUpsert(m, pr.relPath as string, fe.content, fe.isBinary, stagingStateFor(db, headId, m, pr.relPath as string));
              touched++;
            }
          }
        }
      } else {
        const prevKey = keyOf(m, pr.relPath as string);
        const h = headTree[prevKey];
        const existsRes = await (Tools as any).Files.exists(abs, 'android');
        let delContent = '';
        let delIsBinary = 0;
        if (h) { delContent = h.content; delIsBinary = h.isBinary; }
        else if (existsRes && existsRes.exists) { const fe = await readFileToEntry(abs); delContent = fe.content; delIsBinary = fe.isBinary; }
        if (!h && !(existsRes && existsRes.exists)) throw new Error('File does not exist and is not tracked: ' + abs);
        planUpsert(m, pr.relPath as string, delContent, delIsBinary, 'pending_delete');
        touched++;
      }
    }
    // Phase 2 (short transaction): persist every planned mutation in one burst.
    // Only SQLite calls live here - no bridge file I/O under the write lock.
    await withTx(db, async () => {
      for (const d of deletes) {
        dbExec(db, 'DELETE FROM staging WHERE mount=? AND rel_path=?', [d[0], d[1]]);
      }
      for (const u of upserts) {
        upsertStaging(db, u[0], u[1], u[2], u[3], u[4]);
      }
    });
    const result: any = { action, touched };
    if (warnings.length) result.warnings = warnings;
    return {
      success: true,
      message: action === 'add'
        ? ('Staged ' + touched + ' files' + (warnings.length ? ' (' + warnings.length + ' warnings)' : ''))
        : ('Marked ' + touched + ' files deleted' + (warnings.length ? ' (' + warnings.length + ' warnings)' : '')),
      data: result,
    };
  } finally {
    dbClose(db);
  }
}

// ---- ChangeCommitNode ----
export async function doChangeCommitNode(ProjectID: string, params: any): Promise<any> {
  const { pdir, mf } = await requireProject(ProjectID);
  const action = String(params.action || '').trim().toLowerCase();
  if (action !== 'rewrite' && action !== 'remove') throw new Error('action must be rewrite or remove');
  const pr = parseRelPath(mf, params.FileRelPath);
  const db = openDb(pdir + '/data.db');
  try {
    ensureSchema(db);
    const target = findSnapshotByDisplay(db, params.TargetVersion);
    const existing = dbQuery(db, 'SELECT * FROM snapshot_files WHERE snapshot_id=? AND mount=? AND rel_path=?',
      [target.id, pr.mount, pr.relPath]);
    const prevRec = dbQuery(db, 'SELECT * FROM snapshot_files WHERE mount=? AND rel_path=? AND snapshot_id<? ORDER BY snapshot_id DESC LIMIT 1',
      [pr.mount, pr.relPath, target.id]);
    const prevContent = prevRec.length ? getFinalContent(prevRec[0].content) : '';
    const prevIsBinary = prevRec.length ? Number(prevRec[0].is_binary) : 0;
    let newContent = '';
    const newType = action === 'remove' ? 'remove' : 'rewrite';
    let isBinary = existing.length ? Number(existing[0].is_binary) : prevIsBinary;
    if (action === 'remove') {
      const orig = existing.length
        ? (getOriginalContent(existing[0].content) !== null ? getOriginalContent(existing[0].content) as string : getFinalContent(existing[0].content))
        : prevContent;
      newContent = makeDeleteContent(orig);
    } else {
      let newText: string | null = null;
      let newIsBinary = 0;
      if (params.SelectFilePath) {
        const fe = await readFileToEntry(params.SelectFilePath);
        newText = fe.content;
        newIsBinary = fe.isBinary;
      } else if (params.content !== undefined && params.content !== null) {
        newText = String(params.content);
        newIsBinary = 0;
      } else {
        throw new Error('rewrite requires content or SelectFilePath');
      }
      if (existing.length) {
        const oldSplit = splitDr(existing[0].content);
        if (oldSplit.original !== null) {
          newContent = packDr(oldSplit.original, newText);
        } else {
          newContent = packDr(getFinalContent(existing[0].content), newText);
        }
      } else {
        newContent = packDr(prevContent, newText);
      }
      isBinary = newIsBinary;
    }
    await withTx(db, () => {
      if (existing.length) {
        dbExec(db, 'UPDATE snapshot_files SET change_type=?, content=?, is_binary=? WHERE snapshot_id=? AND mount=? AND rel_path=?',
          [newType, newContent, isBinary, target.id, pr.mount, pr.relPath]);
      } else {
        dbExec(db, 'INSERT INTO snapshot_files (snapshot_id, mount, rel_path, change_type, is_binary, content) VALUES (?,?,?,?,?,?)',
          [target.id, pr.mount, pr.relPath, newType, isBinary, newContent]);
      }
    });
    return {
      success: true,
      message: 'Node file updated',
      data: { displayVersion: params.TargetVersion, mount: pr.mount, rel_path: pr.relPath, action, change_type: newType },
    };
  } finally {
    dbClose(db);
  }
}

// ---- PullFromHistory ----
export async function doPull(ProjectID: string, params: any): Promise<any> {
  const { pdir, mf } = await requireProject(ProjectID);
  if (!params.OutputPath) throw new Error('OutputPath cannot be empty');
  const db = openDb(pdir + '/data.db');
  try {
    ensureSchema(db);
    const target = findSnapshotByDisplay(db, params.TargetVersion);
    const tree = rebuildSnapshotTree(db, target.id);
    const mounts = normalizeMounts(mf);
    const multi = Object.keys(mounts).length > 1;
    let selected: string[] | null = null;
    if (params.FileRelPathArray) {
      try { selected = JSON.parse(params.FileRelPathArray); } catch (e) { throw new Error('FileRelPathArray is not a valid JSON array: ' + (e as Error).message); }
      if (!Array.isArray(selected)) throw new Error('FileRelPathArray must be an array');
      selected = selected.map((x: any) => String(x));
    }
    let written = 0;
    for (const key of Object.keys(tree)) {
      const sep = key.indexOf('\u0000');
      const mount = key.slice(0, sep);
      const rel = key.slice(sep + 1);
      const fullKey = mount + '/' + rel;
      if (selected && selected.indexOf(fullKey) < 0) continue;
      let targetBase = String(params.OutputPath).replace(/\/+$/, '');
      // Multi-mount forks keep a subfolder per mount, including _main,
      // so the output tree mirrors the mount layout.
      if (multi) targetBase = targetBase + '/' + mount;
      const abs = targetBase + '/' + rel;
      await fsMkdir(abs.slice(0, abs.lastIndexOf('/')), true);
      await writeEntryToFile(abs, tree[key].content, tree[key].isBinary);
      written++;
    }
    return { success: true, message: 'Fork done, wrote ' + written + ' files', data: { output: params.OutputPath, target: params.TargetVersion, written } };
  } finally {
    dbClose(db);
  }
}

// ---- Rollback ----
export async function doRollback(ProjectID: string, params: any): Promise<any> {
  const { pdir, mf } = await requireProject(ProjectID);
  if (String(params.confirm) !== 'true') {
    return {
      success: false,
      code: 'CONFIRM_REQUIRED',
      message: 'Rollback is IRREVERSIBLE: it rewrites project files to the target version and ' +
        'deletes every snapshot after it. Pass confirm=true to proceed.',
      data: { ProjectID, target: params.TargetVersion },
    };
  }
  const db = openDb(pdir + '/data.db');
  try {
    ensureSchema(db);
    const target = findSnapshotByDisplay(db, params.TargetVersion);
    const head = snapshotHead(db);
    if (!head) throw new Error('Snapshot store is empty');
    if (target.id === head.id) throw new Error('Target is already the latest snapshot; nothing to roll back');
    const tree = rebuildSnapshotTree(db, target.id);
    // Head tree before the rollback: files absent from it but present on
    // disk are untracked (deleted in history, re-created and maybe ignored).
    // Overwriting or deleting them would destroy user data, so they are
    // preserved / merged with conflict markers instead.
    const headTree = rebuildSnapshotTree(db, head.id);
    const mounts = normalizeMounts(mf);
    const conflicts: Array<{ mount: string; rel_path: string; marker: string }> = [];
    const binarySkips: Array<{ mount: string; rel_path: string; preserved_as: string }> = [];
    const keptUntracked: Array<{ mount: string; rel_path: string }> = [];
    await withTx(db, async () => {
      // Remove tracked files that are absent from the target tree (safe align; untracked files untouched).
      const regRows = dbQuery(db, 'SELECT DISTINCT mount, rel_path FROM snapshot_files');
      for (const rr of regRows) {
        const key = rr.mount + '\u0000' + rr.rel_path;
        if (tree[key]) continue;
        const base = mounts[rr.mount];
        if (!base) continue;
        const abs = base + '/' + rr.rel_path;
        if (!(await fsExists(abs))) continue;
        // Only delete files the head tree still tracks. A file absent from
        // the head tree is an untracked on-disk copy (it was deleted in
        // history) -- never destroy it, just report it.
        if (!headTree[key]) {
          keptUntracked.push({ mount: rr.mount, rel_path: rr.rel_path });
          continue;
        }
        await fsDelete(abs, false);
      }
      // Write the target tree back to disk.
      for (const key of Object.keys(tree)) {
        const sep = key.indexOf('\u0000');
        const mount = key.slice(0, sep);
        const rel = key.slice(sep + 1);
        const base = mounts[mount];
        if (!base) continue;
        const abs = base + '/' + rel;
        // Conflict: the file exists on disk and the head tree does not
        // track it (deleted in history, then re-created locally, e.g. as an
        // ignored file). A blind overwrite would destroy that untracked
        // copy, so merge both sides with git-style conflict markers:
        //   <<<<<<< HEAD
        //   <on-disk content>
        //   =======
        //   <snapshot content of the target version>
        //   >>>>>>> version/<version_id>
        if (await fsExists(abs) && !headTree[key]) {
          const fe = await readFileToEntry(abs);
          if (fe.isBinary || tree[key].isBinary) {
            // Binary collision with an untracked on-disk copy: git-style merge
            // markers cannot be embedded in a binary. Preserve the untracked
            // side by renaming it aside (copy + delete original), then let the
            // snapshot's binary write back to the original name below. Both
            // sides survive -- nothing is silently dropped.
            const dot = abs.lastIndexOf('/');
            const dir = dot >= 0 ? abs.slice(0, dot) : '';
            const name = dot >= 0 ? abs.slice(dot + 1) : abs;
            const keepName = name + '.rollback-conflict-v' + target.version_id;
            const keepAbs = dir ? dir + '/' + keepName : keepName;
            if ((await fsExists(keepAbs))) await fsDelete(keepAbs, false);
            await fsCopy(abs, keepAbs, false);
            await fsDelete(abs, false);
            binarySkips.push({ mount, rel_path: rel, preserved_as: keepName });
            // fall through to the normal write-back of the snapshot content
          } else {
            const marker = '<<<<<<< HEAD\n' + fe.content + '\n=======\n' + tree[key].content + '\n>>>>>>> version/' + target.version_id + '\n';
            await writeEntryToFile(abs, marker, 0);
            conflicts.push({ mount, rel_path: rel, marker: 'version/' + target.version_id });
            continue;
          }
        }
        await fsMkdir(abs.slice(0, abs.lastIndexOf('/')), true);
        await writeEntryToFile(abs, tree[key].content, tree[key].isBinary);
      }
      // Drop all snapshots after the target (irreversible).
      dbExec(db, 'DELETE FROM snapshot_files WHERE snapshot_id > ?', [target.id]);
      dbExec(db, 'DELETE FROM snapshots WHERE id > ?', [target.id]);
      // Reset the staging area to a clean baseline: wipe every pre-rollback
      // entry, then seed it with the rolled-back head's whole tree marked
      // as unchanged, so no staging residue survives the rollback.
      dbExec(db, 'DELETE FROM staging');
      for (const key of Object.keys(tree)) {
        const sep = key.indexOf('\u0000');
        if (sep < 0) continue;
        const m = key.slice(0, sep);
        const rel = key.slice(sep + 1);
        upsertStaging(db, m, rel, tree[key].content, tree[key].isBinary || 0, ST_UNCHANGED);
      }
    });
    const data: any = { target: params.TargetVersion, fileCount: Object.keys(tree).length, stagingReset: Object.keys(tree).length };
    let msg = 'Rolled back; snapshots after target removed, staging reset to unchanged baseline (' + Object.keys(tree).length + ' files)';
    if (conflicts.length) { data.conflicts = conflicts; msg += '; merged ' + conflicts.length + ' untracked-file conflicts with git-style markers'; }
    if (binarySkips.length) { data.binaryConflicts = binarySkips; msg += '; preserved ' + binarySkips.length + ' untracked binaries (renamed aside, snapshot restored)'; }
    if (keptUntracked.length) { data.keptUntracked = keptUntracked; msg += '; kept ' + keptUntracked.length + ' untracked on-disk files'; }
    return { success: true, message: msg, data };
  } finally {
    dbClose(db);
  }
}