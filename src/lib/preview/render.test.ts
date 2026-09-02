// Regression suite for the live-preview renderer.
//
// Every test below is one of the repros a max-effort review of `render.ts`
// executed against the pre-fix code. They are written as the reviewer wrote
// them - the same source string - and assert the *fixed* behaviour, so each one
// fails if the corresponding fix is backed out.

import { describe, it, expect } from 'vitest';
import { renderLatex, safeUrl } from './render';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip KaTeX's own markup so an assertion can look at *our* output. */
function withoutMath(html: string): string {
  return html.replace(/<span class="katex[\s\S]*?<\/annotation><\/semantics><\/math><\/span>/g, '[MATH]');
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'col']);

/**
 * Walks the tag stream and returns the first nesting violation, or null when
 * the markup is well formed. Used for the `\emph` across a display equation
 * repro, where the pre-fix code cut a finished HTML *string* in half and left
 * an unclosed `<em>` in one paragraph and a stray `</em>` in the next.
 */
function firstImbalance(html: string): string | null {
  const stack: string[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const [, closing, name, selfClosing] = m;
    const tag = name.toLowerCase();
    if (VOID_TAGS.has(tag) || selfClosing === '/') continue;
    if (!closing) {
      stack.push(tag);
      continue;
    }
    const open = stack.pop();
    if (open !== tag) return `</${tag}> closed <${open ?? 'nothing'}>`;
  }
  return stack.length ? `unclosed <${stack[stack.length - 1]}>` : null;
}

