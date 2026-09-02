// LaTeX-subset -> HTML renderer for the live preview panel.
// OWNER: preview agent.
//
// Everything text-bearing is escaped before it becomes HTML; only markup this
// module generates itself (tags, katex output) is trusted. Never insert raw
// user source into the output string.

import katex from 'katex';
import 'katex/dist/katex.min.css';

export interface RenderResult {
  html: string;
  mathCount: number;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

// Marker wrapped around the placeholders that stand in for extracted blocks.
// It must be a character a real document can never contain. U+E000 (the first
// Private Use Area code point) is *typeable* - Nerd Font / Powerline glyphs
// live there - so a pasted terminal glyph used to truncate the whole preview.
// NUL cannot appear in a text source, and is stripped from the input at the
// top of renderLatex regardless, so it can never collide with user content.
const SENTINEL = '\u0000';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// Schemes we are willing to put in an href. Anything else - `javascript:`,
// `data:`, `file:` - is refused: a .tex file is untrusted input (an arXiv
// source bundle, a collaborator's draft), and escaping the attribute stops
// breakout but says nothing about what the URL does when clicked.
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'ftp:', 'ftps:', 'tel:']);

/**
 * Returns a value safe to use as an href, or null when the scheme is not
 * allowed. A value with no scheme at all is a relative reference and is inert,
 * so it passes through (that is how `\url{example.com/x}` is usually written).
 */
export function safeUrl(raw: string): string | null {
  // Browsers ignore ASCII whitespace and control characters while parsing the
  // scheme, so `java\tscript:` is still `javascript:`. Drop them before the
  // test *and* from what we emit, so the two can never disagree.
  const value = raw.replace(/[\u0000-\u0020\u007f]/g, '');
  if (!value) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  if (!scheme) return value;
  return SAFE_URL_SCHEMES.has(`${scheme[1].toLowerCase()}:`) ? value : null;
}

function slug(s: string): string {
  const cleaned = s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'x';
}

// Brace matching is memoised per string. Callers walk a string and ask for the
// partner of every `{` they meet, and scanning forward from each one is
// quadratic as soon as a brace is unmatched: the scan then runs to the end of
// the string every time (measured on the UI thread: 50ms / 145ms / 542ms /
// 2721ms at 5k / 10k / 20k / 40k unmatched braces). Building the whole partner
// table in a single pass and reusing it keeps that walk linear.
//
// The cache is a tiny LRU rather than an unbounded map: the inline renderer
// recurses into substrings, so keying every string it ever sees would retain
// the whole document several times over. Recency is what matters - the string
// currently being walked must stay resident while it is being walked.
const BRACE_CACHE_MAX = 8;
const braceTableCache = new Map<string, Int32Array>();

function braceTable(s: string): Int32Array {
  const hit = braceTableCache.get(s);
  if (hit) {
    // refresh recency
    braceTableCache.delete(s);
    braceTableCache.set(s, hit);
    return hit;
  }
  const table = new Int32Array(s.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 /* \ */) {
      i++; // skip escaped char (e.g. \{ \})
      continue;
    }
    if (c === 123 /* { */) stack.push(i);
    else if (c === 125 /* } */) {
      const open = stack.pop();
      if (open !== undefined) table[open] = i;
    }
  }
  if (braceTableCache.size >= BRACE_CACHE_MAX) {
    const oldest = braceTableCache.keys().next();
    if (!oldest.done) braceTableCache.delete(oldest.value);
  }
  braceTableCache.set(s, table);
  return table;
}

// Finds the matching closing brace for an opening `{` at index `open`, or -1
// when it is unmatched (or `open` does not point at a brace at all).
function findMatchingBrace(s: string, open: number): number {
  if (s[open] !== '{') return -1;
  return braceTable(s)[open];
}

// Reads a `{...}` argument starting at index i (which must point at `{`).
// Returns null if there is no brace at i.
function readBraceArg(s: string, i: number): { content: string; end: number } | null {
  if (s[i] !== '{') return null;
  const close = findMatchingBrace(s, i);
  if (close === -1) return { content: s.slice(i + 1), end: s.length };
  return { content: s.slice(i + 1, close), end: close + 1 };
}

// Reads an optional `[...]` argument (no nesting support - fine for our subset).
function readBracketArg(s: string, i: number): { content: string; end: number } | null {
  if (s[i] !== '[') return null;
  const close = s.indexOf(']', i);
  if (close === -1) return null;
  return { content: s.slice(i + 1, close), end: close + 1 };
}

