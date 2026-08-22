// DESTROY/REWRITE storage format for rewritten/deleted node files.
//
// content layout:
//   <<<DESTROY
//   (content before entering this node / before deletion)
//   >>>REWRITE
//   (final content of this node; all '-' lines when marked deleted)
//
// Repeated rewrites of the same node file only replace the REWRITE region,
// keeping a single DESTROY segment. Restore/rollback always reads the REWRITE
// region (or the raw content when the block markers are absent).

import { DR_START, DR_END } from './base64';

export function packDr(original: string | null | undefined, rewritten: string | null | undefined): string {
  const orig = original === null || original === undefined ? '' : String(original);
  const neww = rewritten === null || rewritten === undefined ? '' : String(rewritten);
  if (orig === '') return neww;
  return DR_START + '\n' + orig + '\n' + DR_END + '\n' + neww;
}

export interface DrSplit {
  original: string | null;
  rewritten: string;
}

export function splitDr(content: string | null | undefined): DrSplit {
  if (content === null || content === undefined) return { original: null, rewritten: '' };
  const s = String(content);
  const si = s.indexOf(DR_START);
  const ei = s.indexOf(DR_END);
  if (si >= 0 && ei > si) {
    let original = s.slice(si + DR_START.length, ei);
    if (original.startsWith('\n')) original = original.slice(1);
    if (original.endsWith('\n')) original = original.slice(0, -1);
    let rewritten = s.slice(ei + DR_END.length);
    if (rewritten.startsWith('\n')) rewritten = rewritten.slice(1);
    return { original, rewritten };
  }
  return { original: null, rewritten: s };
}

export function getFinalContent(content: string | null | undefined): string {
  return splitDr(content).rewritten;
}

export function getOriginalContent(content: string | null | undefined): string | null {
  return splitDr(content).original;
}

// True when the REWRITE region is entirely '-' lines (deletion marker).
export function isDeleteMarked(content: string | null | undefined): boolean {
  const { rewritten } = splitDr(content);
  if (!rewritten) return false;
  const lines = rewritten.split('\n');
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  return nonEmpty.length > 0 && nonEmpty.every((l) => /^-+$/.test(l.trim()));
}

// Build deletion content: REWRITE region filled with '-' per original line.
export function makeDeleteContent(original: string | null | undefined): string {
  const orig = original === null || original === undefined ? '' : String(original);
  const lineCount = Math.max(1, orig.split('\n').length);
  const marker: string[] = [];
  for (let i = 0; i < lineCount; i++) marker.push('-');
  return packDr(orig, marker.join('\n'));
}

// Apply a rewrite to an existing content: replace REWRITE region only when
// a DESTROY block already exists; otherwise use the old content as DESTROY.
export function applyRewriteToContent(oldContent: string | null | undefined, newContent: string | null | undefined): string {
  const sp = splitDr(oldContent);
  if (sp.original !== null) {
    return packDr(sp.original, newContent);
  }
  return packDr(sp.rewritten, newContent);
}