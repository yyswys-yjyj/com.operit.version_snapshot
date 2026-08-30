// Manifest loading, mount/path resolution and recursive tree scanning.

import { fsExists, fsList, getSnapshotRoot, fsReadText, fsMkdir } from './base64';
import { compileGitignore, IgnoreRule, gitignoreIsIgnored } from './gitignore';

export interface Manifest {
  projectId: string;
  rootPath: string;
  createdAt?: string;
  extendsFrom?: string | null;
  multiple?: boolean;
  maxFileSizeMB?: number;
  mounts?: { [key: string]: { path: string; ignorePath?: string | null } };
  ignorePath?: string | null;
}

export interface MountConfig {
  path: string;
  ignorePath?: string | null;
}

export interface ResolvedPath {
  all?: boolean;
  mount?: string;
  relPath?: string;
}

// Canonical path check: resolve . / .. lexically to ensure a path stays
// inside an allowed parent (defense against directory traversal).
function canonicalInside(parent: string, child: string): boolean {
  const stack: string[] = [];
  const parts = child.split('/');
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length) stack.pop();
    } else {
      stack.push(seg);
    }
  }
  const norm = parent.split('/').filter(Boolean).join('/') + '/' + stack.join('/');
  return norm === parent.split('/').filter(Boolean).join('/') || norm.startsWith(parent.split('/').filter(Boolean).join('/') + '/');
}

// Strict whitelist for project names: letters, digits, underscore, hyphen and
// CJK. Explicitly rejects '.', '..' and any path separator to stop traversal.
export function assertSafeProjectId(ProjectID: string): string {
  if (!ProjectID || typeof ProjectID !== 'string') throw new Error('ProjectID cannot be empty');
  const id = ProjectID.trim();
  if (!id) throw new Error('ProjectID cannot be empty');
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]+$/.test(id)) {
    throw new Error('ProjectID contains invalid characters; allow only letters, digits, _ - and CJK (rejected: ' + ProjectID + ')');
  }
  return id;
}

export function projectDir(ProjectID: string): string {
  const id = assertSafeProjectId(ProjectID);
  const root = getSnapshotRoot();
  const p = root + '/' + id;
  if (!canonicalInside(root, p)) {
    throw new Error('ProjectID resolves outside the snapshot database root');
  }
  return p;
}

export async function loadManifest(pdir: string): Promise<Manifest | null> {
  const p = pdir + '/manifest.json';
  if (!(await fsExists(p))) return null;
  const content = await fsReadText(p);
  try {
    return JSON.parse(content) as Manifest;
  } catch (e) {
    throw new Error('manifest.json parse failed: ' + (e as Error).message);
  }
}

export async function saveManifest(pdir: string, manifest: Manifest): Promise<void> {
  await fsMkdir(pdir, true);
  await (Tools as any).Files.write(pdir + '/manifest.json', JSON.stringify(manifest, null, 2), false, 'android');
}

// Whitelisted metadata updates used by manage OtherParam.metadata. Only
// ignorePath and maxFileSizeMB are mutable post-init; rootPath/mounts stay
// fixed to keep the project definition stable and safe.
export async function updateManifestMetadata(mf: Manifest, pdir: string, meta: any): Promise<Manifest> {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('OtherParam.metadata must be a JSON object');
  const allowed = ['ignorePath', 'maxFileSizeMB'];
  for (const k of Object.keys(meta)) {
    if (allowed.indexOf(k) < 0) throw new Error('Unsupported metadata field: ' + k + ' (allowed: ' + allowed.join(', ') + ')');
  }
  if ('ignorePath' in meta) {
    const ip = meta.ignorePath === null || meta.ignorePath === '' ? null : String(meta.ignorePath).trim();
    if (ip && !(await fsExists(ip))) throw new Error('ignorePath does not exist: ' + ip);
    mf.ignorePath = ip;
  }
  if ('maxFileSizeMB' in meta) {
    const m = Number(meta.maxFileSizeMB);
    if (!Number.isFinite(m) || m < 0) throw new Error('maxFileSizeMB must be a non-negative number');
    mf.maxFileSizeMB = m;
  }
  await saveManifest(pdir, mf);
  return mf;
}

export async function requireProject(ProjectID: string): Promise<{ pdir: string; mf: Manifest }> {
  const pdir = projectDir(ProjectID);
  const mf = await loadManifest(pdir);
  if (!mf) throw new Error('Project not found: ' + ProjectID + ' (run init first)');
  return { pdir, mf };
}

// Normalized mounts: { mountKey: absolutePath }.
export function normalizeMounts(mf: Manifest): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  const configs = normalizeMountConfigs(mf);
  for (const k of Object.keys(configs)) out[k] = configs[k].path;
  return out;
}

// Full mount configs including each mount's own (isolated) ignore file.
export function normalizeMountConfigs(mf: Manifest): { [key: string]: MountConfig } {
  const out: { [key: string]: MountConfig } = {};
  if (mf.mounts && typeof mf.mounts === 'object') {
    for (const k of Object.keys(mf.mounts)) {
      const v = (mf.mounts as any)[k];
      if (v && typeof v === 'object') {
        out[k] = { path: v.path, ignorePath: v.ignorePath ?? null };
      } else {
        out[k] = { path: String(v), ignorePath: null };
      }
    }
  } else {
    out._main = { path: mf.rootPath, ignorePath: null };
  }
  return out;
}

// Reject any relative path escaping the mount root ('.' or '..' segments,
// backslashes). Called before any rel path is joined to a base directory.
export function assertSafeRelPath(rel: string): string {
  if (!rel) throw new Error('Relative path cannot be empty');
  if (rel.indexOf('\\') >= 0) throw new Error('Backslash not allowed in relative path');
  const parts = rel.split('/');
  for (const seg of parts) {
    if (seg === '.' || seg === '..') {
      throw new Error('Path traversal denied: ' + rel);
    }
  }
  return rel;
}

