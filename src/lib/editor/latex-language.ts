// Hand-written LaTeX language support for CodeMirror 6.
// OWNER: editor agent. StreamLanguage-based stream parser (no external LaTeX
// grammar package) covering commands, math delimiters, environments,
// comments, brace/bracket punctuation and section-family headings, plus a
// text-based fold service for \begin{}/\end{} blocks and a matching
// HighlightStyle built from @lezer/highlight tags.

import { tags } from '@lezer/highlight';
import {
  StreamLanguage,
  LanguageSupport,
  HighlightStyle,
  foldService,
  type StreamParser
} from '@codemirror/language';
import type { StringStream } from '@codemirror/language';
import type { Text } from '@codemirror/state';

/** Commands that introduce a sectioning heading, mapped to a heading level. */
const SECTION_COMMANDS: Record<string, number> = {
  part: 1,
  chapter: 1,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5
};

const HEADING_TAG_BY_LEVEL: readonly string[] = [
  'heading1',
  'heading1',
  'heading2',
  'heading3',
  'heading4',
  'heading5'
];

/** Escaped literal characters: \\, \$, \%, \&, \#, \_, \{, \}, \^, \~ */
const ESCAPE_RE = /^\\[\\$%&#_{}^~]/;
/** A generic \command name (letters, optionally starred). */
const COMMAND_RE = /^\\[a-zA-Z]+\*?/;
/** A single-character control symbol, e.g. \, \; \: \! */
const CONTROL_SYMBOL_RE = /^\\[^a-zA-Z\s]/;

type BraceExpect = 'brace:begin' | 'brace:end' | 'name:begin' | 'name:end' | null;

export interface LatexState {
  /** Which math-mode delimiter is currently open, if any. */
  mathMode: null | '$' | '$$' | '\\[' | '\\(';
  /** Tracks the \begin{ / \end{ → name → } sequence across tokens. */
  expect: BraceExpect;
  /** Nesting depth of \begin{...}/\end{...} environments, for indentation. */
  envDepth: number;
  /** Nesting depth of { } groups, for indentation. */
  braceDepth: number;
}

function startState(): LatexState {
  return { mathMode: null, expect: null, envDepth: 0, braceDepth: 0 };
}

function copyState(state: LatexState): LatexState {
  return { ...state };
}

function tokenBase(stream: StringStream, state: LatexState): string | null {
  // Continue a pending \begin{ / \end{ name-or-brace sequence.
  if (state.expect === 'brace:begin' || state.expect === 'brace:end') {
    if (stream.match('{')) {
      state.expect = state.expect === 'brace:begin' ? 'name:begin' : 'name:end';
      state.braceDepth++;
      return 'brace';
    }
    state.expect = null;
  } else if (state.expect === 'name:begin' || state.expect === 'name:end') {
    if (stream.match(/^[a-zA-Z*]+/)) {
      if (state.expect === 'name:begin') state.envDepth++;
      else state.envDepth = Math.max(0, state.envDepth - 1);
      state.expect = null;
      return 'className';
    }
    state.expect = null;
  }

  // Comments run to end of line.
  if (stream.match('%')) {
    stream.skipToEnd();
    return 'comment';
  }

  // Escaped literal characters.
  if (stream.match(ESCAPE_RE)) return 'escape';

  // Math-mode delimiters (toggle in/out of math, styled distinctly).
  if (!state.mathMode) {
    if (stream.match('$$')) {
      state.mathMode = '$$';
      return 'processingInstruction';
    }
    if (stream.match('$')) {
      state.mathMode = '$';
      return 'processingInstruction';
    }
    if (stream.match('\\[')) {
      state.mathMode = '\\[';
      return 'processingInstruction';
    }
    if (stream.match('\\(')) {
      state.mathMode = '\\(';
      return 'processingInstruction';
    }
  } else {
    if (state.mathMode === '$$' && stream.match('$$')) {
      state.mathMode = null;
      return 'processingInstruction';
    }
    if (state.mathMode === '$' && stream.match('$')) {
      state.mathMode = null;
      return 'processingInstruction';
    }
    if (state.mathMode === '\\[' && stream.match('\\]')) {
      state.mathMode = null;
      return 'processingInstruction';
    }
    if (state.mathMode === '\\(' && stream.match('\\)')) {
      state.mathMode = null;
      return 'processingInstruction';
    }
  }

  // \begin{...} / \end{...}
  const beginEnd = stream.match(/^\\(begin|end)\b/) as RegExpMatchArray | null;
  if (beginEnd) {
    state.expect = beginEnd[1] === 'begin' ? 'brace:begin' : 'brace:end';
    return 'controlKeyword';
  }

  // \section, \subsection, \chapter, ...
  const sectionMatch = stream.match(/^\\([a-zA-Z]+)\*?/, false) as RegExpMatchArray | null;
  if (sectionMatch && Object.prototype.hasOwnProperty.call(SECTION_COMMANDS, sectionMatch[1])) {
    stream.match(/^\\[a-zA-Z]+\*?/);
    const level = SECTION_COMMANDS[sectionMatch[1]];
    return HEADING_TAG_BY_LEVEL[level] ?? 'heading';
  }

  // Any other \command.
  if (stream.match(COMMAND_RE)) return 'keyword';
  if (stream.match(CONTROL_SYMBOL_RE)) return 'keyword';

  // Braces / brackets.
  if (stream.match('{')) {
    state.braceDepth++;
    return 'brace';
  }
  if (stream.match('}')) {
    state.braceDepth = Math.max(0, state.braceDepth - 1);
    return 'brace';
  }
  if (stream.match(/^[[\]]/)) return 'squareBracket';

  // Sub/superscript markers and alignment tab.
  if (stream.match(/^[\^_]/)) return 'operator';
  if (stream.match('&')) return 'separator';

  // Numbers.
  if (stream.match(/^\d+(\.\d+)?/)) return 'number';

  // Plain content: consume a run of ordinary characters.
  if (stream.match(/^[a-zA-Z]+/)) return state.mathMode ? 'variableName' : null;

  stream.next();
  return null;
}

export const latexStreamParser: StreamParser<LatexState> = {
  name: 'latex',
  startState,
  copyState,
  token: tokenBase,
  blankLine(state) {
    // A blank line never carries math mode across a paragraph break.
    state.mathMode = null;
  },
  indent(state, textAfter, context) {
    const closing = /^\s*(\\end\b|\})/.test(textAfter);
    const depth = state.envDepth + state.braceDepth - (closing ? 1 : 0);
    return Math.max(0, depth) * context.unit;
  },
  languageData: {
    commentTokens: { line: '%' },
    closeBrackets: { brackets: ['{', '[', '('] }
  }
};

