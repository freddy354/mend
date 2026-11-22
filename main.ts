// mend: the CLI SPEC.md specifies. Node 22, standard library alone.
// Run as `node main.ts [options] [PATCH]`.
// Implements SPEC.md sections 1-10: CLI, output/exit codes, safe paths,
// format detection, line matching at three tiers, unified diffs,
// SEARCH/REPLACE blocks, V4A patches, JSON edits, and all-or-nothing write.
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------- file model (SPEC section 3) ----------
interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}
function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { lines: parts, br, final };
}
function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}
function createdFile(lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (final ? '\n' : '');
}

// ---------- matching (SPEC section 5) ----------
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0]! : '';
};
function lineMatches(fileLine: string, oLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === oLine;
  if (tier === 1) return stripTrail(fileLine) === stripTrail(oLine);
  return stripBoth(fileLine) === stripBoth(oLine);
}
interface TierHit {
  tier: number;
  positions: number[];
}
/** First tier (0,1,2; or only 0 when strict) at which O occurs at least once, from `from`. */
function findTier(lines: string[], o: string[], from: number, strict: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    if (o.length === 0) return { tier, positions };
    for (let i = from; i + o.length <= lines.length; i++) {
      let ok = true;
      for (let k = 0; k < o.length; k++) {
        if (!lineMatches(lines[i + k]!, o[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

interface Elem {
  type: 'context' | 'old' | 'new';
  text: string;
  noNL: boolean;
}
/** Build the replacement lines for an O/N pair matched at `pos` at `tier`. */
function constructN(oElems: Elem[], nElems: Elem[], fileLines: string[], pos: number, tier: number): string[] {
  // Context lines in N map, in order, to the file's own matched lines.
  const ctxFile: string[] = [];
  oElems.forEach((e, idx) => {
    if (e.type === 'context') ctxFile.push(fileLines[pos + idx]!);
  });
  const oTexts = oElems.map((e) => e.text);
  const pLead = oTexts.length > 0 ? leadingWs(oTexts[0]!) : '';
  const fLead = fileLines.length > pos ? leadingWs(fileLines[pos]!) : '';
  let ctxIdx = 0;
  const out: string[] = [];
  for (const e of nElems) {
    if (e.type === 'context') {
      out.push(ctxFile[ctxIdx++]!);
    } else {
      const t = e.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(pLead)) {
        out.push(fLead + t.slice(pLead.length));
      } else {
        out.push(t);
      }
    }
  }
  return out;
}
/** Same re-indentation for a plain old->new replacement (SEARCH/REPLACE). */
function reindentNew(oLines: string[], nLines: string[], fileLines: string[], pos: number, tier: number): string[] {
  if (tier !== 2) return [...nLines];
  const pLead = oLines.length > 0 ? leadingWs(oLines[0]!) : '';
  const fLead = fileLines.length > pos ? leadingWs(fileLines[pos]!) : '';
  return nLines.map((t) => {
    if (t !== '' && t.trim() !== '' && t.startsWith(pLead)) return fLead + t.slice(pLead.length);
    return t;
  });
}

// ---------- tree (SPEC section 10) ----------
/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** src.get(p): the path the file now at p originally came from (itself unless moved). */
  readonly src = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  set(p: string, text: string): void {
    if (!this.src.has(p)) {
      // A path that existed before keeps itself as source; a new file is its own source.
      this.src.set(p, p);
    }
    this.now.set(p, text);
  }
  del(p: string): void {
    this.src.delete(p);
    this.now.set(p, null);
  }
  move(oldP: string, newP: string, text: string): void {
    const s = this.src.get(oldP) ?? oldP;
    this.src.delete(oldP);
    this.src.set(newP, s);
    this.now.set(oldP, null);
    this.now.set(newP, text);
  }
  snapshot(): { now: Map<string, string | null>; src: Map<string, string> } {
    return { now: new Map(this.now), src: new Map(this.src) };
  }
  restore(s: { now: Map<string, string | null>; src: Map<string, string> }): void {
    this.now.clear();
    for (const [k, v] of s.now) this.now.set(k, v);
    this.src.clear();
    for (const [k, v] of s.src) this.src.set(k, v);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- JSON (SPEC section 9; starter logic, adapted to Tree helpers) ----------
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- unified diffs (SPEC section 6) ----------
interface Hunk {
  a: number;
  elems: Elem[];
}
interface UnifiedSection {
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}
function unifiedPath(line: string): string {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}
function parseUnified(lines: string[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let hasHunks = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { pairOld: null, pairNew: null, renameFrom: null, renameTo: null, diffOld: m[1]!, diffNew: m[2]!, isNew: false, isDeleted: false, hunks: [] };
      sections.push(cur);
      hasHunks = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A ---/+++ pair before the section's first hunk names the section's
      // paths (SPEC section 6: "Within a section, before its first hunk:
      // --- <path> and +++ <path> name the old and new path"), even when an
      // earlier pair already did so; the later pair replaces the earlier
      // one. A pair only starts a new section once the current section has
      // hunks (or there is no current section).
      if (cur !== null && !hasHunks) {
        cur.pairOld = unifiedPath(line);
        cur.pairNew = unifiedPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      cur = { pairOld: unifiedPath(line), pairNew: unifiedPath(lines[i + 1]!), renameFrom: null, renameTo: null, diffOld: null, diffNew: null, isNew: false, isDeleted: false, hunks: [] };
      sections.push(cur);
      hasHunks = false;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && !hasHunks) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      let j = i + 1;
      const body: string[] = [];
      while (j < n) {
        const lj = lines[j]!;
        if (lj.startsWith('diff --git ')) break;
        if (lj.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (lj.startsWith(' ') || lj.startsWith('-') || lj.startsWith('+') || lj.startsWith('\\') || lj === '') {
          body.push(lj);
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const elems: Elem[] = [];
      for (const bl of body) {
        if (bl.startsWith('\\')) {
          if (elems.length > 0) elems[elems.length - 1]!.noNL = true;
        } else if (bl.startsWith(' ')) {
          elems.push({ type: 'context', text: bl.slice(1), noNL: false });
        } else if (bl.startsWith('-')) {
          elems.push({ type: 'old', text: bl.slice(1), noNL: false });
        } else if (bl.startsWith('+')) {
          elems.push({ type: 'new', text: bl.slice(1), noNL: false });
        } else {
          elems.push({ type: 'context', text: '', noNL: false });
        }
      }
      cur.hunks.push({ a, elems });
      hasHunks = true;
      i = j;
      continue;
    }
    if (cur !== null && !hasHunks) {
      // rename from/to name the same old/new paths as ---/+++, so the
      // leading a/ or b/ git prefix section 6 removes from either path is
      // removed here too.
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim().replace(/^[ab]\//, '');
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim().replace(/^[ab]\//, '');
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDeleted = true;
      // index, old/new mode, similarity, dissimilarity, Index: and any other line: ignored.
    }
    // Outside bodies, other lines are ignored (prose, code fences).
    i++;
  }
  return sections.map((sec) => unifiedEdit(sec, strictGlobal));
}

// `strict` is set by run() before parsing; parsers read it via this module-level binding.
let strictGlobal = false;

function applyUnifiedHunk(state: FileState, hunk: Hunk, d: number, path: string, strict: boolean): number {
  const oElems = hunk.elems.filter((e) => e.type !== 'new');
  const nElems = hunk.elems.filter((e) => e.type !== 'old');
  const oTexts = oElems.map((e) => e.text);
  if (oElems.length === 0) {
    const pos = Math.min(Math.max(hunk.a + d, 0), state.lines.length);
    const atEnd = pos === state.lines.length;
    const nTexts = nElems.map((e) => e.text);
    state.lines.splice(pos, 0, ...nTexts);
    if (atEnd && nElems.length > 0) {
      const last = nElems[nElems.length - 1]!;
      state.final = !last.noNL;
    }
    return nElems.length - oElems.length;
  }
  const hit = findTier(state.lines, oTexts, 0, strict);
  if (hit === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = hit.positions[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of hit.positions) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const pos = best;
  const touchEnd = pos + oElems.length === state.lines.length;
  const newLines = constructN(oElems, nElems, state.lines, pos, hit.tier);
  state.lines.splice(pos, oElems.length, ...newLines);
  if (touchEnd) {
    if (nElems.length === 0) state.final = true;
    else state.final = !nElems[nElems.length - 1]!.noNL;
  }
  return nElems.length - oElems.length;
}

function unifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  const oldP = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
  const newP = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
  const isCreation = oldP === '/dev/null' || sec.isNew;
  const isDeletion = newP === '/dev/null' || sec.isDeleted;
  return (tree) => {
    if (isCreation) {
      const target = newP;
      if (target === null) return;
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: Elem[] = [];
      for (const h of sec.hunks) for (const e of h.elems) if (e.type === 'new') plus.push(e);
      const lines = plus.map((e) => e.text);
      let final = true;
      if (plus.length > 0) final = !plus[plus.length - 1]!.noNL;
      tree.set(target, createdFile(lines, final));
      return;
    }
    if (isDeletion) {
      const target = oldP;
      if (target === null) return;
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.del(target);
      return;
    }
    const isMove = oldP !== null && newP !== null && oldP !== newP;
    if (isMove) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const state = parseFile(before);
      let d = 0;
      for (const h of sec.hunks) d += applyUnifiedHunk(state, h, d, oldP, strict);
      tree.move(oldP, newP, serializeFile(state));
      return;
    }
    const target = oldP ?? newP;
    if (target === null) return;
    if (!safe(target)) throw new Fail('unsafe', target);
    const before = tree.get(target);
    if (before === null) throw new Fail('missing', target);
    const state = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) d += applyUnifiedHunk(state, h, d, target, strict);
    tree.set(target, serializeFile(state));
  };
}

// ---------- SEARCH/REPLACE (SPEC section 7) ----------
function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    let sep = -1;
    for (let k = i + 1; k < n; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let k = sep + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push(searchReplaceEdit(p, oldLines, newLines, strictGlobal));
    prevPath = p;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

function searchReplaceEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, createdFile(newLines, newLines.length > 0));
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const state = parseFile(before);
    const hit = findTier(state.lines, oldLines, 0, strict);
    if (hit === null) throw new Fail('no-match', p);
    if (hit.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = hit.positions[0]!;
    const out = reindentNew(oldLines, newLines, state.lines, pos, hit.tier);
    state.lines.splice(pos, oldLines.length, ...out);
    tree.set(p, serializeFile(state));
  };
}

// ---------- V4A (SPEC section 8) ----------
interface V4AChunk {
  anchor: string | null;
  elems: Elem[];
  eof: boolean;
}
interface V4ASection {
  type: 'add' | 'delete' | 'update';
  path: string;
  startLine: number;
  lines: string[]; // add-file lines
  moveTo: string | null;
  chunks: V4AChunk[];
}
const V4A_PREFIXES: Array<[string, 'add' | 'delete' | 'update']> = [
  ['*** Add File: ', 'add'],
  ['*** Delete File: ', 'delete'],
  ['*** Update File: ', 'update'],
];
function parseV4A(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let matched: { type: 'add' | 'delete' | 'update'; path: string } | null = null;
    for (const [prefix, type] of V4A_PREFIXES) {
      if (line.startsWith(prefix)) {
        matched = { type, path: line.slice(prefix.length).trim() };
        break;
      }
    }
    if (matched === null) throw new Exit2(`error: parse ${i + 1}`);
    const startLine = i + 1;
    const raw: Array<{ text: string; num: number }> = [];
    i++;
    while (i < last) {
      const l = lines[i]!;
      let isStart = false;
      for (const [prefix] of V4A_PREFIXES) if (l.startsWith(prefix)) isStart = true;
      if (isStart) break;
      raw.push({ text: l, num: i + 1 });
      i++;
    }
    while (raw.length > 0 && raw[raw.length - 1]!.text.trim() === '') raw.pop();
    edits.push(v4aEdit(parseV4ASection(matched.type, matched.path, startLine, raw), strictGlobal));
  }
  return edits;
}

function parseV4ASection(type: 'add' | 'delete' | 'update', path: string, startLine: number, raw: Array<{ text: string; num: number }>): V4ASection {
  if (type === 'add') {
    const fileLines: string[] = [];
    for (const r of raw) {
      if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
      else if (r.text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${r.num}`);
    }
    return { type, path, startLine, lines: fileLines, moveTo: null, chunks: [] };
  }
  if (type === 'delete') {
    for (const r of raw) {
      if (r.text.trim() === '') continue;
      throw new Exit2(`error: parse ${r.num}`);
    }
    return { type, path, startLine, lines: [], moveTo: null, chunks: [] };
  }
  // update
  let moveTo: string | null = null;
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  const pushCur = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  raw.forEach((r, idx) => {
    const text = r.text;
    if (idx === 0 && text.startsWith('*** Move to: ')) {
      moveTo = text.slice('*** Move to: '.length).trim();
      return;
    }
    if (text.startsWith('@@')) {
      pushCur();
      cur = { anchor: text.slice(2).trim(), elems: [], eof: false };
      return;
    }
    if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.num}`);
      cur.eof = true;
      pushCur();
      return;
    }
    if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+') || text === '') {
      if (cur === null) {
        if (chunks.length === 0) {
          cur = { anchor: null, elems: [], eof: false };
        } else {
          throw new Exit2(`error: parse ${r.num}`);
        }
      }
      if (text === '') cur.elems.push({ type: 'context', text: '', noNL: false });
      else if (text.startsWith(' ')) cur.elems.push({ type: 'context', text: text.slice(1), noNL: false });
      else if (text.startsWith('-')) cur.elems.push({ type: 'old', text: text.slice(1), noNL: false });
      else cur.elems.push({ type: 'new', text: text.slice(1), noNL: false });
      return;
    }
    throw new Exit2(`error: parse ${r.num}`);
  });
  pushCur();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
  return { type, path, startLine, lines: [], moveTo, chunks };
}

function v4aEdit(sec: V4ASection, strict: boolean): Edit {
  return (tree) => {
    if (sec.type === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.set(sec.path, createdFile(sec.lines, sec.lines.length > 0));
      return;
    }
    if (sec.type === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.del(sec.path);
      return;
    }
    // update
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const state = parseFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        const anchor = chunk.anchor;
        let found = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let k = cursor; k < state.lines.length; k++) {
            if (lineMatches(state.lines[k]!, anchor, tier)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', sec.path);
        cursor = found + 1;
      }
      const oElems = chunk.elems.filter((e) => e.type !== 'new');
      const nElems = chunk.elems.filter((e) => e.type !== 'old');
      const oTexts = oElems.map((e) => e.text);
      if (oElems.length === 0) {
        const pos = chunk.eof ? state.lines.length : cursor;
        const nTexts = nElems.map((e) => e.text);
        state.lines.splice(pos, 0, ...nTexts);
        cursor = pos + nTexts.length;
        continue;
      }
      const hit = findTier(state.lines, oTexts, cursor, strict);
      if (hit === null) throw new Fail('no-match', sec.path);
      let pos: number;
      if (chunk.eof) {
        const p = hit.positions.find((pp) => pp + oElems.length === state.lines.length);
        if (p === undefined) throw new Fail('no-match', sec.path);
        pos = p;
      } else {
        pos = hit.positions[0]!;
      }
      const newLines = constructN(oElems, nElems, state.lines, pos, hit.tier);
      state.lines.splice(pos, oElems.length, ...newLines);
      cursor = pos + newLines.length;
    }
    const out = serializeFile(state);
    if (sec.moveTo !== null) tree.move(sec.path, sec.moveTo, out);
    else tree.set(sec.path, out);
  };
}

// ---------- run (SPEC sections 1, 2, 10) ----------
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  strictGlobal = strict;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4A(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.restore(before);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: A/D/M, plus R for a net move (old deleted, new created, same source).
  interface Row {
    sortKey: string;
    line: string;
  }
  const rows: Row[] = [];
  const deleted = new Set<string>();
  const created = new Set<string>();
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null && now !== null) created.add(p);
    else if (was !== null && now === null) deleted.add(p);
    else rows.push({ sortKey: p, line: `M ${p}` });
  }
  const usedCreated = new Set<string>();
  const usedDeleted = new Set<string>();
  for (const p of [...created]) {
    const srcPath = tree.src.get(p) ?? p;
    if (srcPath !== p && deleted.has(srcPath)) {
      rows.push({ sortKey: p, line: `R ${srcPath} -> ${p}` });
      usedCreated.add(p);
      usedDeleted.add(srcPath);
    }
  }
  for (const p of [...created]) if (!usedCreated.has(p)) rows.push({ sortKey: p, line: `A ${p}` });
  for (const p of [...deleted]) if (!usedDeleted.has(p)) rows.push({ sortKey: p, line: `D ${p}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    // Write in sorted order; deletions of a path sort before creations under it.
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