/** How many `<tr>` rows the whole fragment contains, nested tables included. */
function countRows(html: string): number {
  return (html.match(/<tr>/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// Stage 1: the catcode-aware scan (comments, verbatim, \verb)
// ---------------------------------------------------------------------------

describe('comments and verbatim', () => {
  // Pre-fix: verbatim was pulled out before comments were stripped, so the
  // commented-out `\begin{lstlisting}` paired with the *real* `\end{lstlisting}`
  // and everything between them - the whole visible document - became one
  // literal block.
  it('a commented-out \\begin{lstlisting} does not blank the document', () => {
    const { html } = renderLatex(String.raw`\begin{document}
% \begin{lstlisting}
Visible paragraph.
\begin{lstlisting}
real code
\end{lstlisting}
After the listing.
\end{document}`);

    expect(html).toContain('Visible paragraph.');
    expect(html).toContain('After the listing.');
    // Exactly one listing, holding only the code that was really in one.
    expect(html.match(/<pre class="tex-code">/g)).toHaveLength(1);
    expect(html).toContain('<pre class="tex-code"><code>real code</code></pre>');
    // The commented-out opener must not survive as text either.
    expect(html).not.toContain('lstlisting');
  });

  // Pre-fix: comments were stripped first, so the `%` inside the \verb argument
  // ate the rest of the line and "off| today." vanished.
  it('\\verb|100% off| keeps the whole line', () => {
    const { html } = renderLatex(String.raw`\begin{document}
Sale: \verb|100% off| today.
\end{document}`);

    expect(html).toContain('<code class="tex-verb">100% off</code>');
    expect(html).toContain('today.');
    expect(html).toBe(
      '<div class="tex-doc-root"><p class="tex-p">Sale: <code class="tex-verb">100% off</code> today.</p></div>'
    );
  });

  // A `\verb` argument is literal text, not LaTeX: it must not reach the
  // sectioning parser.
  it('\\verb|\\section{fake}| emits no heading', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\verb|\section{fake}| stays literal.
\end{document}`);

    expect(html).toContain('<code class="tex-verb">\\section{fake}</code>');
    expect(html).not.toContain('<h2');
    expect(html).not.toContain('tex-heading');
    expect(html).not.toContain('tex-secnum');
  });

  // A real comment is still a comment.
  it('an ordinary comment is still dropped', () => {
    const { html } = renderLatex(String.raw`\begin{document}
Kept. % dropped entirely
\end{document}`);
    expect(html).toContain('Kept.');
    expect(html).not.toContain('dropped entirely');
  });
});

// ---------------------------------------------------------------------------
// Stage 2: math extraction
// ---------------------------------------------------------------------------

describe('math extraction', () => {
  // Pre-fix: the `\[` test ran before the `\\` test, so the second backslash of
  // `\\[6pt]` opened a display-math block that never closed - it swallowed the
  // second heading and every paragraph after it.
  it('\\\\[6pt] is a line break and does not swallow the document', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\section{First}
Line one \\[6pt]
Line two.

\section{Second}
Trailing paragraph.
\end{document}`);

    expect(html).toContain('<br>');
    expect(html).toContain('Line two.');
    // The two things the runaway display block used to eat:
    expect(html).toContain('Second');
    expect(html).toContain('Trailing paragraph.');
    expect(html.match(/class="tex-heading tex-section"/g)).toHaveLength(2);
    // The spacing hint belongs to the break, not to the prose.
    expect(html).not.toContain('6pt');
  });

  it('a real \\[ ... \\] display block still renders as math', () => {
    const { html, mathCount } = renderLatex(String.raw`\begin{document}
\[ a^2 + b^2 = c^2 \]
\end{document}`);
    expect(mathCount).toBe(1);
    expect(html).toContain('katex');
  });

  // Pre-fix: `align` restarted its own numbering, so a document with one
  // equation and one two-row align printed (1) then (1), (2).
  it('equation and align share one counter: equation -> (1), align -> (2), (3)', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\begin{equation}\label{eq:first} a = b \end{equation}
\begin{align}
  c &= d \label{eq:second} \\
  e &= f \label{eq:third}
\end{align}
Refs: \eqref{eq:first}, \eqref{eq:second}, \eqref{eq:third}.
\end{document}`);

    // The equation's own printed number.
    expect(html).toContain('<div class="tex-eqn-num">(1)</div>');
    // The align rows are tagged inside KaTeX, so the numbers KaTeX was handed
    // are the numbers the reader sees.
    expect(html).toContain('\\tag{2}');
    expect(html).toContain('\\tag{3}');
    expect(html).not.toContain('\\tag{1}');

    // And the labels resolve to those same three numbers, in order.
    const refs = html.match(/<a class="tex-ref"[^>]*>[^<]*<\/a>/g) ?? [];
    expect(refs).toEqual([
      '<a class="tex-ref" href="#label-eq-first">(1)</a>',
      '<a class="tex-ref" href="#label-eq-second">(2)</a>',
      '<a class="tex-ref" href="#label-eq-third">(3)</a>'
    ]);
  });

  // Pre-fix: `\eqref` rendered a bare number, so the prose read "see 1" while
  // the equation was tagged "(1)".
  it('\\eqref matches the equation\u2019s rendered tag, \\ref does not add parentheses', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\begin{equation}\label{eq:one} a = b \end{equation}
See \eqref{eq:one} and \ref{eq:one}.
\end{document}`);

    expect(html).toContain('<div class="tex-eqn-num">(1)</div>');
    expect(html).toContain('<a class="tex-ref" href="#label-eq-one">(1)</a>');
    expect(html).toContain('<a class="tex-ref" href="#label-eq-one">1</a>');
  });

  it('a forward \\eqref keeps its parentheses when it resolves', () => {
    const { html } = renderLatex(String.raw`\begin{document}
Later see \eqref{eq:late}.
\begin{equation}\label{eq:late} x \end{equation}
\end{document}`);

    expect(html).toContain('<a class="tex-ref" href="#label-eq-late">(1)</a>');
    expect(html).not.toContain('(??)');
    expect(html).not.toContain('tex-ref-pending');
  });
});

// ---------------------------------------------------------------------------
// Stage 3: tabular
// ---------------------------------------------------------------------------

