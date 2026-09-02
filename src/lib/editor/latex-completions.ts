// Autocomplete source for LaTeX: common commands plus \begin{env} snippets
// that also insert the matching \end{env}. OWNER: editor agent.

import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';

interface EnvSpec {
  name: string;
  /** Extra template lines placed between \begin and \end, using ${} snippet fields. */
  body?: string;
}

const ENVIRONMENTS: EnvSpec[] = [
  { name: 'document' },
  { name: 'equation' },
  { name: 'equation*' },
  { name: 'align' },
  { name: 'align*' },
  { name: 'itemize', body: '\\item ${}' },
  { name: 'enumerate', body: '\\item ${}' },
  { name: 'description', body: '\\item[${}] ' },
  { name: 'figure', body: '\\centering\n\\includegraphics{${}}\n\\caption{${}}' },
  { name: 'table' },
  { name: 'tabular' },
  { name: 'matrix' },
  { name: 'pmatrix' },
  { name: 'bmatrix' },
  { name: 'center' },
  { name: 'quote' },
  { name: 'verbatim' },
  { name: 'abstract' },
  { name: 'theorem' },
  { name: 'proof' }
];

const envSnippets: Completion[] = ENVIRONMENTS.map(({ name, body }) =>
  snippetCompletion(
    body
      ? `\\begin{${name}}\n${body}\n\\end{${name}}`
      : `\\begin{${name}}\n\${}\n\\end{${name}}`,
    { label: `\\begin{${name}}`, detail: 'environment', type: 'keyword' }
  )
);

/** Plain \command completions, most with a brace-argument snippet where useful. */
const COMMANDS: Completion[] = [
  snippetCompletion('\\documentclass{${article}}', { label: '\\documentclass', type: 'keyword' }),
  snippetCompletion('\\usepackage{${}}', { label: '\\usepackage', type: 'keyword' }),
  snippetCompletion('\\usepackage[${}]{${}}', { label: '\\usepackage[options]', type: 'keyword' }),
  snippetCompletion('\\title{${}}', { label: '\\title', type: 'keyword' }),
  snippetCompletion('\\author{${}}', { label: '\\author', type: 'keyword' }),
  snippetCompletion('\\date{${}}', { label: '\\date', type: 'keyword' }),
  { label: '\\maketitle', type: 'keyword' },
  { label: '\\tableofcontents', type: 'keyword' },
  snippetCompletion('\\part{${}}', { label: '\\part', type: 'keyword' }),
  snippetCompletion('\\chapter{${}}', { label: '\\chapter', type: 'keyword' }),
  snippetCompletion('\\section{${}}', { label: '\\section', type: 'keyword' }),
  snippetCompletion('\\subsection{${}}', { label: '\\subsection', type: 'keyword' }),
  snippetCompletion('\\subsubsection{${}}', { label: '\\subsubsection', type: 'keyword' }),
  snippetCompletion('\\paragraph{${}}', { label: '\\paragraph', type: 'keyword' }),
  snippetCompletion('\\label{${}}', { label: '\\label', type: 'keyword' }),
  snippetCompletion('\\ref{${}}', { label: '\\ref', type: 'keyword' }),
  snippetCompletion('\\eqref{${}}', { label: '\\eqref', type: 'keyword' }),
  snippetCompletion('\\cite{${}}', { label: '\\cite', type: 'keyword' }),
  snippetCompletion('\\footnote{${}}', { label: '\\footnote', type: 'keyword' }),
  snippetCompletion('\\textbf{${}}', { label: '\\textbf', type: 'keyword' }),
  snippetCompletion('\\textit{${}}', { label: '\\textit', type: 'keyword' }),
  snippetCompletion('\\texttt{${}}', { label: '\\texttt', type: 'keyword' }),
  snippetCompletion('\\emph{${}}', { label: '\\emph', type: 'keyword' }),
  snippetCompletion('\\underline{${}}', { label: '\\underline', type: 'keyword' }),
  snippetCompletion('\\frac{${}}{${}}', { label: '\\frac', type: 'keyword' }),
  snippetCompletion('\\sqrt{${}}', { label: '\\sqrt', type: 'keyword' }),
  snippetCompletion('\\sum_{${}}^{${}}', { label: '\\sum', type: 'keyword' }),
  snippetCompletion('\\int_{${}}^{${}}', { label: '\\int', type: 'keyword' }),
  snippetCompletion('\\lim_{${}}', { label: '\\lim', type: 'keyword' }),
  { label: '\\alpha', type: 'constant' },
  { label: '\\beta', type: 'constant' },
  { label: '\\gamma', type: 'constant' },
  { label: '\\delta', type: 'constant' },
  { label: '\\epsilon', type: 'constant' },
  { label: '\\theta', type: 'constant' },
  { label: '\\lambda', type: 'constant' },
  { label: '\\mu', type: 'constant' },
  { label: '\\pi', type: 'constant' },
  { label: '\\sigma', type: 'constant' },
  { label: '\\phi', type: 'constant' },
  { label: '\\omega', type: 'constant' },
  { label: '\\infty', type: 'constant' },
  { label: '\\partial', type: 'constant' },
  { label: '\\nabla', type: 'constant' },
  { label: '\\times', type: 'constant' },
  { label: '\\cdot', type: 'constant' },
  { label: '\\leq', type: 'constant' },
  { label: '\\geq', type: 'constant' },
  { label: '\\neq', type: 'constant' },
  { label: '\\approx', type: 'constant' },
  { label: '\\rightarrow', type: 'constant' },
  { label: '\\Rightarrow', type: 'constant' },
  snippetCompletion('\\includegraphics[${width=\\linewidth}]{${}}', {
    label: '\\includegraphics',
    type: 'keyword'
  }),
  snippetCompletion('\\newcommand{\\${}}{${}}', { label: '\\newcommand', type: 'keyword' }),
  { label: '\\item', type: 'keyword' },
  { label: '\\left', type: 'keyword' },
  { label: '\\right', type: 'keyword' },
  ...envSnippets
];

/** LaTeX completion source: triggers on a partial \command, or an env name inside \begin{ / \end{. */
export function latexCompletions(context: CompletionContext): CompletionResult | null {
  // Inside \begin{...| or \end{...| , offer just environment names.
  const envWord = context.matchBefore(/\\(begin|end)\{[a-zA-Z*]*/);
  if (envWord) {
    const braceIndex = envWord.text.indexOf('{');
    const from = envWord.from + braceIndex + 1;
    return {
      from,
      options: ENVIRONMENTS.map(({ name }) => ({ label: name, type: 'type' })),
      validFor: /^[a-zA-Z*]*$/
    };
  }

  const word = context.matchBefore(/\\[a-zA-Z]*/);
  if (!word) return null;
  if (word.from === word.to && !context.explicit) return null;

  return {
    from: word.from,
    options: COMMANDS,
    validFor: /^\\[a-zA-Z]*$/
  };
}