function extractCommandArg(text: string, name: string): string | null {
  const marker = `\\${name}`;
  let idx = text.indexOf(marker);
  while (idx !== -1) {
    const after = idx + marker.length;
    // must not be followed by a letter (so \title doesn't match \titlefoo)
    if (!/[a-zA-Z]/.test(text[after] ?? '')) {
      const arg = readBraceArg(text, after);
      if (arg) return arg.content;
    }
    idx = text.indexOf(marker, idx + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Context threaded through the whole render
// ---------------------------------------------------------------------------

interface MathBlock {
  html: string;
  /** True when the html is block-level markup that must not sit inside a <p>. */
  block: boolean;
}
interface VerbBlock {
  content: string;
  code: boolean; // true for lstlisting (code-styled), false for plain verbatim
  inline: boolean; // true for \verb|...| (inline <code>, not a block <pre>)
}
interface TableBlock {
  colSpec: string;
  rows: string[][];
}

interface Ctx {
  counters: {
    part: number;
    chapter: number;
    section: number;
    subsection: number;
    subsubsection: number;
    figure: number;
    table: number;
  };
  labelMap: Map<string, string>;
  citeMap: Map<string, number>;
  footnotes: string[];
  mathBlocks: MathBlock[];
  verbBlocks: VerbBlock[];
  tableBlocks: TableBlock[];
  currentFloat: { kind: string; num: number } | null;
  preamble: { title: string | null; author: string | null; date: string | null };
  pendingRefs: boolean; // set true if any \ref couldn't resolve yet
  eqCounter: number;
  pendingLabelNumber: string | null;
}

function makeCtx(): Ctx {
  return {
    counters: { part: 0, chapter: 0, section: 0, subsection: 0, subsubsection: 0, figure: 0, table: 0 },
    labelMap: new Map(),
    citeMap: new Map(),
    footnotes: [],
    mathBlocks: [],
    verbBlocks: [],
    tableBlocks: [],
    currentFloat: null,
    preamble: { title: null, author: null, date: null },
    pendingRefs: false,
    eqCounter: 0,
    pendingLabelNumber: null
  };
}

// ---------------------------------------------------------------------------
// Stage 1: one catcode-aware pass over the source
//
// Comments, verbatim environments and `\verb` cannot be separated into
// independent passes: `%` is an ordinary character inside a verbatim body or a
// `\verb` argument, and a `\begin{verbatim}` that sits behind a `%` is not an
// opener at all. Running them as two stages in either order loses a document:
// strip comments first and a `%` inside a listing eats the rest of that line;
// pull verbatim out first and a commented-out `\begin{lstlisting}` pairs with
// the next real `\end`, swallowing everything in between.
//
// So this is a single left-to-right scan that always knows which regime it is
// in. It emits placeholders for verbatim bodies and `\verb` arguments (their
// contents are not LaTeX and must never be parsed as such) and drops comments.
// ---------------------------------------------------------------------------

// Commands whose first brace argument is a URL / path rather than LaTeX text.
// TeX itself makes `%` an ordinary character there (that is the whole point of
// \url), so the scan has to step over the argument verbatim.
const URL_ARG_COMMANDS = new Set(['url', 'href', 'path']);

// Environments whose body is literal text rather than LaTeX. They do not nest
// (their contents are not parsed, so an inner `\begin` is just characters),
// which is why the first matching `\end` closes them.
const VERBATIM_ENVS = new Set(['verbatim', 'lstlisting']);

function pushVerb(ctx: Ctx, block: VerbBlock): string {
  const idx = ctx.verbBlocks.length;
  ctx.verbBlocks.push(block);
  return `${SENTINEL}V${idx}${SENTINEL}`;
}

/**
 * Matches `\begin{verbatim}` / `\begin{lstlisting}` (plus lstlisting's
 * optional `[key=value,...]` argument) at `i`, returning where the literal
 * body starts.
 */
function matchVerbatimBegin(src: string, i: number): { env: string; start: number } | null {
  const prefix = '\\begin{';
  if (!src.startsWith(prefix, i)) return null;
  const close = src.indexOf('}', i + prefix.length);
  if (close === -1) return null;
  const env = src.slice(i + prefix.length, close);
  if (!VERBATIM_ENVS.has(env)) return null;
  let start = close + 1;
  if (src[start] === '[') {
    const optClose = src.indexOf(']', start + 1);
    if (optClose !== -1) start = optClose + 1;
  }
  return { env, start };
}

/**
 * Matches `\verb<delim>...<delim>` (and `\verb*`) at `i`. The delimiter is any
 * character that is not a letter - a letter would make this a longer command
 * name such as `\verbatim` - and not whitespace or `*`. LaTeX forbids a line
 * break inside the argument, so an unterminated `\verb` is not a `\verb` at
 * all rather than something that eats the rest of the document.
 */
function matchVerb(src: string, i: number): { content: string; end: number } | null {
  const marker = '\\verb';
  if (!src.startsWith(marker, i)) return null;
  let j = i + marker.length;
  if (src[j] === '*') j++;
  const delim = src[j];
  if (delim === undefined || /[a-zA-Z*\s]/.test(delim)) return null;
  const close = src.indexOf(delim, j + 1);
  if (close === -1) return null;
  const content = src.slice(j + 1, close);
  if (content.includes('\n')) return null;
  return { content, end: close + 1 };
}

function scanSource(src: string, ctx: Ctx): string {
  const cmdRe = /\\([a-zA-Z]+)/y;
  let out = '';
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    if (c === '\\') {
      // verbatim / lstlisting: body is literal, `%` included
      const vb = matchVerbatimBegin(src, i);
      if (vb) {
        const endTag = `\\end{${vb.env}}`;
        const close = src.indexOf(endTag, vb.start);
        if (close !== -1) {
          // drop a single leading newline (common right after \begin{...})
          const content = src.slice(vb.start, close).replace(/^\n/, '').replace(/\n$/, '');
          out += pushVerb(ctx, { content, code: vb.env === 'lstlisting', inline: false });
          i = close + endTag.length;
          continue;
        }
        // No `\end`: not a verbatim block. Fall through and treat it as text
        // rather than consuming the rest of the document.
      }

      // \verb|...| : an inline literal
      const verb = matchVerb(src, i);
      if (verb) {
        out += pushVerb(ctx, { content: verb.content, code: true, inline: true });
        i = verb.end;
        continue;
      }

      // \url{...} & friends: the argument is copied through untouched
      cmdRe.lastIndex = i;
      const cmd = cmdRe.exec(src);
      if (cmd && URL_ARG_COMMANDS.has(cmd[1])) {
        out += cmd[0];
        let j = i + cmd[0].length;
        if (src[j] === '{') {
          const close = findMatchingBrace(src, j);
          const end = close === -1 ? src.length : close + 1;
          out += src.slice(j, end);
          j = end;
        }
        i = j;
        continue;
      }

      const next = src[i + 1];
      if (next === undefined) {
        out += c;
        i++;
        continue;
      }
      // any other escape sequence: copy the backslash and the char it escapes,
      // so `\%` stays a literal percent and `\\` stays a line break
      out += c + next;
      i += 2;
      continue;
    }

    if (c === '%') {
      // unescaped, and not inside verbatim or \verb: a comment to end of line
      while (i < n && src[i] !== '\n') i++;
      // leave the newline itself for the next iteration
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 1b: \newcommand macro expansion
//
// A document that defines `\newcommand{\vect}[1]{\mathbf{#1}}` and then writes
// `\vect{x}` is not using an unknown command - it is using one the document
// itself defined. Dropping it loses the author's own vocabulary, and it is
// exactly the vocabulary that carries the meaning. So definitions are collected
// and their uses substituted before anything else looks at the source, which is
// also what puts the expansion in front of math extraction: `\vect{x}` inside
// `$...$` has to reach KaTeX already expanded.
// ---------------------------------------------------------------------------

interface Macro {
  /** Number of `#n` parameters, including the optional one when present. */
  argc: number;
  /** Default for `#1` when the definition declares `[n][default]`, else null. */
  optDefault: string | null;
  body: string;
}

// A macro whose body mentions itself would otherwise expand forever, and a
// chain of doubling macros (`\newcommand{\d}{\d\d}`) blows up exponentially
// from a handful of characters. Depth alone does not bound that - each level
// doubles - so expansions are also counted and sized against one budget shared
// by the whole document.
const MAX_MACRO_DEPTH = 24;
const MAX_MACRO_EXPANSIONS = 5_000;
const MAX_MACRO_OUTPUT = 4_000_000;

interface MacroBudget {
  expansions: number;
  size: number;
}

const MACRO_DEFINERS = new Set(['newcommand', 'renewcommand', 'providecommand']);

/**
 * Reads the macro *name* of a definition: either `{\name}` or a bare `\name`.
 */
function readMacroName(s: string, i: number): { name: string; end: number } | null {
  let j = i;
  let braced = false;
  if (s[j] === '{') {
    braced = true;
    j++;
  }
  if (s[j] !== '\\') return null;
  const m = /^[a-zA-Z]+/.exec(s.slice(j + 1));
  if (!m) return null;
  j += 1 + m[0].length;
  if (braced) {
    while (s[j] === ' ') j++;
    if (s[j] !== '}') return null;
    j++;
  }
  return { name: m[0], end: j };
}

/**
 * Pulls every `\newcommand` / `\renewcommand` / `\providecommand` definition
 * out of the source, returning the source without them plus the macro table.
 * A definition we cannot parse is left in place untouched rather than guessed
 * at, so a malformed one degrades to the ordinary unknown-command path.
 */
function collectMacros(src: string): { text: string; macros: Map<string, Macro> } {
  const macros = new Map<string, Macro>();
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] !== '\\') {
      out += src[i];
      i++;
      continue;
    }
    const cmd = /^\\([a-zA-Z]+)/.exec(src.slice(i, i + 32));
    if (!cmd) {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (!MACRO_DEFINERS.has(cmd[1])) {
      out += cmd[0];
      i += cmd[0].length;
      continue;
    }
    let j = i + cmd[0].length;
    if (src[j] === '*') j++;
    const named = readMacroName(src, j);
    if (!named) {
      out += cmd[0];
      i += cmd[0].length;
      continue;
    }
    j = named.end;
    let argc = 0;
    let optDefault: string | null = null;
    const countArg = readBracketArg(src, j);
    if (countArg) {
      const parsed = parseInt(countArg.content.trim(), 10);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 9) {
        out += cmd[0];
        i += cmd[0].length;
        continue;
      }
      argc = parsed;
      j = countArg.end;
      const defArg = readBracketArg(src, j);
      if (defArg) {
        optDefault = defArg.content;
        j = defArg.end;
      }
    }
    const body = readBraceArg(src, j);
    if (!body || body.end > src.length) {
      out += cmd[0];
      i += cmd[0].length;
      continue;
    }
    macros.set(named.name, { argc, optDefault, body: body.content });
    // The definition itself produces no output. Swallow one trailing newline so
    // a preamble full of definitions does not leave a run of blank lines that
    // splits the following text into empty paragraphs.
    let k = body.end;
    while (src[k] === ' ' || src[k] === '\t') k++;
    if (src[k] === '\n') k++;
    i = k;
  }
  return { text: out, macros };
}

/** Substitutes `#1`..`#9` (and `##` -> `#`) in a macro body. */
function substituteMacroParams(body: string, args: string[]): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '\\' && body[i + 1] !== undefined) {
      out += body.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '#') {
      const next = body[i + 1];
      if (next === '#') {
        out += '#';
        i += 2;
        continue;
      }
      if (next !== undefined && next >= '1' && next <= '9') {
        out += args[Number(next) - 1] ?? '';
        i += 2;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

function expandMacros(
  s: string,
  macros: Map<string, Macro>,
  depth = 0,
  budget: MacroBudget = { expansions: MAX_MACRO_EXPANSIONS, size: MAX_MACRO_OUTPUT }
): string {
  if (macros.size === 0) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '\\') {
      out += s[i];
      i++;
      continue;
    }
    const cmd = /^\\([a-zA-Z]+)/.exec(s.slice(i, i + 64));
    if (!cmd) {
      out += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    const macro = macros.get(cmd[1]);
    if (!macro || depth >= MAX_MACRO_DEPTH || budget.expansions <= 0 || budget.size <= 0) {
      // Out of budget: leave the use unexpanded. It still shows up, via the
      // unknown-command fallback, instead of hanging the preview.
      out += cmd[0];
      i += cmd[0].length;
      continue;
    }
    let j = i + cmd[0].length;
    const args: string[] = [];
    if (macro.optDefault !== null) {
      const opt = readBracketArg(s, j);
      if (opt) {
        args.push(opt.content);
        j = opt.end;
      } else {
        args.push(macro.optDefault);
      }
    }
    let ok = true;
    while (args.length < macro.argc) {
      const brace = readBraceArg(s, j);
      if (!brace) {
        ok = false;
        break;
      }
      args.push(brace.content);
      j = brace.end;
    }
    if (!ok) {
      // Called with too few arguments (half-typed, most likely). Leave the use
      // alone; the unknown-command fallback will still show something.
      out += cmd[0];
      i += cmd[0].length;
      continue;
    }
    budget.expansions -= 1;
    const substituted = substituteMacroParams(macro.body, args);
    budget.size -= substituted.length;
    out += expandMacros(substituted, macros, depth + 1, budget);
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 2: math extraction
// ---------------------------------------------------------------------------

// KaTeX rendering is the most expensive step per equation, and the preview
// re-renders the whole document on every keystroke — so a document with N
// equations pays for all N on every keystroke even when only prose text
// changed and not one of them. Memoised by (displayMode, source): unlike
// `braceTableCache`, this is deliberately *not* cleared per render — the
// entries are small HTML strings, not document-sized buffers, and the whole
// point is to survive between keystrokes. Same bounded-LRU shape as
// `braceTable` above, sized for a document with a few hundred distinct
// equations rather than one string being walked.
const MATH_CACHE_MAX = 500;
const mathCache = new Map<string, string>();

function renderMath(src: string, displayMode: boolean): string {
  const key = (displayMode ? 'd' : 'i') + src;
  const hit = mathCache.get(key);
  if (hit !== undefined) {
    // refresh recency
    mathCache.delete(key);
    mathCache.set(key, hit);
    return hit;
  }

  let html: string;
  try {
    html = katex.renderToString(src, {
      displayMode,
      throwOnError: false,
      strict: 'ignore'
    });
  } catch {
    html = `<span class="tex-math-error">${escapeHtml(src)}</span>`;
  }

  if (mathCache.size >= MATH_CACHE_MAX) {
    const oldest = mathCache.keys().next();
    if (!oldest.done) mathCache.delete(oldest.value);
  }
  mathCache.set(key, html);
  return html;
}

function pushMath(ctx: Ctx, html: string, block = false): string {
  const idx = ctx.mathBlocks.length;
  ctx.mathBlocks.push({ html, block });
  return `${SENTINEL}M${idx}${SENTINEL}`;
}

function extractLabelFromMath(src: string): { source: string; label: string | null } {
  const m = /\\label\{([^}]*)\}/.exec(src);
  if (!m) return { source: src, label: null };
  return { source: src.slice(0, m.index) + src.slice(m.index + m[0].length), label: m[1] };
}

// Splits the body of an align/gather environment on its top-level `\\` row
// separators, ignoring separators nested inside braces or an inner environment
// (a `matrix` inside one row, say). A `\\[2pt]` spacing hint is dropped.
function splitMathRows(src: string): string[] {
  const rows: string[] = [];
  let cur = '';
  let braceDepth = 0;
  let envDepth = 0;
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('\\begin{', i)) {
      envDepth++;
      cur += '\\begin{';
      i += 7;
      continue;
    }
    if (src.startsWith('\\end{', i)) {
      if (envDepth > 0) envDepth--;
      cur += '\\end{';
      i += 5;
      continue;
    }
    if (src.startsWith('\\\\', i)) {
      if (braceDepth === 0 && envDepth === 0) {
        let j = i + 2;
        if (src[j] === '*') j++;
        const bracket = readBracketArg(src, j);
        if (bracket) j = bracket.end;
        rows.push(cur);
        cur = '';
        i = j;
        continue;
      }
      cur += '\\\\';
      i += 2;
      continue;
    }
    if (src[i] === '\\' && src[i + 1] !== undefined) {
      cur += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (src[i] === '{') braceDepth++;
    else if (src[i] === '}' && braceDepth > 0) braceDepth--;
    cur += src[i];
    i++;
  }
  rows.push(cur);
  while (rows.length > 1 && rows[rows.length - 1].trim() === '') rows.pop();
  return rows;
}

// Numbers an align/gather block the way LaTeX does: one number *per row*, not
// one for the whole environment. The number is handed to KaTeX as a per-row
// `\tag{n}`, which both keeps the columns aligned (rendering rows separately
// would not) and fills KaTeX's own tag gutter, so there is no second, empty
// number column beside ours.
function numberMathRows(envName: string, src: string, ctx: Ctx): string {
  const rows = splitMathRows(src);
  const out: string[] = [];
  for (const row of rows) {
    const { source: withoutLabel, label } = extractLabelFromMath(row);
    if (withoutLabel.trim() === '') {
      out.push(withoutLabel);
      continue;
    }
    // A row that opts out (\notag / \nonumber) or brings its own \tag keeps
    // what it has, and does not consume an equation number. \notag is left in
    // place: KaTeX needs it to know the row wants no tag column at all.
    if (/\\(?:notag|nonumber|tag)\b/.test(withoutLabel)) {
      out.push(withoutLabel);
      continue;
    }
    ctx.eqCounter += 1;
    if (label) ctx.labelMap.set(label.trim(), `${ctx.eqCounter}`);
    out.push(`${withoutLabel}\\tag{${ctx.eqCounter}}`);
  }
  return `\\begin{${envName}}${out.join('\\\\')}\\end{${envName}}`;
}

function extractMath(body: string, ctx: Ctx): string {
  let out = '';
  let i = 0;
  const n = body.length;

  const numberedEnvRe = /^\\begin\{(equation|align|gather)(\*)?\}/;

  while (i < n) {
    // `\\` is a line break, and it must be consumed *before* the `\[` test:
    // the second backslash of `\\[6pt]` would otherwise open a display-math
    // block that never closes, taking the rest of the document with it. The
    // optional `*` and `[len]` spacing hint belong to the break, not to the
    // text after it, so they go too.
    if (body.startsWith('\\\\', i)) {
      out += '\\\\';
      let j = i + 2;
      if (body[j] === '*') j++;
      const bracket = readBracketArg(body, j);
      // Only a length-shaped argument is the break's own: `\\[2pt]`,
      // `\\[-1ex]`, `\\[\baselineskip]`. Anything else is body text.
      if (bracket && /^\s*[-+.\d\\]/.test(bracket.content)) j = bracket.end;
      i = j;
      continue;
    }
    // display: $$...$$
    if (body.startsWith('$$', i)) {
      const close = body.indexOf('$$', i + 2);
      if (close === -1) {
        // Unterminated: emit the delimiter as ordinary text. Treating it as
        // math would swallow every heading and paragraph that follows.
        out += body.slice(i, i + 2);
        i += 2;
        continue;
      }
      out += pushMath(ctx, renderMath(body.slice(i + 2, close), true));
      i = close + 2;
      continue;
    }
    // display: \[ ... \]
    if (body.startsWith('\\[', i)) {
      const close = body.indexOf('\\]', i + 2);
      if (close === -1) {
        out += body.slice(i, i + 2);
        i += 2;
        continue;
      }
      out += pushMath(ctx, renderMath(body.slice(i + 2, close), true));
      i = close + 2;
      continue;
    }
    // numbered display environments
    const envMatch = numberedEnvRe.exec(body.slice(i, i + 40));
    if (envMatch) {
      const envName = envMatch[1];
      const starred = !!envMatch[2];
      const endTag = `\\end{${envName}${starred ? '*' : ''}}`;
      const bodyStart = i + envMatch[0].length;
      const closeIdx = body.indexOf(endTag, bodyStart);
      if (closeIdx === -1) {
        // Unterminated environment: leave the `\begin` tag in the stream as
        // text instead of rendering the remainder of the document as math.
        out += envMatch[0];
        i = bodyStart;
        continue;
      }
      const rawSrc = body.slice(bodyStart, closeIdx);

      if (envName !== 'equation' && !starred) {
        // align / gather: one equation number per row, tagged inside KaTeX.
        const html = renderMath(numberMathRows(envName, rawSrc, ctx), true);
        out += pushMath(ctx, html);
        i = closeIdx + endTag.length;
        continue;
      }

      const { source: src, label } = extractLabelFromMath(rawSrc);
      const renderSrc =
        envName === 'equation' ? src : `\\begin{${envName}${starred ? '*' : ''}}${src}\\end{${envName}${starred ? '*' : ''}}`;
      const html = renderMath(renderSrc, true);
      let eqNum: number | null = null;
      if (!starred) {
        ctx.eqCounter += 1;
        eqNum = ctx.eqCounter;
      }
      const wrapped =
        eqNum !== null
          ? `<div class="tex-eqn-row"><div class="tex-eqn-math">${html}</div><div class="tex-eqn-num">(${eqNum})</div></div>`
          : html;
      if (label && eqNum !== null) ctx.labelMap.set(label.trim(), `${eqNum}`);
      out += pushMath(ctx, wrapped, eqNum !== null);
      i = closeIdx + endTag.length;
      continue;
    }
    // standalone \begin{aligned}...\end{aligned} (normally nested in $$, but
    // tolerate top-level use as its own display block)
    if (body.startsWith('\\begin{aligned}', i)) {
      const endTag = '\\end{aligned}';
      const bodyStart = i + '\\begin{aligned}'.length;
      const closeIdx = body.indexOf(endTag, bodyStart);
      if (closeIdx === -1) {
        out += '\\begin{aligned}';
        i = bodyStart;
        continue;
      }
      const src = body.slice(bodyStart, closeIdx);
      const html = renderMath(`\\begin{aligned}${src}\\end{aligned}`, true);
      out += pushMath(ctx, html);
      i = closeIdx + endTag.length;
      continue;
    }
    // inline: \( ... \)
    if (body.startsWith('\\(', i)) {
      const close = body.indexOf('\\)', i + 2);
      if (close === -1) {
        out += body.slice(i, i + 2);
        i += 2;
        continue;
      }
      out += pushMath(ctx, renderMath(body.slice(i + 2, close), false));
      i = close + 2;
      continue;
    }
    // inline: $...$ (single, not $$, and not an escaped \$)
    if (body[i] === '$' && body[i - 1] !== '\\') {
      let j = i + 1;
      let close = -1;
      while (j < n) {
        if (body[j] === '\\') {
          j += 2;
          continue;
        }
        if (body[j] === '$') {
          close = j;
          break;
        }
        j++;
      }
      if (close !== -1) {
        const src = body.slice(i + 1, close);
        out += pushMath(ctx, renderMath(src, false));
        i = close + 1;
        continue;
      }
    }
    out += body[i];
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 3: tabular extraction -> HTML <table> (deferred cell rendering)
// ---------------------------------------------------------------------------

function splitTableRows(raw: string): string[][] {
  const rows = raw
    .split(/\\\\/)
    .map((r) =>
      r
        .replace(/\\hline/g, '')
        .replace(/\\toprule|\\midrule|\\bottomrule/g, '')
        .trim()
    )
    .filter((r) => r.length > 0);
  return rows.map((r) => r.split(/(?<!\\)&/).map((c) => c.trim()));
}

/**
 * Finds the `\end{name}` that closes the `\begin{name}` whose body starts at
 * `from`, stepping over nested instances of the same environment. A plain
 * `indexOf` stops at the first inner `\end` and cuts the outer environment
 * short, dropping every row after the nested one.
 *
 * Both scans move forward monotonically, so this stays linear in the input.
 */
function findEnvEnd(body: string, name: string, from: number): number {
  const beginTag = `\\begin{${name}}`;
  const endTag = `\\end{${name}}`;
  let depth = 1;
  let i = from;
  while (i < body.length) {
    const nextEnd = body.indexOf(endTag, i);
    if (nextEnd === -1) return -1;
    const nextBegin = body.indexOf(beginTag, i);
    if (nextBegin !== -1 && nextBegin < nextEnd) {
      depth++;
      i = nextBegin + beginTag.length;
      continue;
    }
    depth--;
    if (depth === 0) return nextEnd;
    i = nextEnd + endTag.length;
  }
  return -1;
}

function extractTabular(body: string, ctx: Ctx): string {
  const beginTag = '\\begin{tabular}';
  let out = '';
  let i = 0;
  const n = body.length;
  while (i < n) {
    if (body.startsWith(beginTag, i)) {
      let idx = i + beginTag.length;
      const bracket = readBracketArg(body, idx);
      if (bracket) idx = bracket.end;
      const brace = readBraceArg(body, idx);
      const colSpec = brace ? brace.content : '';
      if (brace) idx = brace.end;
      const closeIdx = findEnvEnd(body, 'tabular', idx);
      if (closeIdx === -1) {
        // Unterminated: emit the opening tag as text and keep scanning, rather
        // than turning the remainder of the document into one table.
        out += body.slice(i, idx);
        i = idx;
        continue;
      }
      // A nested tabular is extracted first, so it becomes a placeholder in
      // whichever cell holds it and its own `\\` row separators cannot split
      // the outer table's rows.
      const rows = splitTableRows(extractTabular(body.slice(idx, closeIdx), ctx));
      const tIdx = ctx.tableBlocks.length;
      ctx.tableBlocks.push({ colSpec, rows });
      out += `${SENTINEL}T${tIdx}${SENTINEL}`;
      i = closeIdx + '\\end{tabular}'.length;
      continue;
    }
    out += body[i];
    i++;
  }
  return out;
}

type ColAlign = 'left' | 'center' | 'right';

// A runaway `*{n}{...}` repetition cannot be allowed to build an unbounded
// column list out of a few characters of input.
const MAX_TABLE_COLS = 512;

/**
 * Parses a tabular preamble into one alignment per column.
 *
 * The preamble is a small language, not a bag of characters: `p{3cm}` is a
 * single left-aligned column whose width argument merely happens to contain a
 * `c`, `*{3}{c}` is three centred columns, and `|`, `@{...}`, `!{...}`,
 * `>{...}` and `<{...}` are decorations that declare no column at all.
 */
function parseColSpec(spec: string, depth = 0): ColAlign[] {
  const cols: ColAlign[] = [];
  let i = 0;
  while (i < spec.length && cols.length < MAX_TABLE_COLS) {
    const ch = spec[i];
    if (ch === 'l' || ch === 'X') {
      // X is tabularx's stretchy column; it is left-aligned by default.
      cols.push('left');
      i++;
      continue;
    }
    if (ch === 'c') {
      cols.push('center');
      i++;
      continue;
    }
    if (ch === 'r') {
      cols.push('right');
      i++;
      continue;
    }
    if (ch === 'p' || ch === 'm' || ch === 'b') {
      // fixed-width paragraph column: the {width} argument is not spec text
      const arg = readBraceArg(spec, i + 1);
      cols.push('left');
      i = arg ? arg.end : i + 1;
      continue;
    }
    if (ch === '@' || ch === '!' || ch === '>' || ch === '<') {
      // inter-column material / per-column decorations: no column of their own
      const arg = readBraceArg(spec, i + 1);
      i = arg ? arg.end : i + 1;
      continue;
    }
    if (ch === '*') {
      // *{n}{sub}: n repetitions of the sub-spec
      const countArg = readBraceArg(spec, i + 1);
      const subArg = countArg ? readBraceArg(spec, countArg.end) : null;
      if (!countArg || !subArg) {
        i++;
        continue;
      }
      const count = parseInt(countArg.content.trim(), 10);
      if (Number.isFinite(count) && count > 0 && depth < 8) {
        const sub = parseColSpec(subArg.content, depth + 1);
        for (let k = 0; k < count && cols.length < MAX_TABLE_COLS; k++) cols.push(...sub);
      }
      i = subArg.end;
      continue;
    }
    // `|`, whitespace and anything else we do not model
    i++;
  }
  return cols;
}

/**
 * Recognises a `\multicolumn{n}{spec}{text}` cell. Rendering it as an ordinary
 * cell leaves the header row one cell short of the body rows, so the columns
 * stop lining up; it has to become a real `colspan`.
 */
function parseMulticolumn(cell: string): { span: number; align: ColAlign | undefined; content: string } | null {
  const m = /^\s*\\multicolumn\s*(?=\{)/.exec(cell);
  if (!m) return null;
  const spanArg = readBraceArg(cell, m[0].length);
  if (!spanArg) return null;
  const specArg = readBraceArg(cell, spanArg.end);
  if (!specArg) return null;
  const contentArg = readBraceArg(cell, specArg.end);
  if (!contentArg) return null;
  const span = parseInt(spanArg.content.trim(), 10);
  if (!Number.isFinite(span) || span < 1 || span > MAX_TABLE_COLS) return null;
  return {
    span,
    align: parseColSpec(specArg.content)[0],
    // anything trailing the command stays part of the same cell
    content: contentArg.content + cell.slice(contentArg.end)
  };
}

function renderTableBlock(t: TableBlock, ctx: Ctx): string {
  const aligns = parseColSpec(t.colSpec);
  const rowsHtml = t.rows
    .map((row) => {
      let col = 0;
      const cells = row
        .map((cell) => {
          const mc = parseMulticolumn(cell);
          if (mc) {
            const align = mc.align ?? aligns[col];
            const style = align ? ` style="text-align:${align}"` : '';
            const span = mc.span > 1 ? ` colspan="${mc.span}"` : '';
            col += mc.span;
            return `<td${span}${style}>${processInline(mc.content, ctx)}</td>`;
          }
          const align = aligns[col];
          col += 1;
          const style = align ? ` style="text-align:${align}"` : '';
          return `<td${style}>${processInline(cell, ctx)}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return `<div class="tex-table-wrap"><table class="tex-table"><tbody>${rowsHtml}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------
// Stage 4: environment tree (itemize/enumerate/description/figure/table/quote/center/...)
// ---------------------------------------------------------------------------

type Node =
  | { type: 'text'; content: string }
  | { type: 'env'; name: string; arg: string | null; children: Node[] }
  /** A structural problem in the source, shown in place rather than swallowed. */
  | { type: 'error'; message: string };

function matchTagAt(s: string, i: number, kind: 'begin' | 'end'): { name: string; end: number } | null {
  const prefix = kind === 'begin' ? '\\begin{' : '\\end{';
  if (!s.startsWith(prefix, i)) return null;
  const close = s.indexOf('}', i + prefix.length);
  if (close === -1) return null;
  const name = s.slice(i + prefix.length, close);
  if (!/^[a-zA-Z*]+$/.test(name)) return null;
  return { name, end: close + 1 };
}

function buildTree(s: string): Node[] {
  const root: Node[] = [];
  const stack: { name: string; children: Node[] }[] = [];
  let currentChildren = root;
  let textBuf = '';
  let i = 0;

  const flush = () => {
    if (textBuf) {
      currentChildren.push({ type: 'text', content: textBuf });
      textBuf = '';
    }
  };

  while (i < s.length) {
    if (s[i] === '\\') {
      const b = matchTagAt(s, i, 'begin');
      if (b) {
        flush();
        let idx = b.end;
        // Only float placement specifiers ([h], [htbp], ...) can legally follow
        // \begin{name} for the environments we support here (tabular, which is
        // the one environment needing a mandatory brace arg, is already
        // extracted before the tree is built, so no brace-arg is consumed here
        // to avoid accidentally swallowing a leading `{...}` grouping in body
        // text).
        const bracket = readBracketArg(s, idx);
        if (bracket) idx = bracket.end;
        const arg: string | null = bracket ? bracket.content : null;
        const node: Node = { type: 'env', name: b.name, arg, children: [] };
        currentChildren.push(node);
        stack.push({ name: b.name, children: node.children });
        currentChildren = node.children;
        i = idx;
        continue;
      }
      const e = matchTagAt(s, i, 'end');
      if (e) {
        flush();
        // `\end{x}` closes the innermost `\begin{x}`, not simply "the innermost
        // environment". Popping blindly makes a typo - or the half-second while
        // an `\end` is being retyped - silently reattach every following block
        // to the wrong parent, which is invisible in the output and therefore
        // impossible to diagnose from the preview.
        let match = -1;
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].name === e.name) {
            match = k;
            break;
          }
        }
        if (match === -1) {
          // Nothing it can close: keep the current environment open (so the
          // rest of its content stays where the author put it) and say so.
          currentChildren.push({
            type: 'error',
            message: `\\end{${e.name}} has no matching \\begin{${e.name}}`
          });
        } else {
          // Everything above the match was left unclosed; report it, then close
          // them all so the tree stays a tree.
          for (let k = stack.length - 1; k > match; k--) {
            stack[k].children.push({
              type: 'error',
              message: `\\begin{${stack[k].name}} was not closed before \\end{${e.name}}`
            });
          }
          stack.length = match;
          currentChildren = stack.length ? stack[stack.length - 1].children : root;
        }
        i = e.end;
        continue;
      }
    }
    textBuf += s[i];
    i++;
  }
  flush();
  return root;
}

// ---------------------------------------------------------------------------
// Block-level rendering
// ---------------------------------------------------------------------------

type HeadingKind = 'part' | 'chapter' | 'section' | 'subsection' | 'subsubsection';
type RunInKind = 'paragraph' | 'subparagraph';

const HEADING_TAGS: Record<HeadingKind, string> = {
  part: 'h1',
  chapter: 'h1',
  section: 'h2',
  subsection: 'h3',
  subsubsection: 'h4'
};

// No stylesheet rule exists for these two (the preview's CSS lives in another
// module), so they carry just enough inline styling to read as headings.
const HEADING_INLINE_STYLE: Partial<Record<HeadingKind, string>> = {
  part: ' style="font-size:1.75rem;text-align:center"',
  chapter: ' style="font-size:1.6rem"'
};

const ROMAN: [number, string][] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I']
];

function toRoman(n: number): string {
  if (!Number.isFinite(n) || n < 1 || n > 3999) return `${n}`;
  let rest = n;
  let out = '';
  for (const [value, numeral] of ROMAN) {
    while (rest >= value) {
      out += numeral;
      rest -= value;
    }
  }
  return out;
}

function matchBlockCmd(
  s: string,
  i: number
):
  | { kind: HeadingKind | RunInKind; starred: boolean; end: number }
  | { kind: 'maketitle'; end: number }
  | { kind: 'caption'; end: number }
  | null {
  if (s[i] !== '\\') return null;
  const order: Array<HeadingKind | RunInKind> = [
    'subsubsection',
    'subsection',
    'section',
    'subparagraph',
    'paragraph',
    'chapter',
    'part'
  ];
  for (const kind of order) {
    const tag = `\\${kind}`;
    if (s.startsWith(tag, i)) {
      let j = i + tag.length;
      // must not be a longer identifier
      if (/[a-zA-Z]/.test(s[j] ?? '')) continue;
      const starred = s[j] === '*';
      if (starred) j++;
      return { kind, starred, end: j };
    }
  }
  if (s.startsWith('\\maketitle', i) && !/[a-zA-Z]/.test(s[i + '\\maketitle'.length] ?? '')) {
    return { kind: 'maketitle', end: i + '\\maketitle'.length };
  }
  if (s.startsWith('\\caption', i) && !/[a-zA-Z]/.test(s[i + '\\caption'.length] ?? '')) {
    return { kind: 'caption', end: i + '\\caption'.length };
  }
  return null;
}

/**
 * Renders one preamble field. A field whose body is a macro we do not know
 * (`\date{\somethingcustom}`) renders as nothing at all, which shows up as an
 * empty line the reader cannot explain - so fall back to the literal source
 * text, which at least says what the document asked for.
 */
function renderPreambleField(raw: string, ctx: Ctx): string {
  const html = processInline(raw, ctx);
  return html.trim().length > 0 ? html : escapeHtml(raw.trim());
}

function renderTitleBlock(ctx: Ctx): string {
  const { title, author, date } = ctx.preamble;
  const parts: string[] = [];
  if (title) parts.push(`<h1 class="tex-title">${renderPreambleField(title, ctx)}</h1>`);
  if (author) parts.push(`<div class="tex-author">${renderPreambleField(author, ctx)}</div>`);
  if (date) parts.push(`<div class="tex-date">${renderPreambleField(date, ctx)}</div>`);
  if (parts.length === 0) return '';
  return `<div class="tex-title-block">${parts.join('')}</div>`;
}

/** The `N.` prefix sectioning counters sit under once a document has chapters. */
function chapterPrefix(ctx: Ctx): string {
  return ctx.counters.chapter > 0 ? `${ctx.counters.chapter}.` : '';
}

function renderHeading(kind: HeadingKind, starred: boolean, rawTitle: string, ctx: Ctx): string {
  let numStr = '';
  if (!starred) {
    if (kind === 'part') {
      ctx.counters.part++;
      numStr = toRoman(ctx.counters.part);
    } else if (kind === 'chapter') {
      ctx.counters.chapter++;
      ctx.counters.section = 0;
      ctx.counters.subsection = 0;
      ctx.counters.subsubsection = 0;
      numStr = `${ctx.counters.chapter}`;
    } else if (kind === 'section') {
      ctx.counters.section++;
      ctx.counters.subsection = 0;
      ctx.counters.subsubsection = 0;
      numStr = `${chapterPrefix(ctx)}${ctx.counters.section}`;
    } else if (kind === 'subsection') {
      ctx.counters.subsection++;
      ctx.counters.subsubsection = 0;
      numStr = `${chapterPrefix(ctx)}${ctx.counters.section}.${ctx.counters.subsection}`;
    } else {
      ctx.counters.subsubsection++;
      numStr = `${chapterPrefix(ctx)}${ctx.counters.section}.${ctx.counters.subsection}.${ctx.counters.subsubsection}`;
    }
  }
  ctx.currentFloat = null;
  ctx.pendingLabelNumber = numStr || null;
  const titleHtml = processInline(rawTitle, ctx);
  const tag = HEADING_TAGS[kind];
  // `\part` prints "Part I" rather than a bare numeral.
  const label = kind === 'part' && numStr ? `Part ${numStr}` : numStr;
  const numSpan = label ? `<span class="tex-secnum">${escapeHtml(label)}</span>` : '';
  const id = numStr ? ` id="sec-${slug(numStr)}"` : ` id="sec-${slug(rawTitle)}"`;
  const style = HEADING_INLINE_STYLE[kind] ?? '';
  return `<${tag}${id} class="tex-heading tex-${kind}"${style}>${numSpan}${titleHtml}</${tag}>`;
}

function renderCaption(rawText: string, ctx: Ctx): string {
  const float = ctx.currentFloat;
  const label = float ? `${float.kind} ${float.num}` : 'Caption';
  if (float) ctx.pendingLabelNumber = `${float.num}`;
  const html = processInline(rawText, ctx);
  return `<figcaption class="tex-caption"><span class="tex-caption-label">${escapeHtml(
    label
  )}:</span> ${html}</figcaption>`;
}

/** True when the placeholder at `kind`/`idx` expands to block-level markup. */
function isBlockPlaceholder(kind: string, idx: number, ctx: Ctx): boolean {
  if (kind === 'T') return true;
  // A verbatim *environment* is a <pre> and must sit outside the paragraph; a
  // `\verb|...|` is inline <code> and must stay inside it.
  if (kind === 'V') return !(ctx.verbBlocks[idx]?.inline ?? false);
  return kind === 'M' && (ctx.mathBlocks[idx]?.block ?? false);
}

function renderParagraphText(text: string, ctx: Ctx): string {
  const paras = text
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter((p) => p.length > 0);

  // A <pre>, a <table> or a numbered-equation <div> cannot legally live inside
  // a <p>: the HTML parser closes the paragraph before it and leaves a stray
  // </p> behind, which shows up as an extra empty paragraph (one full blank
  // line) after every code block, table and display equation. So they are
  // emitted as siblings of the paragraphs.
  //
  // The split happens on the inline *tree*, not on the serialized HTML. Cutting
  // the string would cut straight through whatever inline elements were open at
  // that point - `\emph{lead \begin{equation}..\end{equation} tail}` produced an
  // unclosed <em> in one paragraph and a stray </em> in another, and the browser
  // then reparented the tag and bled italics through the rest of the document.
  // Splitting the tree re-opens each still-open element on the far side instead,
  // so every fragment is balanced and the emphasis lands on both halves.
  const out: string[] = [];
  for (const p of paras) {
    for (const piece of splitInlineAtBlocks(parseInline(p, ctx))) {
      if (piece.kind === 'block') {
        out.push(piece.html);
        continue;
      }
      const html = renderInline(piece.nodes);
      if (html.trim().length > 0) out.push(`<p class="tex-p">${html}</p>`);
    }
  }
  return out.join('');
}

function renderTextBlock(content: string, ctx: Ctx): string[] {
  const blocks: string[] = [];
  let i = 0;
  let paraBuf = '';
  const flushPara = () => {
    if (paraBuf.trim().length > 0) blocks.push(renderParagraphText(paraBuf, ctx));
    paraBuf = '';
  };
  while (i < content.length) {
    const m = matchBlockCmd(content, i);
    if (m) {
      if (m.kind === 'maketitle') {
        flushPara();
        const t = renderTitleBlock(ctx);
        if (t) blocks.push(t);
        i = m.end;
        continue;
      }
      if (m.kind === 'caption') {
        const brace = readBraceArg(content, m.end);
        if (brace) {
          flushPara();
          blocks.push(renderCaption(brace.content, ctx));
          i = brace.end;
          continue;
        }
        i = m.end;
        continue;
      }
      if (m.kind === 'paragraph' || m.kind === 'subparagraph') {
        const brace = readBraceArg(content, m.end);
        if (brace) {
          // run-in bold heading: fold back into the flowing text
          paraBuf += `\\textbf{${brace.content}.} `;
          i = brace.end;
          continue;
        }
        i = m.end;
        continue;
      }
      // part / chapter / section / subsection / subsubsection
      const brace = readBraceArg(content, m.end);
      if (brace) {
        flushPara();
        blocks.push(renderHeading(m.kind, m.starred, brace.content, ctx));
        i = brace.end;
        continue;
      }
      i = m.end;
      continue;
    }
    paraBuf += content[i];
    i++;
  }
  flushPara();
  return blocks;
}

interface ListItem {
  optArg: string | null;
  nodes: Node[];
}

function splitItems(children: Node[]): ListItem[] {
  const items: ListItem[] = [];
  // The negative lookahead is not optional: without it `\itemsep0pt` (a length
  // assignment every second list carries) matches as an `\item` and opens a
  // phantom bullet reading "sep0pt".
  const itemRe = /\\item(?![a-zA-Z])(?:\[((?:[^[\]])*)\])?/g;
  for (const child of children) {
    if (child.type === 'text') {
      itemRe.lastIndex = 0;
      const matches: { optArg: string | null; start: number; end: number }[] = [];
      let m: RegExpExecArray | null;
      while ((m = itemRe.exec(child.content))) {
        matches.push({ optArg: m[1] ?? null, start: m.index, end: itemRe.lastIndex });
      }
      if (matches.length === 0) {
        if (items.length > 0 && child.content.trim() !== '') {
          items[items.length - 1].nodes.push({ type: 'text', content: child.content });
        }
        continue;
      }
      if (matches[0].start > 0 && items.length > 0) {
        const pre = child.content.slice(0, matches[0].start);
        if (pre.trim() !== '') items[items.length - 1].nodes.push({ type: 'text', content: pre });
      }
      for (let idx = 0; idx < matches.length; idx++) {
        const start = matches[idx].end;
        const end = idx + 1 < matches.length ? matches[idx + 1].start : child.content.length;
        items.push({ optArg: matches[idx].optArg, nodes: [{ type: 'text', content: child.content.slice(start, end) }] });
      }
    } else {
      if (items.length > 0) items[items.length - 1].nodes.push(child);
    }
  }
  return items;
}

function renderList(node: Node & { type: 'env' }, ctx: Ctx, tag: 'ul' | 'ol'): string {
  const items = splitItems(node.children);
  const lis = items.map((it) => `<li class="tex-li">${renderNodes(it.nodes, ctx)}</li>`).join('');
  return `<${tag} class="tex-list tex-${tag}">${lis}</${tag}>`;
}

function renderDescription(node: Node & { type: 'env' }, ctx: Ctx): string {
  const items = splitItems(node.children);
  const rows = items
    .map((it) => {
      const term = it.optArg ? processInline(it.optArg, ctx) : '';
      return `<dt class="tex-dt">${term}</dt><dd class="tex-dd">${renderNodes(it.nodes, ctx)}</dd>`;
    })
    .join('');
  return `<dl class="tex-description">${rows}</dl>`;
}

function renderFloat(node: Node & { type: 'env' }, kind: 'Figure' | 'Table', ctx: Ctx): string {
  const key = kind === 'Figure' ? 'figure' : 'table';
  ctx.counters[key]++;
  const prevFloat = ctx.currentFloat;
  ctx.currentFloat = { kind, num: ctx.counters[key] };
  const inner = renderNodes(node.children, ctx);
  ctx.currentFloat = prevFloat;
  return `<figure class="tex-figure">${inner}</figure>`;
}

const ERROR_STYLE =
  'color:var(--app-danger,#c00);font-family:var(--font-mono,monospace);font-size:0.85em;' +
  'border:1px solid currentColor;border-radius:0.25em;padding:0 0.35em;margin:0 0.15em';

function renderStructureError(message: string): string {
  return `<span class="tex-env-error" style="${ERROR_STYLE}">${escapeHtml(message)}</span>`;
}

function renderNodes(nodes: Node[], ctx: Ctx): string {
  return nodes
    .map((n) => {
      if (n.type === 'text') return renderTextBlock(n.content, ctx).join('');
      if (n.type === 'error') return renderStructureError(n.message);
      return renderEnv(n, ctx);
    })
    .join('');
}

function renderEnv(node: Node & { type: 'env' }, ctx: Ctx): string {
  const name = node.name.replace(/\*$/, '');
  switch (name) {
    case 'itemize':
      return renderList(node, ctx, 'ul');
    case 'enumerate':
      return renderList(node, ctx, 'ol');
    case 'description':
      return renderDescription(node, ctx);
    case 'figure':
      return renderFloat(node, 'Figure', ctx);
    case 'table':
      return renderFloat(node, 'Table', ctx);
    case 'quote':
    case 'quotation':
      return `<blockquote class="tex-quote">${renderNodes(node.children, ctx)}</blockquote>`;
    case 'center':
      return `<div class="tex-center">${renderNodes(node.children, ctx)}</div>`;
    default:
      return renderNodes(node.children, ctx);
  }
}

// ---------------------------------------------------------------------------
// Inline-level rendering
//
// The inline layer parses into a small tree (`Inline`) instead of straight into
// a string. A block-level thing - a display equation, a listing, a table - can
// legally appear in the middle of an inline construct, and the paragraph
// builder has to break the surrounding <p> around it. Doing that to a finished
// HTML *string* cuts through whatever tags are open at that point and emits
// unbalanced markup; doing it to the tree lets the still-open elements be
// re-opened on the far side of the break instead.
// ---------------------------------------------------------------------------

type Inline =
  /** Ready-made markup with nothing to split inside it (escaped text, katex, a placeholder token). */
  | { type: 'html'; html: string }
  /** An inline element whose children may need to be re-opened after a break. */
  | { type: 'elem'; open: string; close: string; children: Inline[] }
  /** Block-level markup that must not stay inside the surrounding <p>. */
  | { type: 'block'; html: string };

function renderInline(nodes: Inline[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'elem') {
      const inner = renderInline(node.children);
      // An element with nothing left in it is a leftover of a paragraph break,
      // not something the author wrote; emitting it would leave `<em></em>`.
      if (inner === '') continue;
      out += node.open + inner + node.close;
      continue;
    }
    out += node.html;
  }
  return out;
}

type InlinePiece = { kind: 'block'; html: string } | { kind: 'inline'; nodes: Inline[] };

/**
 * Splits an inline tree at every block-level node, re-opening the enclosing
 * inline elements around each surviving run. `\emph{a <block> b}` becomes
 * `<em>a</em>` / block / `<em>b</em>` - three well-formed fragments - rather
 * than one string sliced through the middle of an `<em>`.
 */
function splitInlineAtBlocks(nodes: Inline[]): InlinePiece[] {
  const pieces: InlinePiece[] = [];
  let cur: Inline[] = [];
  const cut = (html: string) => {
    pieces.push({ kind: 'inline', nodes: cur });
    cur = [];
    pieces.push({ kind: 'block', html });
  };
  for (const node of nodes) {
    if (node.type === 'block') {
      cut(node.html);
      continue;
    }
    if (node.type === 'elem') {
      const sub = splitInlineAtBlocks(node.children);
      if (sub.length === 1) {
        // No block inside: keep the element exactly as it was.
        cur.push(node);
        continue;
      }
      for (const part of sub) {
        if (part.kind === 'block') cut(part.html);
        else if (part.nodes.length > 0)
          cur.push({ type: 'elem', open: node.open, close: node.close, children: part.nodes });
      }
      continue;
    }
    cur.push(node);
  }
  pieces.push({ kind: 'inline', nodes: cur });
  return pieces;
}

// Commands that produce no output and take no argument.
const NOOP_COMMANDS = new Set([
  'noindent',
  'indent',
  'centering',
  'raggedright',
  'raggedleft',
  'small',
  'footnotesize',
  'large',
  'Large',
  'LARGE',
  'normalsize',
  'scriptsize',
  'tiny',
  'huge',
  'Huge',
  'bfseries',
  'mdseries',
  'itshape',
  'upshape',
  'ttfamily',
  'rmfamily',
  'sffamily',
  'scshape',
  'normalfont',
  'selectfont',
  'protect',
  'allowbreak',
  'par',
  'newpage',
  'clearpage',
  'cleardoublepage',
  'pagebreak',
  'linebreak',
  'nolinebreak',
  'appendix',
  'tableofcontents',
  'listoffigures',
  'listoftables',
  // list / table / spacing furniture that carries no text of its own
  'hline',
  'toprule',
  'midrule',
  'bottomrule',
  'hfill',
  'vfill',
  'hrulefill',
  'dotfill',
  'bigskip',
  'medskip',
  'smallskip',
  'noalign',
  'frontmatter',
  'mainmatter',
  'backmatter',
  'sloppy',
  'fussy',
  'makeatletter',
  'makeatother',
  'boldmath',
  'unboldmath',
  'printbibliography',
  'printindex',
  'makeindex',
  'maketitle',
  // A `\verb` still being typed (its closing delimiter not there yet) is not
  // an unsupported command; say nothing until it is complete.
  'verb'
]);

// Commands that stand for one piece of literal text. The replacement goes
// through the ordinary escaping path, so `<` and friends stay safe.
const SYMBOL_COMMANDS: Record<string, string> = {
  LaTeX: 'LaTeX',
  LaTeXe: 'LaTeX2e',
  TeX: 'TeX',
  BibTeX: 'BibTeX',
  ldots: '…',
  dots: '…',
  textellipsis: '…',
  textbackslash: '\\',
  textasciitilde: '~',
  textasciicircum: '^',
  textbar: '|',
  textless: '<',
  textgreater: '>',
  textunderscore: '_',
  textbullet: '•',
  textperiodcentered: '·',
  textregistered: '®',
  texttrademark: '™',
  textdegree: '°',
  textquotedblleft: '“',
  textquotedblright: '”',
  textquoteleft: '‘',
  textquoteright: '’',
  copyright: '©',
  pounds: '£',
  euro: '€',
  dag: '†',
  ddag: '‡',
  S: '§',
  P: '¶',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  aa: 'å',
  AA: 'Å',
  ss: 'ß',
  o: 'ø',
  O: 'Ø',
  quad: ' ',
  qquad: '  ',
  enspace: ' ',
  thinspace: ' ',
  nobreakspace: '\u00a0',
  space: ' ',
  // `\and` separates authors on the title line
  and: ' '
};

// TeX length registers, written as an assignment with no braces at all
// (`\itemsep0pt`, `\parskip=1ex plus 2pt`). The value is not text and must be
// consumed with the command, or its digits and units end up in the prose.
const LENGTH_COMMANDS = new Set([
  'itemsep',
  'parskip',
  'parsep',
  'topsep',
  'partopsep',
  'itemindent',
  'labelsep',
  'labelwidth',
  'leftmargin',
  'rightmargin',
  'listparindent',
  'baselineskip',
  'lineskip',
  'parindent',
  'columnsep',
  'tabcolsep',
  'arrayrulewidth',
  'doublerulesep',
  'arraystretch',
  'fboxsep',
  'fboxrule',
  'abovedisplayskip',
  'belowdisplayskip',
  'abovecaptionskip',
  'belowcaptionskip',
  'floatsep',
  'textfloatsep',
  'intextsep',
  'footnotesep',
  'marginparwidth',
  'marginparsep',
  'oddsidemargin',
  'evensidemargin',
  'topmargin',
  'headheight',
  'headsep',
  'footskip',
  'textheight',
  'textwidth',
  'linewidth',
  'hoffset',
  'voffset'
]);

const LENGTH_VALUE_RE =
  /^[ \t]*=?[ \t]*(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)[ \t]*(?:pt|pc|in|bp|cm|mm|dd|cc|sp|ex|em|mu)?|\\[a-zA-Z]+)(?:[ \t]*(?:plus|minus)[ \t]*[-+]?(?:\d+(?:\.\d*)?|\.\d+)[ \t]*(?:pt|pc|in|bp|cm|mm|dd|cc|sp|ex|em|mu|fil{1,3})?)*/;

// Commands whose arguments are configuration, not prose: rendering their text
// would put stray lengths, file names and package options into the document.
const DROP_ARG_COMMANDS = new Set([
  'documentclass',
  'usepackage',
  'RequirePackage',
  'geometry',
  'hypersetup',
  'graphicspath',
  'setlength',
  'addtolength',
  'settowidth',
  'settoheight',
  'setcounter',
  'addtocounter',
  'stepcounter',
  'refstepcounter',
  'newcounter',
  'newlength',
  'newtheorem',
  'theoremstyle',
  'definecolor',
  'pagestyle',
  'thispagestyle',
  'pagenumbering',
  'bibliographystyle',
  'bibliography',
  'addbibresource',
  'nocite',
  'input',
  'include',
  'includeonly',
  'index',
  'glossary',
  'vspace',
  'hspace',
  'vskip',
  'hskip',
  'raisebox',
  'phantom',
  'hphantom',
  'vphantom',
  'color',
  'pagecolor',
  'captionsetup',
  'lstset',
  'tikzset',
  'renewcommand',
  'providecommand',
  'DeclareMathOperator',
  'numberwithin',
  'title',
  'author',
  'date',
  'markboth',
  'markright',
  'addcontentsline',
  'rule',
  'item', // the list splitter already consumed the real ones
  // A half-typed `\begin{itemi` - the tree builder only recognises a complete
  // tag, and the environment's name is not prose.
  'begin',
  'end',
  'label' // handled above; listed so a malformed one drops rather than prints
]);

// Commands wrapping their single argument in markup.
const TEXT_WRAPPERS: Record<string, [string, string]> = {
  textbf: ['<strong>', '</strong>'],
  bf: ['<strong>', '</strong>'],
  textmd: ['', ''],
  textit: ['<em>', '</em>'],
  it: ['<em>', '</em>'],
  emph: ['<em>', '</em>'],
  textsl: ['<em>', '</em>'],
  textup: ['', ''],
  textnormal: ['', ''],
  textrm: ['', ''],
  textsf: ['', ''],
  texttt: ['<code>', '</code>'],
  tt: ['<code>', '</code>'],
  textsc: ['<span style="font-variant: small-caps">', '</span>'],
  sc: ['<span style="font-variant: small-caps">', '</span>'],
  underline: ['<u>', '</u>'],
  uline: ['<u>', '</u>'],
  fbox: ['<span style="border:1px solid currentColor;padding:0 0.2em">', '</span>'],
  framebox: ['<span style="border:1px solid currentColor;padding:0 0.2em">', '</span>'],
  mbox: ['', ''],
  makebox: ['', ''],
  ensuremath: ['', '']
};

// Commands whose *last* brace argument is the text and whose earlier ones are
// settings (`\textcolor{red}{words}`, `\parbox{5cm}{words}`).
const LAST_ARG_TEXT_COMMANDS: Record<string, number> = {
  textcolor: 2,
  colorbox: 2,
  fcolorbox: 3,
  parbox: 2,
  resizebox: 3,
  scalebox: 2,
  rotatebox: 2
};

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];

/** `\today` in the article class's default (US English) form. */
function todayString(): string {
  const d = new Date();
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

const GRAPHIC_STYLE =
  'display:inline-block;padding:0.35em 0.7em;border:1px dashed var(--app-border,#999);' +
  'border-radius:0.375rem;color:var(--app-fg-muted,#666);font-family:var(--font-mono,monospace);' +
  'font-size:0.85em';

const UNKNOWN_CMD_STYLE =
  'color:var(--app-fg-muted,#666);font-family:var(--font-mono,monospace);font-size:0.9em;' +
  'text-decoration:underline dotted';

// Old-style font *declarations*: `{\bf text}` puts the command inside the
// group, so they never look like `\cmd{arg}` and have to be handled where the
// group is opened rather than in the command switch below.
const DECLARATION_WRAPPERS: Record<string, [string, string]> = {
  bf: ['<strong>', '</strong>'],
  bfseries: ['<strong>', '</strong>'],
  it: ['<em>', '</em>'],
  itshape: ['<em>', '</em>'],
  em: ['<em>', '</em>'],
  sl: ['<em>', '</em>'],
  slshape: ['<em>', '</em>'],
  tt: ['<code>', '</code>'],
  ttfamily: ['<code>', '</code>'],
  sc: ['<span style="font-variant: small-caps">', '</span>'],
  scshape: ['<span style="font-variant: small-caps">', '</span>']
};

/**
 * Renders the contents of a `{...}` group. Leading font declarations apply to
 * the whole group; a group with none is just a scope, and contributes no
 * markup of its own (its braces must not survive into the output).
 */
function renderGroup(inner: string, ctx: Ctx): Inline[] {
  const declRe = /^\s*\\([a-zA-Z]+)[ \t]*/;
  const wrappers: [string, string][] = [];
  let rest = inner;
  for (;;) {
    const m = declRe.exec(rest);
    if (!m) break;
    const wrapper = DECLARATION_WRAPPERS[m[1]];
    if (!wrapper) break;
    wrappers.push(wrapper);
    rest = rest.slice(m[0].length);
  }
  let nodes = parseInline(rest, ctx);
  for (let k = wrappers.length - 1; k >= 0; k--) {
    nodes = [{ type: 'elem', open: wrappers[k][0], close: wrappers[k][1], children: nodes }];
  }
  return nodes;
}

function readInlineTag(s: string, i: number): { name: string; end: number } | null {
  const m = /^[a-zA-Z]+/.exec(s.slice(i));
  if (!m) return null;
  return { name: m[0], end: i + m[0].length };
}

function consumeOptAndBraceArgs(s: string, i: number, maxBraces: number): { end: number } {
  let idx = i;
  const bracket = readBracketArg(s, idx);
  if (bracket) idx = bracket.end;
  for (let k = 0; k < maxBraces; k++) {
    const brace = readBraceArg(s, idx);
    if (!brace) break;
    idx = brace.end;
  }
  return { end: idx };
}

function substitutePlaceholders(s: string, ctx: Ctx): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === SENTINEL) {
      const kind = s[i + 1];
      let j = i + 2;
      let numStr = '';
      while (j < s.length && s[j] !== SENTINEL) {
        numStr += s[j];
        j++;
      }
      if (j >= s.length) {
        // Unterminated: not one of ours. Drop the marker, keep the tail.
        i++;
        continue;
      }
      const idx = parseInt(numStr, 10);
      if (kind === 'M' && ctx.mathBlocks[idx]) {
        out += ctx.mathBlocks[idx].html;
      } else if (kind === 'V' && ctx.verbBlocks[idx]) {
        const vb = ctx.verbBlocks[idx];
        if (vb.inline) {
          out += `<code class="tex-verb">${escapeHtml(vb.content)}</code>`;
        } else {
          const cls = vb.code ? 'tex-code' : 'tex-verbatim';
          out += `<pre class="${cls}"><code>${escapeHtml(vb.content)}</code></pre>`;
        }
      } else if (kind === 'T' && ctx.tableBlocks[idx]) {
        // Tables are normally expanded during inline parsing, in document
        // order; this is the fallback for a token that reached the output some
        // other way.
        out += substitutePlaceholders(renderTableBlock(ctx.tableBlocks[idx], ctx), ctx);
      }
      i = j + 1; // skip closing sentinel
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

export function processInline(raw: string, ctx: Ctx): string {
  return renderInline(parseInline(raw, ctx));
}

function parseInline(raw: string, ctx: Ctx): Inline[] {
  const nodes: Inline[] = [];
  let textBuf = '';
  let i = 0;
  const n = raw.length;

  const flush = () => {
    if (!textBuf) return;
    nodes.push({ type: 'html', html: escapeHtml(textBuf) });
    textBuf = '';
  };
  const push = (html: string) => {
    flush();
    nodes.push({ type: 'html', html });
  };
  const pushElem = (open: string, close: string, children: Inline[]) => {
    flush();
    nodes.push({ type: 'elem', open, close, children });
  };

  while (i < n) {
    const c = raw[i];

    // sentinel placeholders (math / verbatim / table)
    if (c === SENTINEL) {
      let j = i + 2;
      while (j < n && raw[j] !== SENTINEL) j++;
      if (j < n) {
        flush();
        const kind = raw[i + 1];
        const idx = parseInt(raw.slice(i + 2, j), 10);
        const token = raw.slice(i, j + 1);
        if (kind === 'T' && ctx.tableBlocks[idx]) {
          // Rendered *here*, in document order, rather than deferred to the
          // final placeholder substitution: a cell can contain a \footnote, a
          // \cite or a \label, and those number themselves from the position
          // they are processed at. Deferring them numbered a cell's footnote
          // after the footnote list had already been serialized (a dead anchor
          // and a lost note) and read \label's section number from the last
          // heading in the document rather than the enclosing one.
          nodes.push({ type: 'block', html: renderTableBlock(ctx.tableBlocks[idx], ctx) });
        } else if (isBlockPlaceholder(kind, idx, ctx)) {
          nodes.push({ type: 'block', html: token });
        } else {
          nodes.push({ type: 'html', html: token });
        }
        i = j + 1;
        continue;
      }
      // Unterminated: not a placeholder we emitted. Never swallow the rest of
      // the document - treat it as an ordinary (escaped) character.
      textBuf += c;
      i++;
      continue;
    }

    // grouping braces: `{...}` is a scope, not literal text. A leading font
    // declaration inside it (`{\bf ...}`) applies to the whole group.
    if (c === '{') {
      const close = findMatchingBrace(raw, i);
      if (close !== -1) {
        flush();
        nodes.push(...renderGroup(raw.slice(i + 1, close), ctx));
        i = close + 1;
        continue;
      }
      // unmatched brace: fall through and render it as text
    }

    // typography
    if (raw.startsWith('---', i)) {
      textBuf += '—';
      i += 3;
      continue;
    }
    if (raw.startsWith('--', i)) {
      textBuf += '–';
      i += 2;
      continue;
    }
    if (raw.startsWith('``', i)) {
      textBuf += '“';
      i += 2;
      continue;
    }
    if (c === "'" && raw[i + 1] === "'") {
      textBuf += '”';
      i += 2;
      continue;
    }
    if (c === '~') {
      textBuf += '\u00a0';
      i++;
      continue;
    }

    if (c === '\\') {
      const next = raw[i + 1];
      // line break
      if (next === '\\') {
        push('<br>');
        i += 2;
        continue;
      }
      // bare escapes
      if (next !== undefined && '&%_#${}'.includes(next)) {
        textBuf += next;
        i += 2;
        continue;
      }
      if (next === ' ') {
        textBuf += ' ';
        i += 2;
        continue;
      }
      const tag = readInlineTag(raw, i + 1);
      if (!tag) {
        // stray backslash with no command name; drop it
        i += 1;
        continue;
      }
      const name = tag.name;
      let idx = tag.end;

      const wantsArg = (count: number) => {
        const args: string[] = [];
        for (let k = 0; k < count; k++) {
          const brace = readBraceArg(raw, idx);
          if (!brace) return null;
          args.push(brace.content);
          idx = brace.end;
        }
        return args;
      };

      const wrapper = TEXT_WRAPPERS[name];
      if (wrapper) {
        const args = wantsArg(1);
        if (args) {
          pushElem(wrapper[0], wrapper[1], parseInline(args[0], ctx));
          i = idx;
          continue;
        }
        idx = tag.end;
      }

      const lastArgCount = LAST_ARG_TEXT_COMMANDS[name];
      if (lastArgCount !== undefined) {
        const args = wantsArg(lastArgCount);
        if (args) {
          flush();
          nodes.push(...parseInline(args[lastArgCount - 1], ctx));
          i = idx;
          continue;
        }
        idx = tag.end;
      }

      switch (name) {
        case 'today': {
          textBuf += todayString();
          i = idx;
          continue;
        }
        case 'footnote':
        case 'thanks': {
          const args = wantsArg(1);
          if (args) {
            const num = ctx.footnotes.length + 1;
            // Reserve the slot before rendering, so a footnote nested inside
            // this one cannot take this one's number.
            ctx.footnotes.push('');
            ctx.footnotes[num - 1] = processInline(args[0], ctx);
            push(`<sup class="tex-fn-ref"><a href="#fn-${num}" id="fnref-${num}">${num}</a></sup>`);
            i = idx;
            continue;
          }
          idx = tag.end;
          break;
        }
        case 'includegraphics': {
          const bracket = readBracketArg(raw, idx);
          if (bracket) idx = bracket.end;
          const brace = readBraceArg(raw, idx);
          if (brace) {
            const file = brace.content.trim();
            push(
              `<span class="tex-graphic" style="${GRAPHIC_STYLE}" title="${escapeAttr(
                file
              )}">Image: ${escapeHtml(file)}</span>`
            );
            i = brace.end;
            continue;
          }
          idx = tag.end;
          break;
        }
        case 'href': {
          const args = wantsArg(2);
          if (args) {
            const target = safeUrl(args[0]);
            const children = parseInline(args[1], ctx);
            if (target) {
              pushElem(
                `<a class="tex-link" href="${escapeAttr(target)}" target="_blank" rel="noopener noreferrer">`,
                '</a>',
                children
              );
            } else {
              pushElem(
                `<span class="tex-link-blocked" title="Blocked link target: ${escapeAttr(args[0])}">`,
                '</span>',
                children
              );
            }
            i = idx;
            continue;
          }
          idx = tag.end;
          break;
        }
        case 'path': {
          // A file path, not a link: monospaced, never clickable.
          const args = wantsArg(1);
          if (args) {
            push(`<code>${escapeHtml(args[0])}</code>`);
            i = idx;
            continue;
          }
          idx = tag.end;
          break;
        }
        case 'url': {
          const args = wantsArg(1);
          if (args) {
            const target = safeUrl(args[0]);
            push(
              target
                ? `<a class="tex-link" href="${escapeAttr(
                    target
                  )}" target="_blank" rel="noopener noreferrer"><code>${escapeHtml(args[0])}</code></a>`
                : `<code class="tex-link-blocked" title="Blocked link target">${escapeHtml(args[0])}</code>`
            );
            i = idx;
            continue;
          }
          idx = tag.end;
          break;
        }
        case 'label': {
          const args = wantsArg(1);
          if (args) {
            const pending = ctx.pendingLabelNumber;
            if (pending) ctx.labelMap.set(args[0].trim(), pending);
            push(`<a id="label-${slug(args[0])}" class="tex-label-anchor"></a>`);
            i = idx;
            continue;
          }
          idx = tag.end;
          break;
        }
        case 'ref':
        case 'eqref': {
          const args = wantsArg(1);
          if (args) {
            const key = args[0].trim();
            // `\eqref` is `\ref` in parentheses - the whole point of it is that
            // the reference reads the way the equation is tagged, "(1)".
            const eq = name === 'eqref';
            const resolved = ctx.labelMap.get(key);
            if (resolved !== undefined) {
              const shown = eq ? `(${resolved})` : resolved;
              push(`<a class="tex-ref" href="#label-${slug(key)}">${escapeHtml(shown)}</a>`);
            } else {
              ctx.pendingRefs = true;
              push(
                `<a class="tex-ref tex-ref-pending" href="#label-${slug(key)}" data-ref-key="${escapeAttr(key)}"${
                  eq ? ' data-ref-eq="1"' : ''
                }>${eq ? '(??)' : '??'}</a>`
              );
            }
            i = idx;
            continue;
          }
          idx = tag.end;
          break;
        }
        case 'cite': {
          const args = wantsArg(1);
          if (args) {
            const keys = args[0]
              .split(',')
              .map((k) => k.trim())
              .filter(Boolean);
            const nums = keys.map((k) => {
              let num = ctx.citeMap.get(k);
              if (num === undefined) {
                num = ctx.citeMap.size + 1;
                ctx.citeMap.set(k, num);
              }
              return num;
            });
            push(`<sup class="tex-cite">[${nums.join(', ')}]</sup>`);
            i = idx;
            continue;
          }
          idx = tag.end;
          break;
        }
        case 'newline': {
          push('<br>');
          i = idx;
          continue;
        }
        default:
          break;
      }

      const symbol = SYMBOL_COMMANDS[name];
      if (symbol !== undefined) {
        textBuf += symbol;
        // A control word swallows the spaces after it; `\LaTeX is` must not
        // come out as "LaTeXis", so a single following space is kept.
        i = idx;
        if (raw[i] === ' ') {
          textBuf += ' ';
          i++;
        }
        continue;
      }

      if (NOOP_COMMANDS.has(name)) {
        flush();
        i = idx;
        continue;
      }

      if (LENGTH_COMMANDS.has(name)) {
        // `\itemsep0pt`, `\parskip=1ex plus 2pt`: the value belongs to the
        // register, not to the prose.
        const value = LENGTH_VALUE_RE.exec(raw.slice(idx));
        flush();
        i = idx + (value ? value[0].length : 0);
        continue;
      }

      if (DROP_ARG_COMMANDS.has(name)) {
        flush();
        i = consumeOptAndBraceArgs(raw, idx, 2).end;
        continue;
      }

      // Anything still unknown: show what it *says*. Silently deleting a
      // command and two brace groups threw away whole sentences - the author's
      // own macros, an unsupported sectioning command, a package's markup - with
      // nothing in the preview to hint that text had gone missing.
      flush();
      // Leading optional arguments are placement/sizing hints, never the text
      // (`\makebox[1cm][l]{words}`), so step over all of them.
      for (let k = 0; k < 3; k++) {
        const bracket = readBracketArg(raw, idx);
        if (!bracket) break;
        idx = bracket.end;
      }
      const argNodes: Inline[] = [];
      for (let k = 0; k < 2; k++) {
        const brace = readBraceArg(raw, idx);
        if (!brace) break;
        if (argNodes.length > 0) argNodes.push({ type: 'html', html: ' ' });
        argNodes.push(...parseInline(brace.content, ctx));
        idx = brace.end;
      }
      if (argNodes.length > 0) {
        nodes.push(...argNodes);
      } else {
        // No argument to fall back on; name the command rather than vanish.
        nodes.push({
          type: 'html',
          html: `<span class="tex-unknown-cmd" style="${UNKNOWN_CMD_STYLE}" title="Unsupported command">${escapeHtml(
            `\\${name}`
          )}</span>`
        });
      }
      i = idx;
      continue;
    }

    textBuf += c;
    i++;
  }
  flush();
  return nodes;
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

function resolvePendingRefs(html: string, ctx: Ctx): string {
  if (!ctx.pendingRefs) return html;
  return html.replace(
    /<a class="tex-ref tex-ref-pending" href="#label-[^"]*" data-ref-key="([^"]*)"( data-ref-eq="1")?>\(?\?\?\)?<\/a>/g,
    (full: string, keyAttr: string, eqFlag: string | undefined) => {
      // keyAttr is HTML-attribute-escaped; unescape the minimal set we used
      const key = keyAttr.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const resolved = ctx.labelMap.get(key);
      if (resolved === undefined) return full;
      // A forward `\eqref` keeps its parentheses when it finally resolves.
      const shown = eqFlag ? `(${resolved})` : resolved;
      return `<a class="tex-ref" href="#label-${slug(key)}">${escapeHtml(shown)}</a>`;
    }
  );
}

function renderFootnotes(ctx: Ctx): string {
  if (ctx.footnotes.length === 0) return '';
  const items = ctx.footnotes
    .map((f, idx) => `<li id="fn-${idx + 1}"><a href="#fnref-${idx + 1}" class="tex-fn-back">&#8617;</a> ${f}</li>`)
    .join('');
  return `<hr class="tex-fn-rule"><ol class="tex-footnotes">${items}</ol>`;
}

export function renderLatex(source: string): RenderResult {
  try {
    const ctx = makeCtx();

    // The placeholder marker must never come from the document itself.
    const raw = (source ?? '').split(SENTINEL).join('');

    // Comments, verbatim bodies and `\verb` arguments are decided together in
    // one catcode-aware pass: which of them a `%` or a `\begin{lstlisting}`
    // belongs to depends on what came before it, so no ordering of separate
    // passes can get every document right.
    const noComments = scanSource(raw, ctx);

    // Document-defined macros are substituted before anything else reads the
    // source, so `\vect{x}` reaches math extraction and the inline layer as the
    // text the author meant by it.
    const defs = collectMacros(noComments);
    const expanded = expandMacros(defs.text, defs.macros);

    const docMatch = /\\begin\{document\}([\s\S]*?)\\end\{document\}/.exec(expanded);
    // `docMatch === null`, explicitly: a document whose `\begin{document}` is on
    // line 1 has an *empty* preamble, and an empty string is falsy. Falling back
    // on `||` therefore searched the whole body for \title/\author/\date and
    // promoted the first `\title{...}` mentioned in the prose to the document's
    // real title.
    const preambleText = docMatch === null ? expanded : expanded.slice(0, docMatch.index);
    const bodyText = docMatch === null ? expanded : docMatch[1];

    ctx.preamble.title = extractCommandArg(preambleText, 'title');
    ctx.preamble.author = extractCommandArg(preambleText, 'author');
    ctx.preamble.date = extractCommandArg(preambleText, 'date');

    let stage = extractMath(bodyText, ctx);
    stage = extractTabular(stage, ctx);

    const tree = buildTree(stage);
    let bodyHtml = renderNodes(tree, ctx);

    // Placeholder substitution before the footnote list is serialized, not
    // after: it is the last thing that can still run inline processing (a table
    // that reached the output some other way), and a \footnote or \cite it
    // discovers has to be able to reach the list. Serializing first left a
    // cell's footnote as a live anchor pointing at an <li> that was never
    // emitted.
    bodyHtml = substitutePlaceholders(bodyHtml, ctx);
    bodyHtml += substitutePlaceholders(renderFootnotes(ctx), ctx);
    bodyHtml = resolvePendingRefs(bodyHtml, ctx);

    const html = `<div class="tex-doc-root">${bodyHtml}</div>`;
    return { html, mathCount: ctx.mathBlocks.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      html: `<div class="tex-doc-root"><p class="tex-render-error">Preview error: ${escapeHtml(msg)}</p></div>`,
      mathCount: 0
    };
  } finally {
    // The brace tables only help *within* one render; keeping them would pin a
    // handful of document-sized buffers (and the strings they were built from)
    // alive between keystrokes.
    braceTableCache.clear();
  }
}