// Resolve a user RelPath into either { all:true } or { mount, relPath }.
export function parseRelPath(mf: Manifest, input: string): ResolvedPath {
  const mounts = normalizeMounts(mf);
  const s = String(input || '').trim();
  if (!s) throw new Error('RelPath cannot be empty');
  if (s === '.') return { all: true };
  if (s.startsWith('/')) {
    let bestMount: string | null = null;
    let bestLen = -1;
    for (const k of Object.keys(mounts)) {
      const base = mounts[k];
      const norm = base.endsWith('/') ? base : base + '/';
      if (s === base || s.startsWith(norm)) {
        if (base.length > bestLen) { bestLen = base.length; bestMount = k; }
      }
    }
    if (!bestMount) throw new Error('Absolute path is not inside any registered mount: ' + s);
    const base = mounts[bestMount];
    const rel = s === base ? '' : s.slice(base.length).replace(/^\/+/, '');
    if (!rel) throw new Error('Cannot target a mount root itself; specify a file (or use . for all)');
    return { mount: bestMount, relPath: assertSafeRelPath(rel) };
  }
  if (Object.keys(mounts).length > 1) {
    const idx = s.indexOf('/');
    if (idx <= 0) throw new Error('Multi-mount projects require a mount prefix (_main/xxx or {mountKey}/xxx), got: ' + s);
    const m = s.slice(0, idx);
    if (!(m in mounts)) throw new Error('Unknown mount key: ' + m + '; available: ' + Object.keys(mounts).join(', '));
    return { mount: m, relPath: assertSafeRelPath(s.slice(idx + 1)) };
  }
  if (s.startsWith('_main/')) return { mount: '_main', relPath: assertSafeRelPath(s.slice('_main/'.length)) };
  return { mount: '_main', relPath: assertSafeRelPath(s) };
}

// .gitignore loading with mount scoping:
// - global:   manifest.ignorePath (top-level UseIgnore entry / OtherParam
//   metadata update) -> applies to every mount.
// - perMount: each mount's own UseIgnore (declared inside its entry) plus its
//   root .gitignore (auto-discovered) -> applies ONLY to that mount, never
//   bleeding into other mounts (mount-local ignore is isolated).
export interface IgnoreContext {
  global: IgnoreRule[];
  perMount: { [key: string]: IgnoreRule[] };
}

export async function loadIgnoreRulesAll(mf: Manifest): Promise<IgnoreContext> {
  const configs = normalizeMountConfigs(mf);
  const global: IgnoreRule[] = [];
  if (mf.ignorePath && (await fsExists(mf.ignorePath))) {
    global.push(...compileGitignore(await fsReadText(mf.ignorePath)));
  }
  const perMount: { [key: string]: IgnoreRule[] } = {};
  for (const k of Object.keys(configs)) {
    const cfg = configs[k];
    const rules: IgnoreRule[] = [];
    if (cfg.ignorePath) {
      const ip = cfg.ignorePath;
      if (ip !== mf.ignorePath && (await fsExists(ip))) {
        rules.push(...compileGitignore(await fsReadText(ip)));
      }
    }
    const gi = cfg.path + '/.gitignore';
    if (gi !== mf.ignorePath && gi !== cfg.ignorePath && (await fsExists(gi))) {
      rules.push(...compileGitignore(await fsReadText(gi)));
    }
    perMount[k] = rules;
  }
  return { global, perMount };
}

// Recursive tree walk; skips the snapshot data root itself to avoid self capture.
// ignoreRules apply only to untracked files (matching git): tracked keys passed
// in trackedKeys (relative paths, true) are kept even when ignored. A directory
// ignored by the rules is pruned unless a tracked file lives under it.
export async function scanTree(
  basePath: string,
  ignoreRules: IgnoreRule[],
  skipPath: string,
  trackedKeys?: { [key: string]: boolean }
): Promise<Array<{ full: string; rel: string; size: number }>> {
  const out: Array<{ full: string; rel: string; size: number }> = [];
  const snapRoot = getSnapshotRoot();
  function hasTrackedUnder(prefix: string): boolean {
    if (!trackedKeys) return false;
    for (const k of Object.keys(trackedKeys)) {
      if (k.startsWith(prefix)) return true;
    }
    return false;
  }
  async function walk(dir: string, rel: string): Promise<void> {
    const listing = await fsList(dir);
    const entries = (listing && listing.entries) || [];
    for (const ent of entries) {
      const childAbs = dir + '/' + ent.name;
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (snapRoot && (childAbs === snapRoot || childAbs.startsWith(snapRoot + '/'))) continue;
      if (skipPath && (childAbs === skipPath || childAbs.startsWith(skipPath + '/'))) continue;
      if (ent.isDirectory) {
        if (ignoreRules && ignoreRules.length && gitignoreIsIgnored(ignoreRules, childRel, true)) {
          // Ignored untracked dir: prune unless it contains tracked files.
          if (!hasTrackedUnder(childRel + '/')) continue;
        }
        await walk(childAbs, childRel);
      } else {
        if (ignoreRules && ignoreRules.length && gitignoreIsIgnored(ignoreRules, childRel, false)) {
          // Ignore applies only to untracked files; tracked ones stay visible.
          if (!trackedKeys || !trackedKeys[childRel]) continue;
        }
        out.push({ full: childAbs, rel: childRel, size: ent.size });
      }
    }
  }
  await walk(basePath, '');
  return out;
}