describe('tabular', () => {
  // Pre-fix: `indexOf('\\end{tabular}')` stopped at the *inner* environment, so
  // the outer table ended after its first row and rows B and C disappeared.
  it('a nested tabular does not terminate the outer table early', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\begin{tabular}{ll}
A & \begin{tabular}{c} x \\ y \end{tabular} \\
B & second \\
C & third \\
\end{tabular}
\end{document}`);

    expect(html).toContain('>B</td>');
    expect(html).toContain('>second</td>');
    expect(html).toContain('>C</td>');
    expect(html).toContain('>third</td>');
    // Two tables: the outer one and the one nested in a cell.
    expect(html.match(/<table class="tex-table">/g)).toHaveLength(2);
    // 3 outer rows + 2 inner rows. The inner `\\` must not split the outer table.
    expect(countRows(html)).toBe(5);
  });

  // Pre-fix: the column spec was read as a bag of characters, so the `c` inside
  // `p{3cm}` declared a centred column and every column after it shifted.
  it('\\begin{tabular}{lp{3cm}r} does not centre column 2, and \\multicolumn spans', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\begin{tabular}{lp{3cm}r}
\multicolumn{2}{c}{Header} & R \\
a & b & c \\
\end{tabular}
\end{document}`);

    const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
    expect(rows).toHaveLength(2);

    // Header row: one spanning cell plus the right-aligned third column.
    expect(rows[0]).toContain('<td colspan="2" style="text-align:center">Header</td>');
    expect(rows[0]).toContain('<td style="text-align:right">R</td>');

    // Body row: l, p{3cm} (left - NOT centre), r.
    expect(rows[1]).toBe(
      '<tr><td style="text-align:left">a</td>' +
        '<td style="text-align:left">b</td>' +
        '<td style="text-align:right">c</td></tr>'
    );
    // The `c` of `3cm` is a width unit, not a column.
    expect(rows[1]).not.toContain('text-align:center');
  });

  it('*{3}{c} expands and |, @{} and >{} declare no column', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\begin{tabular}{|*{3}{c}|@{\quad}r>{\bfseries}l|}
1 & 2 & 3 & 4 & 5 \\
\end{tabular}
\end{document}`);

    const row = (html.match(/<tr>[\s\S]*?<\/tr>/g) ?? [])[0];
    expect(row).toBe(
      '<tr><td style="text-align:center">1</td>' +
        '<td style="text-align:center">2</td>' +
        '<td style="text-align:center">3</td>' +
        '<td style="text-align:right">4</td>' +
        '<td style="text-align:left">5</td></tr>'
    );
  });
});

// ---------------------------------------------------------------------------
// Stage 4: environment tree
// ---------------------------------------------------------------------------

describe('environment tree', () => {
  // Pre-fix: `\end{...}` popped the innermost environment whatever its name
  // was, so an `\end{enumerate}` closed the open `itemize` and every following
  // block silently re-parented - invisible in the output, undiagnosable from
  // the preview.
  it('\\end{enumerate} closing an itemize is reported, not silently swallowed', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\begin{itemize}
\item one
\end{enumerate}
After the list.
\end{document}`);

    expect(html).toContain('\\end{enumerate} has no matching \\begin{enumerate}');
    expect(html).toContain('class="tex-env-error"');
    // The itemize is still an itemize; the stray \end did not turn it into one.
    expect(html).toContain('<ul class="tex-list tex-ul">');
    expect(html).not.toContain('<ol');
    // Nothing after the stray tag was dropped.
    expect(html).toContain('After the list.');
    expect(html).toContain('one');
  });

  it('an unclosed \\begin is reported where it was left open', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\begin{itemize}
\item one
\begin{quote}
dangling
\end{itemize}
After.
\end{document}`);

    expect(html).toContain('\\begin{quote} was not closed before \\end{itemize}');
    expect(html).toContain('After.');
    expect(html).toContain('dangling');
  });

  // Pre-fix: the `\item` regex had no trailing negative lookahead, so the
  // `\itemsep0pt` that half the world's lists carry matched as an `\item` and
  // opened a phantom bullet reading "sep0pt".
  it('\\itemsep0pt produces no phantom "sep0pt" bullet', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\begin{itemize}\itemsep0pt
\item alpha
\item beta
\end{itemize}
\end{document}`);

    expect(html).not.toContain('sep0pt');
    expect(html).not.toContain('0pt');
    expect(html.match(/<li class="tex-li">/g)).toHaveLength(2);
    expect(html).toBe(
      '<div class="tex-doc-root"><ul class="tex-list tex-ul">' +
        '<li class="tex-li"><p class="tex-p">alpha</p></li>' +
        '<li class="tex-li"><p class="tex-p">beta</p></li>' +
        '</ul></div>'
    );
  });

  it('\\parskip=1ex plus 2pt is consumed with its value', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\parskip=1ex plus 2pt
Body text.
\end{document}`);
    expect(html).toContain('Body text.');
    expect(html).not.toContain('1ex');
    expect(html).not.toContain('2pt');
  });
});

// ---------------------------------------------------------------------------
// Inline layer
// ---------------------------------------------------------------------------

describe('inline layer', () => {
  // Pre-fix: the paragraph builder split the *serialized HTML* at a block-level
  // child, cutting straight through the open `<em>`. The browser reparented the
  // stray tag and italics bled through the rest of the document.
  it('\\emph{...} spanning a display equation produces balanced HTML', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\emph{lead in \begin{equation} E = mc^2 \end{equation} tail out}
\end{document}`);

    expect(firstImbalance(html)).toBeNull();

    const stripped = withoutMath(html);
    // The emphasis is re-opened on the far side of the break rather than left
    // hanging, and the equation is a sibling of the paragraphs, not inside one.
    expect(stripped).toContain('<p class="tex-p"><em>lead in </em></p>');
    expect(stripped).toContain('<p class="tex-p"><em> tail out</em></p>');
    expect(stripped.match(/<em>/g)).toHaveLength(2);
    expect(stripped.match(/<\/em>/g)).toHaveLength(2);
    expect(stripped).not.toContain('<p class="tex-p"><em>lead in </em><div');
  });

  // Pre-fix: an unknown command was deleted along with two brace groups, so
  // `\part`, `\chapter`, `\subparagraph`, `\textsc` and `\includegraphics` threw
  // away whole sentences with nothing in the preview to say text had gone.
  it('\\part / \\chapter / \\subparagraph / \\textsc / \\includegraphics are not silently deleted', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\part{Big Part}
\chapter{A Chapter}
\subparagraph{Run in}Text follows.
\textsc{Small Caps}
\includegraphics[width=3cm]{figs/plot.png}
\end{document}`);

    // \part: an <h1> numbered "Part I".
    expect(html).toContain('class="tex-heading tex-part"');
    expect(html).toContain('<span class="tex-secnum">Part I</span>Big Part');
    // \chapter: an <h1> that also takes over the section counter's prefix.
    expect(html).toContain('class="tex-heading tex-chapter"');
    expect(html).toContain('<span class="tex-secnum">1</span>A Chapter');
    // \subparagraph: a run-in bold heading folded back into the prose.
    expect(html).toContain('<strong>Run in.</strong>');
    expect(html).toContain('Text follows.');
    // \textsc: small caps, not a dropped argument.
    expect(html).toContain('<span style="font-variant: small-caps">Small Caps</span>');
    // \includegraphics: a placeholder naming the file, not a hole.
    expect(html).toContain('Image: figs/plot.png');
    expect(html).toContain('class="tex-graphic"');
  });

  it('a chapter renumbers the sections beneath it', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\chapter{One}
\section{First}
\subsection{Deeper}
\end{document}`);
    expect(html).toContain('<span class="tex-secnum">1.1</span>First');
    expect(html).toContain('<span class="tex-secnum">1.1.1</span>Deeper');
  });

  it('a genuinely unknown command names itself instead of vanishing', () => {
    const { html } = renderLatex(String.raw`\begin{document}
Before \frobnicate{the payload text} after.
\end{document}`);
    expect(html).toContain('the payload text');
    expect(html).toContain('Before');
    expect(html).toContain('after.');
  });

  // Pre-fix: \date{\today} rendered as nothing at all, leaving an unexplained
  // blank line under the title.
  it('\\date{\\today} renders a real date', () => {
    const { html } = renderLatex(String.raw`\title{A Paper}
\author{An Author}
\date{\today}
\begin{document}
\maketitle
\end{document}`);

    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const now = new Date();
    const expected = `${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;

    expect(html).toContain(`<div class="tex-date">${expected}</div>`);
    expect(html).not.toContain('today');
    expect(html).toContain('<h1 class="tex-title">A Paper</h1>');
    expect(html).toContain('<div class="tex-author">An Author</div>');
  });
});

// ---------------------------------------------------------------------------
// Footnotes, citations and the preamble
// ---------------------------------------------------------------------------

describe('footnotes and citations', () => {
  // Pre-fix: a table was expanded during the *final* placeholder substitution,
  // after the footnote list had already been serialized. A cell's \footnote
  // became a live anchor pointing at an <li> that was never emitted, and the
  // note itself was lost. Citations numbered out of document order for the same
  // reason.
  it('a \\footnote inside a tabular reaches the footnote list; citations number in document order', () => {
    const { html } = renderLatex(String.raw`\begin{document}
See \cite{alpha} first.

\begin{tabular}{ll}
cell\footnote{note from a table cell} & \cite{gamma} \\
\end{tabular}

Then \cite{beta} and \cite{alpha} again.

Body\footnote{note from the prose}.
\end{document}`);

    // The cell's note is in the list, and its anchor points at a real <li>.
    expect(html).toContain('<li id="fn-1">');
    expect(html).toContain('note from a table cell');
    expect(html).toContain('<a href="#fn-1" id="fnref-1">1</a>');
    // The prose note follows it.
    expect(html).toContain('<li id="fn-2">');
    expect(html).toContain('note from the prose');
    expect(html).toContain('<ol class="tex-footnotes">');
    expect(html.match(/<li id="fn-\d+">/g)).toHaveLength(2);

    // Citation numbers follow document order, the in-table one included, and a
    // repeated key keeps the number it was first given.
    const cites = html.match(/<sup class="tex-cite">\[[^\]]*\]<\/sup>/g) ?? [];
    expect(cites).toEqual([
      '<sup class="tex-cite">[1]</sup>', // alpha
      '<sup class="tex-cite">[2]</sup>', // gamma, inside the table
      '<sup class="tex-cite">[3]</sup>', // beta
      '<sup class="tex-cite">[1]</sup>' // alpha again
    ]);
  });

  it('a footnote nested inside a footnote does not steal its number', () => {
    const { html } = renderLatex(String.raw`\begin{document}
Text\footnote{outer \footnote{inner} note}.
\end{document}`);
    expect(html).toContain('<a href="#fn-1" id="fnref-1">1</a>');
    expect(html.match(/<li id="fn-\d+">/g)).toHaveLength(2);
    expect(html).toContain('<li id="fn-1">');
    expect(html).toContain('<li id="fn-2">');
  });
});

describe('preamble', () => {
  // Pre-fix: `docMatch[0] || expanded` treated an *empty* preamble as "no
  // preamble" and searched the whole body, promoting the first `\title{...}`
  // mentioned in the prose to the document's real title.
  it('an empty preamble does not scrape \\title out of body prose', () => {
    const { html } = renderLatex(String.raw`\begin{document}
The \title{Not A Title} command sets the document title.
\maketitle
\end{document}`);

    expect(html).not.toContain('Not A Title');
    expect(html).not.toContain('tex-title-block');
    expect(html).not.toContain('<h1');
    expect(html).toContain('command sets the document title.');
  });

  it('a real preamble title still renders', () => {
    const { html } = renderLatex(String.raw`\documentclass{article}
\title{The Real Title}
\begin{document}
\maketitle
\end{document}`);
    expect(html).toContain('<h1 class="tex-title">The Real Title</h1>');
  });
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

describe('performance', () => {
  // Pre-fix: `findMatchingBrace` rescanned forward from every opening brace, so
  // a run of unmatched `{` was quadratic - the reviewer measured 1485ms for
  // 40k braces, on the render path that runs on every keystroke. A prebuilt
  // brace table makes it linear.
  it('findMatchingBrace stays linear: 40k unmatched braces render well under 200ms', () => {
    const build = (n: number) => `\\begin{document}\n${'{'.repeat(n)}\n\\end{document}`;

    // Warm up the module (KaTeX import, JIT) on a small input first.
    renderLatex(build(500));

    // Best of three: the assertion is about complexity, not about winning a
    // scheduling lottery on a loaded machine.
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const source = build(40_000);
      const start = performance.now();
      renderLatex(source);
      best = Math.min(best, performance.now() - start);
    }

    expect(best).toBeLessThan(200);
  });

  it('doubling the brace count does not quadruple the time', () => {
    const build = (n: number) => `\\begin{document}\n${'{'.repeat(n)}\n\\end{document}`;
    renderLatex(build(500));

    const time = (n: number) => {
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const source = build(n);
        const start = performance.now();
        renderLatex(source);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };

    // Linear work plus a fixed floor; quadratic would be ~4x.
    expect(time(80_000)).toBeLessThan(Math.max(time(20_000), 1) * 4 + 40);
  });
});

// ---------------------------------------------------------------------------
// Output safety
// ---------------------------------------------------------------------------

describe('output safety', () => {
  it('a javascript: URL in \\href is blocked', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\href{javascript:alert(1)}{click me}
\end{document}`);

    expect(html).not.toContain('href="javascript:');
    expect(html).not.toMatch(/href\s*=\s*"[^"]*javascript/i);
    expect(html).toContain('class="tex-link-blocked"');
    // The link *text* is still shown - the target is what is refused.
    expect(html).toContain('click me');
  });

  it('a scheme obfuscated with control characters is still blocked', () => {
    const { html } = renderLatex('\\begin{document}\n\\href{java\tscript:alert(1)}{x}\n\\end{document}');
    expect(html).not.toMatch(/href\s*=\s*"[^"]*script:/i);
    expect(html).toContain('class="tex-link-blocked"');
  });

  it('safeUrl passes http/https/mailto and relative refs, refuses the rest', () => {
    expect(safeUrl('https://example.com/x')).toBe('https://example.com/x');
    expect(safeUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeUrl('example.com/x')).toBe('example.com/x');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('JaVaScRiPt:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,<script>')).toBeNull();
    expect(safeUrl('file:///etc/passwd')).toBeNull();
    expect(safeUrl('  ')).toBeNull();
  });

  it('a \\url with a blocked scheme is not clickable', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\url{javascript:alert(1)}
\end{document}`);
    expect(html).not.toContain('<a class="tex-link"');
    expect(html).toContain('tex-link-blocked');
  });

  it('angle brackets in body text are escaped', () => {
    const { html } = renderLatex(String.raw`\begin{document}
A <script>alert(1)</script> and an <img src=x onerror=alert(1)> in prose.
\end{document}`);

    expect(html).not.toContain('<script');
    expect(html).not.toContain('</script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('angle brackets inside a verbatim body and a section title are escaped', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\section{A <b>title</b>}
\begin{verbatim}
<script>alert(1)</script>
\end{verbatim}
\end{document}`);

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>title</b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A &lt;b&gt;title&lt;/b&gt;');
  });

  it('an image filename cannot break out of its title attribute', () => {
    const { html } = renderLatex(String.raw`\begin{document}
\includegraphics{x" onerror="alert(1)}
\end{document}`);
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain('&quot;');
  });
});
