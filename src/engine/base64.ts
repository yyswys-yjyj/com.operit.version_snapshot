// base64 / bytes / filesystem helpers over Java bridge and Tools.Files.
// All persistence goes through Java bridge + Tools.Files, never the terminal.

export const DR_START = '<<<DESTROY';
export const DR_END = '>>>REWRITE';
export const DEFAULT_MAX_FILE_MB = 10;

// Common binary extensions used as a fast pre-check; NUL-byte detection is the fallback.
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'avif',
  'pdf', 'zip', 'gz', 'tar', 'rar', '7z', 'bz2', 'xz', 'zst',
  'apk', 'dex', 'so', 'a', 'class', 'jar', 'db', 'sqlite', 'sqlite3', 'mdb',
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'flv', 'wmv', 'flac', 'wav', 'ogg', 'opus', 'm4a', 'aac',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'bin', 'exe', 'dll', 'obj', 'o',
  'pyc', 'pyo', 'wasm', 'chc', 'dat', 'pak', 'idx', 'iso', 'img', 'keystore',
  'xls', 'xlsx', 'doc', 'docx', 'ppt', 'pptx', 'vsd', 'psd', 'ai', 'sketch',
  'war', 'ear', 'jad', 'pcap',
]);

export function nowIso(): string {
  const d = new Date();
  const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  );
}

// ---- Java bridge: plugin storage root ----
export function getExternalFilesRoot(): string | null {
  const AT = (Java as any).type('android.app.ActivityThread');
  const app = AT.currentApplication();
  const ctx = app.getApplicationContext();
  const ext = ctx.getExternalFilesDir(null);
  return ext ? ext.getAbsolutePath() : null;
}

// Snapshot data root. Kept under Operit's public data dir so records survive
// app data cleanup and are user-visible/backup-able. NOT inside app-private storage.
export function getSnapshotRoot(): string {
  return '/storage/emulated/0/Download/Operit/SnapshotDatabase';
}

// Ensure the snapshot root directory exists.
export function ensureSnapshotRoot(): Promise<any> {
  return fsMkdir(getSnapshotRoot(), true);
}

// ---- base64 / bytes ----
function b64ToBytes(b64: string): any {
  const B64 = (Java as any).type('android.util.Base64');
  return B64.decode(String(b64), 0);
}
function bytesToUtf8(bytes: any): string {
  const JString = (Java as any).type('java.lang.String');
  return JString.newInstance(bytes, 'UTF-8').toString();
}
function utf8ToB64(text: string): string {
  const B64 = (Java as any).type('android.util.Base64');
  const JString = (Java as any).type('java.lang.String');
  return B64.encodeToString(JString.newInstance(String(text)).getBytes('UTF-8'), 0);
}
function bytesContainNul(bytes: any): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}
function looksBinaryByExt(name: string): boolean {
  const idx = name.lastIndexOf('.');
  if (idx < 0) return false;
  return BINARY_EXT.has(name.slice(idx + 1).toLowerCase());
}

// Read a file as { isBinary, content }. isBinary=0 -> UTF-8 text, isBinary=1 -> base64.
export async function readFileToEntry(fullPath: string): Promise<{ isBinary: number; content: string }> {
  const bin = await (Tools as any).Files.readBinary(fullPath, 'android');
  const b64 = bin && bin.contentBase64 ? String(bin.contentBase64) : '';
  const bytes = b64ToBytes(b64);
  const hasNul = bytesContainNul(bytes);
  const isBinary = hasNul || looksBinaryByExt(String(fullPath).split('/').pop() || '');
  return { isBinary: isBinary ? 1 : 0, content: isBinary ? b64 : bytesToUtf8(bytes) };
}

// Write a record back to disk.
export async function writeEntryToFile(fullPath: string, content: string, isBinary: number | string | undefined): Promise<void> {
  const text = content === null || content === undefined ? '' : String(content);
  if (Number(isBinary) === 1) {
    await (Tools as any).Files.writeBinary(fullPath, text, 'android');
  } else {
    await (Tools as any).Files.write(fullPath, text, false, 'android');
  }
}

// ---- filesystem helpers (Android environment) ----
export async function fsExists(path: string): Promise<boolean> {
  const r = await (Tools as any).Files.exists(path, 'android');
  return !!(r && r.exists);
}
export async function fsMkdir(path: string, parents?: boolean): Promise<any> {
  return (Tools as any).Files.mkdir(path, parents === undefined ? true : parents, 'android');
}
export async function fsDelete(path: string, recursive?: boolean): Promise<any> {
  return (Tools as any).Files.deleteFile(path, recursive === undefined ? true : recursive, 'android');
}
export async function fsList(path: string): Promise<any> {
  return (Tools as any).Files.list(path, 'android');
}
export async function fsCopy(src: string, dst: string, recursive?: boolean): Promise<any> {
  return (Tools as any).Files.copy(src, dst, recursive === undefined ? true : recursive, 'android', 'android');
}
export async function fsReadText(path: string): Promise<string> {
  const r = await (Tools as any).Files.read(path, 'android');
  return r && r.content !== undefined ? String(r.content) : '';
}