// Full-syntax .gitignore parser: * ? [] ** anchored / negation ! dir rules.
// git-like matching: iterate path segments, last matching rule wins; a parent dir
// ignored by a rule shadows everything below unless a deeper negation matches later.

export interface IgnoreRule {
  negated: boolean;
  dirOnly: boolean;
  regex: RegExp | null;
  raw: string;
}

function globToRegExp(glob: string): RegExp {
  let out = '';
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else if (c === '[') {
      let j = i + 1;
      let neg = false;
      if (glob[j] === '!' || glob[j] === '^') { neg = true; j++; }
      if (glob[j] === ']') j++;
      let cls = '';
      let closed = false;
      while (j < n) {
        if (glob[j] === ']') { closed = true; break; }
        cls += glob[j]; j++;
      }
      if (!closed) { out += '\\['; i++; }
      else {
        if (cls[0] === '^') cls = '\\' + cls;
        let inner = '';
        for (let k = 0; k < cls.length; k++) {
          const ch = cls[k];
          if (ch === '\\' || ch === ']' || ch === '[') inner += '\\' + ch;
          else inner += ch;
        }
        out += '[' + (neg ? '^' : '') + inner + ']';
        i = j + 1;
      }
    } else if (c === '/') {
      out += '/';
      i++;
    } else if ('\\^$.|+(){}'.indexOf(c) >= 0) {
      out += '\\' + c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return new RegExp('^' + out + '$');
}

export function compileGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  if (!text) return rules;
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    let line = raw.replace(/\s+$/, '');
    if (!line) continue;
    if (line[0] === '#') continue;
    let negated = false;
    if (line[0] === '!') { negated = true; line = line.slice(1); }
    else if (line[0] === '\\' && (line[1] === '!' || line[1] === '#')) { line = line.slice(1); }
    if (!line) continue;
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    let anchored = false;
    if (line.startsWith('/')) { anchored = true; line = line.slice(1); }
    if (!line) continue;
    if (!anchored && !line.includes('/')) {
      line = '**/' + line;
    }
    let regex: RegExp | null = null;
    try { regex = globToRegExp(line); } catch (e) { regex = null; }
    if (!regex) continue;
    rules.push({ negated, dirOnly, regex, raw });
  }
  return rules;
}

export function gitignoreIsIgnored(rules: IgnoreRule[], relPath: string, isDir: boolean): boolean {
  if (!relPath) return false;
  const parts = relPath.split('/');
  let ignored = false;
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.slice(0, i + 1).join('/');
    const prefixIsDir = (i < parts.length - 1) || isDir;
    let cur: boolean | null = null;
    for (const r of rules) {
      if (r.regex && r.regex.test(prefix)) {
        if (r.dirOnly && !prefixIsDir) continue;
        cur = r.negated ? false : true;
      }
    }
    if (cur !== null) ignored = cur;
    if (ignored && i < parts.length - 1) {
      // A parent dir is ignored; keep walking only if a deeper negation matches.
      let laterNegation = false;
      outer:
      for (let k = i + 1; k < parts.length; k++) {
        const p2 = parts.slice(0, k + 1).join('/');
        const p2dir = (k < parts.length - 1) || isDir;
        for (const r of rules) {
          if (r.negated && r.regex && r.regex.test(p2) && (!r.dirOnly || p2dir)) { laterNegation = true; break outer; }
        }
      }
      if (!laterNegation) return true;
    }
  }
  return ignored;
}