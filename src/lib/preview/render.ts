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

// Finds the matching closing brace for an opening `{` at index `open`.
function findMatchingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '\\') {
      i++; // skip escaped char (e.g. \{ \})
      continue;
    }
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
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
}
interface TableBlock {
  colSpec: string;
  rows: string[][];
}

interface Ctx {
  counters: {
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
    counters: { section: 0, subsection: 0, subsubsection: 0, figure: 0, table: 0 },
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
// Stage 1: comments
// ---------------------------------------------------------------------------

// Commands whose first brace argument is a URL / path rather than LaTeX text.
// TeX itself makes `%` an ordinary character there (that is the whole point of
// \url), so comment stripping has to step over the argument verbatim.
const URL_ARG_COMMANDS = new Set(['url', 'href', 'path']);

function stripComments(src: string): string {
  // Remove unescaped `%...` to end of line. `\%` is a literal percent, kept.
  //
  // Verbatim/lstlisting bodies are already gone by the time this runs (they
  // were replaced with placeholders, which contain no `%`), so the only other
  // place a bare `%` is legal is a URL argument - handled below.
  const cmdRe = /\\([a-zA-Z]+)/y;
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const next = src[i + 1];
      if (next === undefined) {
        out += c;
        i++;
        continue;
      }
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
      // any other escape sequence: copy the backslash and the char it escapes
      out += c + next;
      i += 2;
      continue;
    }
    if (c === '%') {
      while (i < src.length && src[i] !== '\n') i++;
      // leave the newline itself for the next iteration
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 2: verbatim / lstlisting extraction (must happen before anything else
// touches the body, since their contents are not LaTeX).
// ---------------------------------------------------------------------------

function extractVerbatim(body: string, ctx: Ctx): string {
  const re = /\\begin\{(verbatim|lstlisting)\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{\1\}/g;
  return body.replace(re, (_m, env: string, content: string) => {
    // drop a single leading newline (common right after \begin{...})
    const cleaned = content.replace(/^\n/, '').replace(/\n$/, '');
    const idx = ctx.verbBlocks.length;
    ctx.verbBlocks.push({ content: cleaned, code: env === 'lstlisting' });
    return `${SENTINEL}V${idx}${SENTINEL}`;
  });
}

// ---------------------------------------------------------------------------
// Stage 3: math extraction
// ---------------------------------------------------------------------------

function renderMath(src: string, displayMode: boolean): string {
  try {
    return katex.renderToString(src, {
      displayMode,
      throwOnError: false,
      strict: 'ignore'
    });
  } catch {
    return `<span class="tex-math-error">${escapeHtml(src)}</span>`;
  }
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
    // display: $$...$$
    if (body.startsWith('$$', i)) {
      const close = body.indexOf('$$', i + 2);
      const end = close === -1 ? n : close + 2;
      const src = body.slice(i + 2, close === -1 ? n : close);
      out += pushMath(ctx, renderMath(src, true));
      i = end;
      continue;
    }
    // display: \[ ... \]
    if (body.startsWith('\\[', i)) {
      const close = body.indexOf('\\]', i + 2);
      const end = close === -1 ? n : close + 2;
      const src = body.slice(i + 2, close === -1 ? n : close);
      out += pushMath(ctx, renderMath(src, true));
      i = end;
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
      const contentEnd = closeIdx === -1 ? n : closeIdx;
      const rawSrc = body.slice(bodyStart, contentEnd);

      if (envName !== 'equation' && !starred) {
        // align / gather: one equation number per row, tagged inside KaTeX.
        const html = renderMath(numberMathRows(envName, rawSrc, ctx), true);
        out += pushMath(ctx, html);
        i = closeIdx === -1 ? n : closeIdx + endTag.length;
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
      i = closeIdx === -1 ? n : closeIdx + endTag.length;
      continue;
    }
    // standalone \begin{aligned}...\end{aligned} (normally nested in $$, but
    // tolerate top-level use as its own display block)
    if (body.startsWith('\\begin{aligned}', i)) {
      const endTag = '\\end{aligned}';
      const bodyStart = i + '\\begin{aligned}'.length;
      const closeIdx = body.indexOf(endTag, bodyStart);
      const contentEnd = closeIdx === -1 ? n : closeIdx;
      const src = body.slice(bodyStart, contentEnd);
      const html = renderMath(`\\begin{aligned}${src}\\end{aligned}`, true);
      out += pushMath(ctx, html);
      i = closeIdx === -1 ? n : closeIdx + endTag.length;
      continue;
    }
    // inline: \( ... \)
    if (body.startsWith('\\(', i)) {
      const close = body.indexOf('\\)', i + 2);
      const end = close === -1 ? n : close + 2;
      const src = body.slice(i + 2, close === -1 ? n : close);
      out += pushMath(ctx, renderMath(src, false));
      i = end;
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
// Stage 4: tabular extraction -> HTML <table> (deferred cell rendering)
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

function extractTabular(body: string, ctx: Ctx): string {
  let out = '';
  let i = 0;
  const n = body.length;
  while (i < n) {
    if (body.startsWith('\\begin{tabular}', i)) {
      let idx = i + '\\begin{tabular}'.length;
      const bracket = readBracketArg(body, idx);
      if (bracket) idx = bracket.end;
      const brace = readBraceArg(body, idx);
      const colSpec = brace ? brace.content : '';
      if (brace) idx = brace.end;
      const endTag = '\\end{tabular}';
      const closeIdx = body.indexOf(endTag, idx);
      const contentEnd = closeIdx === -1 ? n : closeIdx;
      const raw = body.slice(idx, contentEnd);
      const rows = splitTableRows(raw);
      const tIdx = ctx.tableBlocks.length;
      ctx.tableBlocks.push({ colSpec, rows });
      out += `${SENTINEL}T${tIdx}${SENTINEL}`;
      i = closeIdx === -1 ? n : closeIdx + endTag.length;
      continue;
    }
    out += body[i];
    i++;
  }
  return out;
}

function colAlignment(spec: string): Array<'left' | 'center' | 'right'> {
  const aligns: Array<'left' | 'center' | 'right'> = [];
  for (const ch of spec) {
    if (ch === 'l') aligns.push('left');
    else if (ch === 'c') aligns.push('center');
    else if (ch === 'r') aligns.push('right');
  }
  return aligns;
}

function renderTableBlock(t: TableBlock, ctx: Ctx): string {
  const aligns = colAlignment(t.colSpec);
  const rowsHtml = t.rows
    .map((row) => {
      const cells = row
        .map((cell, ci) => {
          const align = aligns[ci];
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
// Stage 5: environment tree (itemize/enumerate/description/figure/table/quote/center/...)
// ---------------------------------------------------------------------------

type Node =
  | { type: 'text'; content: string }
  | { type: 'env'; name: string; arg: string | null; children: Node[] };

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
        if (stack.length > 0) stack.pop();
        currentChildren = stack.length ? stack[stack.length - 1].children : root;
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

const HEADING_TAGS: Record<string, string> = {
  section: 'h2',
  subsection: 'h3',
  subsubsection: 'h4'
};

function matchBlockCmd(
  s: string,
  i: number
):
  | { kind: 'section' | 'subsection' | 'subsubsection' | 'paragraph'; starred: boolean; end: number }
  | { kind: 'maketitle'; end: number }
  | { kind: 'caption'; end: number }
  | null {
  if (s[i] !== '\\') return null;
  const order: Array<'subsubsection' | 'subsection' | 'section' | 'paragraph'> = [
    'subsubsection',
    'subsection',
    'section',
    'paragraph'
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

function renderTitleBlock(ctx: Ctx): string {
  const { title, author, date } = ctx.preamble;
  const parts: string[] = [];
  if (title) parts.push(`<h1 class="tex-title">${processInline(title, ctx)}</h1>`);
  if (author) parts.push(`<div class="tex-author">${processInline(author, ctx)}</div>`);
  if (date) parts.push(`<div class="tex-date">${processInline(date, ctx)}</div>`);
  if (parts.length === 0) return '';
  return `<div class="tex-title-block">${parts.join('')}</div>`;
}

function renderHeading(
  kind: 'section' | 'subsection' | 'subsubsection',
  starred: boolean,
  rawTitle: string,
  ctx: Ctx
): string {
  let numStr = '';
  if (!starred) {
    if (kind === 'section') {
      ctx.counters.section++;
      ctx.counters.subsection = 0;
      ctx.counters.subsubsection = 0;
      numStr = `${ctx.counters.section}`;
    } else if (kind === 'subsection') {
      ctx.counters.subsection++;
      ctx.counters.subsubsection = 0;
      numStr = `${ctx.counters.section}.${ctx.counters.subsection}`;
    } else {
      ctx.counters.subsubsection++;
      numStr = `${ctx.counters.section}.${ctx.counters.subsection}.${ctx.counters.subsubsection}`;
    }
  }
  ctx.currentFloat = null;
  ctx.pendingLabelNumber = numStr || null;
  const titleHtml = processInline(rawTitle, ctx);
  const tag = HEADING_TAGS[kind];
  const numSpan = numStr ? `<span class="tex-secnum">${numStr}</span>` : '';
  const id = numStr ? ` id="sec-${slug(numStr)}"` : ` id="sec-${slug(rawTitle)}"`;
  return `<${tag}${id} class="tex-heading tex-${kind}">${numSpan}${titleHtml}</${tag}>`;
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
  if (kind === 'V' || kind === 'T') return true;
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
  // line) after every code block, table and display equation. Emit those as
  // siblings of the paragraphs instead, and drop paragraphs that render empty.
  const placeholderRe = new RegExp(`${SENTINEL}([MVT])(\\d+)${SENTINEL}`, 'g');
  const out: string[] = [];
  const pushPara = (html: string) => {
    if (html.trim().length > 0) out.push(`<p class="tex-p">${html}</p>`);
  };

  for (const p of paras) {
    const html = processInline(p, ctx);
    placeholderRe.lastIndex = 0;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = placeholderRe.exec(html))) {
      if (!isBlockPlaceholder(m[1], parseInt(m[2], 10), ctx)) continue;
      pushPara(html.slice(last, m.index));
      out.push(m[0]);
      last = m.index + m[0].length;
    }
    pushPara(html.slice(last));
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
      if (m.kind === 'paragraph') {
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
      // section / subsection / subsubsection
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
  const itemRe = /\\item(?:\[((?:[^[\]])*)\])?/g;
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

function renderNodes(nodes: Node[], ctx: Ctx): string {
  return nodes
    .map((n) => (n.type === 'text' ? renderTextBlock(n.content, ctx).join('') : renderEnv(n, ctx)))
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
// ---------------------------------------------------------------------------

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
  'listoftables'
]);

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
function renderGroup(inner: string, ctx: Ctx): string {
  const declRe = /^\s*\\([a-zA-Z]+)[ \t]*/;
  const open: string[] = [];
  const close: string[] = [];
  let rest = inner;
  for (;;) {
    const m = declRe.exec(rest);
    if (!m) break;
    const wrapper = DECLARATION_WRAPPERS[m[1]];
    if (!wrapper) break;
    open.push(wrapper[0]);
    close.unshift(wrapper[1]);
    rest = rest.slice(m[0].length);
  }
  return `${open.join('')}${processInline(rest, ctx)}${close.join('')}`;
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
        const cls = vb.code ? 'tex-code' : 'tex-verbatim';
        out += `<pre class="${cls}"><code>${escapeHtml(vb.content)}</code></pre>`;
      } else if (kind === 'T' && ctx.tableBlocks[idx]) {
        // Table cells may themselves contain math/verbatim placeholder tokens
        // (extraction ran on the whole document before tabular extraction),
        // so resolve those too before splicing the table in.
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
  let htmlOut = '';
  let textBuf = '';
  let i = 0;
  const n = raw.length;

  const flush = () => {
    if (!textBuf) return;
    htmlOut += escapeHtml(textBuf);
    textBuf = '';
  };

  while (i < n) {
    const c = raw[i];

    // sentinel placeholders (math / verbatim / table) pass through untouched
    if (c === SENTINEL) {
      let j = i + 2;
      while (j < n && raw[j] !== SENTINEL) j++;
      if (j < n) {
        flush();
        htmlOut += raw.slice(i, j + 1);
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
        htmlOut += renderGroup(raw.slice(i + 1, close), ctx);
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
      textBuf += ' ';
      i++;
      continue;
    }

    if (c === '\\') {
      const next = raw[i + 1];
      // line break
      if (next === '\\') {
        flush();
        htmlOut += '<br>';
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

      switch (name) {
        case 'textbf':
        case 'bf': {
          const args = wantsArg(1);
          if (args) {
            flush();
            htmlOut += `<strong>${processInline(args[0], ctx)}</strong>`;
            i = idx;
            continue;
          }
          break;
        }
        case 'textit':
        case 'it':
        case 'emph': {
          const args = wantsArg(1);
          if (args) {
            flush();
            htmlOut += `<em>${processInline(args[0], ctx)}</em>`;
            i = idx;
            continue;
          }
          break;
        }
        case 'texttt':
        case 'tt': {
          const args = wantsArg(1);
          if (args) {
            flush();
            htmlOut += `<code>${processInline(args[0], ctx)}</code>`;
            i = idx;
            continue;
          }
          break;
        }
        case 'underline': {
          const args = wantsArg(1);
          if (args) {
            flush();
            htmlOut += `<u>${processInline(args[0], ctx)}</u>`;
            i = idx;
            continue;
          }
          break;
        }
        case 'footnote': {
          const args = wantsArg(1);
          if (args) {
            flush();
            const num = ctx.footnotes.length + 1;
            ctx.footnotes.push(processInline(args[0], ctx));
            htmlOut += `<sup class="tex-fn-ref"><a href="#fn-${num}" id="fnref-${num}">${num}</a></sup>`;
            i = idx;
            continue;
          }
          break;
        }
        case 'href': {
          const args = wantsArg(2);
          if (args) {
            flush();
            const target = safeUrl(args[0]);
            const text = processInline(args[1], ctx);
            htmlOut += target
              ? `<a class="tex-link" href="${escapeAttr(
                  target
                )}" target="_blank" rel="noopener noreferrer">${text}</a>`
              : `<span class="tex-link-blocked" title="Blocked link target: ${escapeAttr(
                  args[0]
                )}">${text}</span>`;
            i = idx;
            continue;
          }
          break;
        }
        case 'url': {
          const args = wantsArg(1);
          if (args) {
            flush();
            const target = safeUrl(args[0]);
            htmlOut += target
              ? `<a class="tex-link" href="${escapeAttr(
                  target
                )}" target="_blank" rel="noopener noreferrer"><code>${escapeHtml(args[0])}</code></a>`
              : `<code class="tex-link-blocked" title="Blocked link target">${escapeHtml(args[0])}</code>`;
            i = idx;
            continue;
          }
          break;
        }
        case 'label': {
          const args = wantsArg(1);
          if (args) {
            flush();
            const pending = ctx.pendingLabelNumber;
            if (pending) ctx.labelMap.set(args[0].trim(), pending);
            htmlOut += `<a id="label-${slug(args[0])}" class="tex-label-anchor"></a>`;
            i = idx;
            continue;
          }
          break;
        }
        case 'ref':
        case 'eqref': {
          const args = wantsArg(1);
          if (args) {
            flush();
            const key = args[0].trim();
            const resolved = ctx.labelMap.get(key);
            if (resolved !== undefined) {
              htmlOut += `<a class="tex-ref" href="#label-${slug(key)}">${resolved}</a>`;
            } else {
              ctx.pendingRefs = true;
              htmlOut += `<a class="tex-ref tex-ref-pending" href="#label-${slug(
                key
              )}" data-ref-key="${escapeAttr(key)}">??</a>`;
            }
            i = idx;
            continue;
          }
          break;
        }
        case 'cite': {
          const args = wantsArg(1);
          if (args) {
            flush();
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
            htmlOut += `<sup class="tex-cite">[${nums.join(', ')}]</sup>`;
            i = idx;
            continue;
          }
          break;
        }
        default:
          break;
      }

      if (NOOP_COMMANDS.has(name)) {
        flush();
        i = idx;
        continue;
      }

      // unknown command: drop it, swallow up to 2 immediately-following
      // brace groups (and one optional bracket group) without rendering them
      flush();
      const consumed = consumeOptAndBraceArgs(raw, idx, 2);
      i = consumed.end;
      continue;
    }

    textBuf += c;
    i++;
  }
  flush();
  return htmlOut;
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

function resolvePendingRefs(html: string, ctx: Ctx): string {
  if (!ctx.pendingRefs) return html;
  return html.replace(
    /<a class="tex-ref tex-ref-pending" href="#label-[^"]*" data-ref-key="([^"]*)">\?\?<\/a>/g,
    (full: string, keyAttr: string) => {
      // keyAttr is HTML-attribute-escaped; unescape the minimal set we used
      const key = keyAttr.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const resolved = ctx.labelMap.get(key);
      if (resolved === undefined) return full;
      return `<a class="tex-ref" href="#label-${slug(key)}">${resolved}</a>`;
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

    // Verbatim/lstlisting first: `%` is an ordinary character inside them, so
    // stripping comments before they are pulled out would delete the rest of
    // any line containing one (a modulo operator, a `20% off`, a `printf("100%%")`).
    const verbatimSafe = extractVerbatim(raw, ctx);
    const noComments = stripComments(verbatimSafe);

    const docMatch = /\\begin\{document\}([\s\S]*?)\\end\{document\}/.exec(noComments);
    const preambleText = docMatch ? noComments.slice(0, docMatch.index) : '';
    const bodyText = docMatch ? docMatch[1] : noComments;

    ctx.preamble.title = extractCommandArg(preambleText || noComments, 'title');
    ctx.preamble.author = extractCommandArg(preambleText || noComments, 'author');
    ctx.preamble.date = extractCommandArg(preambleText || noComments, 'date');

    let stage = extractMath(bodyText, ctx);
    stage = extractTabular(stage, ctx);

    const tree = buildTree(stage);
    let bodyHtml = renderNodes(tree, ctx);
    bodyHtml += renderFootnotes(ctx);

    bodyHtml = substitutePlaceholders(bodyHtml, ctx);
    bodyHtml = resolvePendingRefs(bodyHtml, ctx);

    const html = `<div class="tex-doc-root">${bodyHtml}</div>`;
    return { html, mathCount: ctx.mathBlocks.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      html: `<div class="tex-doc-root"><p class="tex-render-error">Preview error: ${escapeHtml(msg)}</p></div>`,
      mathCount: 0
    };
  }
}
