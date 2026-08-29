// Write-side engine: init/manage/ChangeCommitNode/PullFromHistory/Rollback.

import {
  openDb, dbQuery, dbExec, dbInsert, dbClose, ensureSchema, withTx,
} from './sqlite';
import {
  projectDir, requireProject, normalizeMounts, parseRelPath, loadIgnoreRulesAll, scanTree, saveManifest,
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
  const mounts: { [key: string]: { path: string } } = { _main: { path: rootPath } };
  let ignorePath: string | null = null;
  if (multiple) {
    if (!params.MultiplePathArray) throw new Error('IsMultiple=true requires MultiplePathArray');
    let arr: any[];
    try { arr = JSON.parse(params.MultiplePathArray); } catch (e) { throw new Error('MultiplePathArray is not a valid JSON array: ' + (e as Error).message); }
    if (!Array.isArray(arr)) throw new Error('MultiplePathArray must be an array');
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      if (item.UseIgnore) { ignorePath = String(item.UseIgnore); continue; }
      if (item.id && item.path) {
        const p = String(item.path).replace(/\/+$/, '');
        if (!(await fsExists(p))) throw new Error('Mount directory does not exist: ' + p);
        mounts[String(item.id)] = { path: p };
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

export async function doManage(ProjectID: string, params: any): Promise<any> {
  const { pdir, mf } = await requireProject(ProjectID);
  const action = String(params.action || '').trim().toLowerCase();
  if (action !== 'add' && action !== 'remove') throw new Error('action must be add or remove');
  const db = openDb(pdir + '/data.db');
  try {
    ensureSchema(db);
    const head = snapshotHead(db);
    const headId = head ? head.id : 0;
    const mounts = normalizeMounts(mf);
    const ignoreRules = await loadIgnoreRulesAll(mf);
    const pr = parseRelPath(mf, params.RelPath);
    const maxMB = mf.maxFileSizeMB && mf.maxFileSizeMB > 0 ? mf.maxFileSizeMB : DEFAULT_MAX_FILE_MB;
    const warnings: string[] = [];
    let touched = 0;
    await withTx(db, async () => {
      if (pr.all) {
        for (const m of Object.keys(mounts)) {
          const base = mounts[m];
          const files = await scanTree(base, ignoreRules, pdir);
          for (const f of files) {
            if (action === 'add') {
              if (maxMB > 0 && f.size > maxMB * 1024 * 1024) {
                warnings.push('Skipped oversized file: ' + m + '/' + f.rel + ' (' + f.size + ' B)');
                continue;
              }
              const fe = await readFileToEntry(f.full);
              upsertStaging(db, m, f.rel, fe.content, fe.isBinary, stagingStateFor(db, headId, m, f.rel));
              touched++;
            } else {
              const fe = await readFileToEntry(f.full);
              upsertStaging(db, m, f.rel, fe.content, fe.isBinary, 'pending_delete');
              touched++;
            }
          }
        }
        if (action === 'remove') {
          const remain = dbQuery(db, 'SELECT mount, rel_path, content, is_binary FROM staging WHERE state != ?', ['pending_delete']);
          for (const st of remain) {
            const base = mounts[st.mount];
            if (!base) continue;
            const absExist = await fsExists(base + '/' + st.rel_path);
            if (!absExist) upsertStaging(db, st.mount, st.rel_path, st.content, Number(st.is_binary), 'pending_delete');
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
            const files = await scanTree(abs, ignoreRules, pdir);
            for (const f of files) {
              if (maxMB > 0 && f.size > maxMB * 1024 * 1024) {
                warnings.push('Skipped oversized file: ' + relRoot + f.rel + ' (' + f.size + ' B)');
                continue;
              }
              const fe = await readFileToEntry(f.full);
              upsertStaging(db, m, relRoot + f.rel, fe.content, fe.isBinary, stagingStateFor(db, headId, m, relRoot + f.rel));
              touched++;
            }
          } else {
            if (maxMB > 0 && existsRes.size > maxMB * 1024 * 1024) {
              warnings.push('Skipped oversized file: ' + pr.relPath + ' (' + existsRes.size + ' B)');
            } else {
              const fe = await readFileToEntry(abs);
              upsertStaging(db, m, pr.relPath as string, fe.content, fe.isBinary, stagingStateFor(db, headId, m, pr.relPath as string));
              touched++;
            }
          }
        } else {
          const prev = fileStateAt(db, headId, m, pr.relPath as string);
          const existsRes = await (Tools as any).Files.exists(abs, 'android');
          let delContent = '';
          let delIsBinary = 0;
          if (prev.exists) { delContent = prev.content; delIsBinary = prev.isBinary; }
          else if (existsRes && existsRes.exists) { const fe = await readFileToEntry(abs); delContent = fe.content; delIsBinary = fe.isBinary; }
          if (!prev.exists && !(existsRes && existsRes.exists)) throw new Error('File does not exist and is not tracked: ' + abs);
          upsertStaging(db, m, pr.relPath as string, delContent, delIsBinary, 'pending_delete');
          touched++;
        }
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
    const mounts = normalizeMounts(mf);
    await withTx(db, async () => {
      // Remove tracked files that are absent from the target tree (safe align; untracked files untouched).
      const regRows = dbQuery(db, 'SELECT DISTINCT mount, rel_path FROM snapshot_files');
      for (const rr of regRows) {
        const key = rr.mount + '\u0000' + rr.rel_path;
        if (tree[key]) continue;
        const base = mounts[rr.mount];
        if (!base) continue;
        const abs = base + '/' + rr.rel_path;
        if (await fsExists(abs)) await fsDelete(abs, false);
      }
      // Write the target tree back to disk.
      for (const key of Object.keys(tree)) {
        const sep = key.indexOf('\u0000');
        const mount = key.slice(0, sep);
        const rel = key.slice(sep + 1);
        const base = mounts[mount];
        if (!base) continue;
        const abs = base + '/' + rel;
        await fsMkdir(abs.slice(0, abs.lastIndexOf('/')), true);
        await writeEntryToFile(abs, tree[key].content, tree[key].isBinary);
      }
      // Drop all snapshots after the target (irreversible).
      dbExec(db, 'DELETE FROM snapshot_files WHERE snapshot_id > ?', [target.id]);
      dbExec(db, 'DELETE FROM snapshots WHERE id > ?', [target.id]);
      // Re-sync staging against the rolled-back head: keep content, recompute states.
      const staged = dbQuery(db, 'SELECT mount, rel_path, content, is_binary FROM staging');
      dbExec(db, 'DELETE FROM staging');
      for (const st of staged) {
        const prev = fileStateAt(db, target.id, st.mount, st.rel_path);
        if (prev.exists && prev.content === st.content) continue;
        const state = !prev.exists ? 'pending_add' : 'pending_modify';
        upsertStaging(db, st.mount, st.rel_path, st.content, Number(st.is_binary), state);
      }
    });
    return { success: true, message: 'Rolled back; snapshots after target removed and staging synced', data: { target: params.TargetVersion, fileCount: Object.keys(tree).length } };
  } finally {
    dbClose(db);
  }
}