export const latexLanguage = StreamLanguage.define(latexStreamParser);

/** Matches an opening \begin{name}, capturing the environment name. */
const BEGIN_RE = /\\begin\{([a-zA-Z*]+)\}/g;
/** Matches a closing \end{name}, capturing the environment name. */
const END_RE = /\\end\{([a-zA-Z*]+)\}/g;

/**
 * Cap on how much of the document one fold lookup will scan forward before
 * giving up. Without this, asking about the line holding `\begin{document}` —
 * on screen in nearly every document, since it sits near the top — walked
 * every remaining line to find its `\end{document}`, and the fold gutter
 * asks on every doc-changing transaction. That made every keystroke anywhere
 * in a large document cost O(document length), no matter how far the edit
 * was from `\begin{document}` itself.
 *
 * A capped scan degrades gracefully: past the cap, that one environment is
 * reported as not foldable rather than paying an unbounded cost to prove it
 * is. `MAX_FOLD_SCAN_CHARS` is generous enough to cover any document this
 * editor is comfortable holding in memory in the first place.
 */
const MAX_FOLD_SCAN_CHARS = 200_000;

/**
 * Per-document-version memo of `latexFoldService` results, keyed by the
 * position right after the opening `\begin{name}{`. `foldService` is asked
 * about every foldable line in the viewport on every update — including
 * viewport/selection changes that don't touch `state.doc` at all — so this
 * turns repeat questions about the same environment in the same document
 * version into a cache hit instead of a repeat scan. Keyed by the `Text`
 * value itself (stable per document version, structurally shared across
 * edits elsewhere in the document) rather than kept alive explicitly: once
 * that version is no longer referenced anywhere, the entry can be collected.
 */
const foldCache = new WeakMap<Text, Map<number, { from: number; to: number } | null>>();

/**
 * Text-based folding for \begin{env} ... \end{env} blocks. Scans forward
 * from `lineStart` tracking a stack of open environments so that nested and
 * same-named environments fold correctly, independent of the tokenizer.
 */
