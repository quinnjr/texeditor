// Shared application state (Svelte 5 runes).
// Mutate fields on these objects; never reassign the objects themselves.
// OWNER: shell agent.

const THEME_KEY = 'texviewer.theme';
const SPLIT_KEY = 'texviewer.splitPct';
const MODE_KEY = 'texviewer.mode';

export const SAMPLE_TEX = `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{booktabs}

\\title{Notes on Harmonic Motion}
\\author{A. Physicist}
\\date{\\today}

\\begin{document}

\\maketitle

\\section{Introduction}
This document collects a few standard results used when analyzing a
simple harmonic oscillator, along with a short table comparing it
against the damped case.

\\section{Assumptions}
We work under the following simplifying assumptions:

\\begin{itemize}
  \\item The mass $m$ is constant and point-like.
  \\item The restoring force is linear in the displacement $x$.
  \\item Friction and air resistance are neglected.
\\end{itemize}

\\section{Equation of Motion}
Newton's second law gives the governing differential equation

\\begin{equation}
  m \\frac{d^2x}{dt^2} + kx = 0
\\end{equation}

whose general solution, with angular frequency $\\omega = \\sqrt{k/m}$,
can be written as

\\begin{align}
  x(t) &= A \\cos(\\omega t) + B \\sin(\\omega t) \\\\
       &= C \\cos(\\omega t - \\varphi)
\\end{align}

\\section{Comparison of Regimes}

\\begin{tabular}{lcc}
  \\toprule
  Regime      & Damping $\\zeta$ & Behavior \\\\
  \\midrule
  Undamped    & $0$             & Sustained oscillation \\\\
  Underdamped & $0 < \\zeta < 1$ & Decaying oscillation \\\\
  Critical    & $\\zeta = 1$     & Fastest non-oscillatory decay \\\\
  Overdamped  & $\\zeta > 1$     & Slow non-oscillatory decay \\\\
  \\bottomrule
\\end{tabular}

\\end{document}
`;

export const doc = $state({
  source: SAMPLE_TEX,
  path: null as string | null,
  dirty: false
});

export const ui = $state({
  mode: 'live' as 'live' | 'pdf',
  theme: 'dark' as 'light' | 'dark',
  splitPct: 50,
  status: 'Ready'
});

export const build = $state({
  compiling: false,
  log: '',
  pdfUrl: null as string | null,
  error: null as string | null
});

/** Toggle the `.dark` class on <html> and persist the choice. */
export function setTheme(theme: 'light' | 'dark') {
  ui.theme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // localStorage unavailable (private mode, etc.) — theme just won't persist.
  }
}

/** Persist the current split percentage. Call from an effect that watches ui.splitPct. */
export function persistSplitPct(pct: number) {
  try {
    localStorage.setItem(SPLIT_KEY, String(pct));
  } catch {
    // ignore
  }
}

/** Persist the current view mode. Call from an effect that watches ui.mode. */
export function persistMode(mode: 'live' | 'pdf') {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // ignore
  }
}

/** Restore theme/splitPct/mode from localStorage. Call once on boot. */
export function loadPrefs() {
  try {
    const theme = localStorage.getItem(THEME_KEY);
    if (theme === 'light' || theme === 'dark') {
      ui.theme = theme;
    }
  } catch {
    // ignore
  }

  try {
    const rawSplit = localStorage.getItem(SPLIT_KEY);
    if (rawSplit !== null) {
      const n = Number(rawSplit);
      if (Number.isFinite(n) && n >= 15 && n <= 85) {
        ui.splitPct = n;
      }
    }
  } catch {
    // ignore
  }

  try {
    const mode = localStorage.getItem(MODE_KEY);
    if (mode === 'live' || mode === 'pdf') {
      ui.mode = mode;
    }
  } catch {
    // ignore
  }

  document.documentElement.classList.toggle('dark', ui.theme === 'dark');
}
