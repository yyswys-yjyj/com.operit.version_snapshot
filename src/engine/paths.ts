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
  mounts?: { [key: string]: { path: string } };
  ignorePath?: string | null;
}

export interface ResolvedPath {
  all?: boolean;
  mount?: string;
  relPath?: string;
}

export function projectDir(ProjectID: string): string {
  if (!ProjectID || typeof ProjectID !== 'string') throw new Error('ProjectID cannot be empty');
  if (/[\\/:*?"<>|\s]/.test(ProjectID)) {
    throw new Error('ProjectID cannot contain \\ / : * ? " < > | or whitespace');
  }
  return getSnapshotRoot() + '/' + ProjectID;
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

export async function requireProject(ProjectID: string): Promise<{ pdir: string; mf: Manifest }> {
  const pdir = projectDir(ProjectID);
  const mf = await loadManifest(pdir);
  if (!mf) throw new Error('Project not found: ' + ProjectID + ' (run init first)');
  return { pdir, mf };
}

// Normalized mounts: { mountKey: absolutePath }.
export function normalizeMounts(mf: Manifest): { [key: string]: string } {
  const mounts: { [key: string]: string } = {};
  if (mf.mounts && typeof mf.mounts === 'object') {
    for (const k of Object.keys(mf.mounts)) {
      const v = (mf.mounts as any)[k];
      mounts[k] = v && typeof v === 'object' ? v.path : v;
    }
  } else {
    mounts._main = mf.rootPath;
  }
  return mounts;
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
    return { mount: bestMount, relPath: rel };
  }
  if (Object.keys(mounts).length > 1) {
    const idx = s.indexOf('/');
    if (idx <= 0) throw new Error('Multi-mount projects require a mount prefix (_main/xxx or {mountKey}/xxx), got: ' + s);
    const m = s.slice(0, idx);
    if (!(m in mounts)) throw new Error('Unknown mount key: ' + m + '; available: ' + Object.keys(mounts).join(', '));
    return { mount: m, relPath: s.slice(idx + 1) };
  }
  if (s.startsWith('_main/')) return { mount: '_main', relPath: s.slice('_main/'.length) };
  return { mount: '_main', relPath: s };
}

// .gitignore rules from UseIgnore path + each mount root's own .gitignore.
export async function loadIgnoreRulesAll(mf: Manifest): Promise<IgnoreRule[]> {
  const mounts = normalizeMounts(mf);
  let rules: IgnoreRule[] = [];
  if (mf.ignorePath && (await fsExists(mf.ignorePath))) {
    rules = rules.concat(compileGitignore(await fsReadText(mf.ignorePath)));
  }
  for (const k of Object.keys(mounts)) {
    const gi = mounts[k] + '/.gitignore';
    if (gi !== mf.ignorePath && (await fsExists(gi))) {
      rules = rules.concat(compileGitignore(await fsReadText(gi)));
    }
  }
  return rules;
}

// Recursive tree walk; skips the snapshot data root itself to avoid self capture.
export async function scanTree(
  basePath: string,
  ignoreRules: IgnoreRule[],
  skipPath: string
): Promise<Array<{ full: string; rel: string; size: number }>> {
  const out: Array<{ full: string; rel: string; size: number }> = [];
  const snapRoot = getSnapshotRoot();
  async function walk(dir: string, rel: string): Promise<void> {
    const listing = await fsList(dir);
    const entries = (listing && listing.entries) || [];
    for (const ent of entries) {
      const childAbs = dir + '/' + ent.name;
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (snapRoot && (childAbs === snapRoot || childAbs.startsWith(snapRoot + '/'))) continue;
      if (skipPath && (childAbs === skipPath || childAbs.startsWith(skipPath + '/'))) continue;
      if (ent.isDirectory) {
        if (ignoreRules && ignoreRules.length && gitignoreIsIgnored(ignoreRules, childRel, true)) continue;
        await walk(childAbs, childRel);
      } else {
        if (ignoreRules && ignoreRules.length && gitignoreIsIgnored(ignoreRules, childRel, false)) continue;
        out.push({ full: childAbs, rel: childRel, size: ent.size });
      }
    }
  }
  await walk(basePath, '');
  return out;
}