const latexFoldService = foldService.of((state, lineStart, lineEnd) => {
  const startLine = state.doc.lineAt(lineStart);
  BEGIN_RE.lastIndex = 0;
  const openMatch = BEGIN_RE.exec(startLine.text.slice(0, lineEnd - startLine.from));
  if (!openMatch) return null;

  const envName = openMatch[1];
  const openEnd = lineStart + openMatch.index + openMatch[0].length;

  let perDoc = foldCache.get(state.doc);
  if (!perDoc) {
    perDoc = new Map();
    foldCache.set(state.doc, perDoc);
  }
  const cached = perDoc.get(openEnd);
  if (cached !== undefined) return cached;

  let depth = 1;
  let pos = openEnd;
  let scanned = 0;
  const doc = state.doc;
  let lineNo = doc.lineAt(pos).number;

  while (lineNo <= doc.lines && scanned <= MAX_FOLD_SCAN_CHARS) {
    const line = doc.line(lineNo);
    const from = Math.max(pos, line.from) - line.from;
    const text = line.text.slice(from);
    scanned += text.length;

    BEGIN_RE.lastIndex = 0;
    END_RE.lastIndex = 0;
    type Hit = { index: number; name: string; open: boolean };
    const hits: Hit[] = [];
    let m: RegExpExecArray | null;
    while ((m = BEGIN_RE.exec(text))) hits.push({ index: m.index, name: m[1], open: true });
    while ((m = END_RE.exec(text))) hits.push({ index: m.index, name: m[1], open: false });
    hits.sort((a, b) => a.index - b.index);

    for (const hit of hits) {
      if (hit.name !== envName) continue;
      depth += hit.open ? 1 : -1;
      if (depth === 0) {
        const endPos = line.from + from + hit.index;
        if (endPos <= openEnd) continue;
        const range = { from: openEnd, to: endPos };
        perDoc.set(openEnd, range);
        return range;
      }
    }

    lineNo++;
    pos = line.to + 1;
  }

  // Either genuinely unterminated, or the cap was hit first — either way,
  // not worth re-scanning for on every subsequent query this document
  // version sees.
  perDoc.set(openEnd, null);
  return null;
});

/** Highlight style mapping the tag names emitted by {@link latexStreamParser}. */
export const latexHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, fontStyle: 'italic', color: 'var(--cm-latex-comment, #6b7280)' },
  { tag: tags.escape, color: 'var(--cm-latex-escape, #b5651d)' },
  { tag: tags.controlKeyword, color: 'var(--cm-latex-command, #af00db)', fontWeight: '600' },
  { tag: tags.keyword, color: 'var(--cm-latex-command, #af00db)' },
  { tag: tags.className, color: 'var(--cm-latex-env, #267f99)', fontWeight: '600' },
  { tag: tags.processingInstruction, color: 'var(--cm-latex-math, #0550ae)', fontWeight: '600' },
  { tag: tags.variableName, color: 'var(--cm-latex-mathvar, #0550ae)', fontStyle: 'italic' },
  { tag: tags.brace, color: 'var(--cm-latex-brace, #444444)' },
  { tag: tags.squareBracket, color: 'var(--cm-latex-brace, #444444)' },
  { tag: tags.operator, color: 'var(--cm-latex-op, #d73a49)' },
  { tag: tags.separator, color: 'var(--cm-latex-op, #d73a49)' },
  { tag: tags.number, color: 'var(--cm-latex-number, #098658)' },
  { tag: tags.heading1, color: 'var(--cm-latex-heading, #005cc5)', fontWeight: '700' },
  { tag: tags.heading2, color: 'var(--cm-latex-heading, #005cc5)', fontWeight: '700' },
  { tag: tags.heading3, color: 'var(--cm-latex-heading, #005cc5)', fontWeight: '600' },
  { tag: tags.heading4, color: 'var(--cm-latex-heading, #005cc5)', fontWeight: '600' },
  { tag: tags.heading5, color: 'var(--cm-latex-heading, #005cc5)', fontWeight: '600' }
]);

/** Full language support: parser + folding. Highlighting is applied separately via syntaxHighlighting(). */
export function latex(): LanguageSupport {
  return new LanguageSupport(latexLanguage, [latexFoldService]);
}
