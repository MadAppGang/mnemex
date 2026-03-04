#!/usr/bin/env bun
// Colored deployment mode diagrams for claudemem setup wizard
// btop-inspired: rounded corners, gauge bars, model panels, section dividers

const R = '\x1b[0m';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Foreground
const green = (s: string) => `\x1b[32m${s}${R}`;
const bgreen = (s: string) => `\x1b[92m${s}${R}`;
const bblue = (s: string) => `\x1b[94m${s}${R}`;
const cyan = (s: string) => `\x1b[36m${s}${R}`;
const yellow = (s: string) => `\x1b[33m${s}${R}`;
const byellow = (s: string) => `\x1b[93m${s}${R}`;
const bred = (s: string) => `\x1b[91m${s}${R}`;
const white = (s: string) => `\x1b[97m${s}${R}`;
const gray = (s: string) => `\x1b[90m${s}${R}`;
const bold = (s: string) => `\x1b[1m${s}${R}`;
const dim = (s: string) => `\x1b[2m${s}${R}`;
const magenta = (s: string) => `\x1b[35m${s}${R}`;

// Background
const bgGreen = (s: string) => `\x1b[42m\x1b[30m${s}${R}`;
const bgBlue = (s: string) => `\x1b[44m\x1b[97m${s}${R}`;
const bgModel = (s: string) => `\x1b[44m\x1b[97m\x1b[1m${s}${R}`;
const bgCloud = (s: string) => `\x1b[48;5;55m\x1b[97m\x1b[1m${s}${R}`;

// Pad string to width (accounting for ANSI)
const pad = (s: string, w: number) => {
  const vis = strip(s).length;
  return s + ' '.repeat(Math.max(0, w - vis));
};

// Latency coloring
const lat = (ms: number): string => {
  const s = `~${ms}ms`;
  if (ms <= 20) return bgreen(s);
  if (ms <= 200) return byellow(s);
  return bred(s);
};

// Step name (bold white)
const step = (s: string) => `\x1b[1m\x1b[97m${s}${R}`;

// Gauge bar: proportional to 500ms max, 10 chars wide
const gauge = (ms: number, maxMs = 500): string => {
  const barW = 10;
  const filled = Math.max(1, Math.round((ms / maxMs) * barW));
  const empty = barW - filled;
  const blockChars = '▏▎▍▌▋▊▉█';
  const idx = Math.min(Math.floor((ms / maxMs) * (blockChars.length - 1)), blockChars.length - 1);
  const ch = blockChars[idx];
  let color: (s: string) => string;
  if (ms <= 20) color = bgreen;
  else if (ms <= 200) color = byellow;
  else color = bred;
  if (filled <= 1) return color(ch) + dim('░'.repeat(empty));
  return color('█'.repeat(filled - 1) + ch) + dim('░'.repeat(empty));
};

// ── Shared box helpers ──
// All modes use W=54 for consistent look
const W = 54;

const rTop = (title: string) => {
  const label = ` ${title} `;
  const fill = W - label.length + 1;
  console.log(`  ╭─${label}${'─'.repeat(Math.max(0, fill))}╮`);
};
const rBot = (title = '') => {
  if (title) {
    const vis = strip(title).length;
    const fill = W - vis - 1;
    console.log(`  ╰─ ${title} ${'─'.repeat(Math.max(0, fill))}╯`);
  } else {
    console.log(`  ╰${'─'.repeat(W + 2)}╯`);
  }
};
const rDiv = (title = '') => {
  if (title) {
    const label = ` ${title} `;
    const fill = W - label.length + 1;
    console.log(`  ├─${label}${'─'.repeat(Math.max(0, fill))}┤`);
  } else {
    console.log(`  ├${'─'.repeat(W + 2)}┤`);
  }
};
const o = (s: string) => console.log(`  │ ${pad(s, W)} │`);

// Timing-aligned output: left content padded, timing right-aligned in 7-char column
const oT = (left: string, ms: number) => {
  const t = lat(ms);
  const tv = strip(t).length;
  o(pad(left, W - 7) + ' '.repeat(7 - tv) + t);
};

// Location tags for multi-location modes
const tagLocal = green('LOCAL');
const tagCloud = bblue('CLOUD');
const tagWire = yellow('WIRE');

// Latency table row: step  latency  gauge  note
const latRow = (name: string, ms: number, note: string, maxMs = 500) => {
  o(`${pad(name, 9)}${pad(lat(ms), 9)}${gauge(ms, maxMs)}  ${note}`);
};

// Latency table row with location: step  where  latency  gauge  note
const latRowLoc = (name: string, where: string, ms: number, note: string, maxMs = 800) => {
  o(`${pad(name, 9)}${pad(where, 7)}${pad(lat(ms), 9)}${gauge(ms, maxMs)}  ${note}`);
};

// Network transition line
const netLine = (label: string, ms: number) => {
  const latStr = lat(ms);
  const bar = gray('┄'.repeat(W - strip(label).length - strip(latStr).length - 4));
  o(`${bar} ${label} ${latStr}`);
};

// Model gauge panel (Kimi-style) — consistent 13-char box
// fill must be 9 chars, labels padded to 9 internally
const modelPanel = (
  fill: string, fillColor: (s: string) => string,
  stepName: string, desc: string, ms: number,
  label1: string, modelNote: string,
  label2: string, modelReq: string
) => {
  o(`${gray('┌───────────┐')}`);
  oT(`${gray('│')} ${fillColor(fill)} ${gray('│')}  ${step(stepName)}  ${gray(desc)}`, ms);
  o(`${gray('│')} ${pad(label1, 9)} ${gray('│')}  ${gray(modelNote)}`);
  o(`${gray('│')} ${pad(label2, 9)} ${gray('│')}  ${gray(modelReq)}`);
  o(`${gray('└─────┬─────┘')}`);
};

// ════════════════════════════════════════════════════════════
// MODE 1: LOCAL
// ════════════════════════════════════════════════════════════
function mode1() {
  console.log();
  console.log(`  ${bold('MODE 1: LOCAL')}  ${gray('everything on your machine')}`);
  console.log();

  rTop('Pipeline Flow');
  o('');
  o(gray('source files'));
  o(`  ${cyan('│')}`);
  oT(`  ${cyan('▼')}  ${step('[parse]')}  ${gray('tree-sitter')}`, 5);
  o(`  ${cyan('│')}  ${gray('AST → text chunks')}`);
  o(`  ${cyan('▼')}`);

  modelPanel('▓▓▓▓░░░░░', yellow, '[embed]', 'auto-detected', 30,
    'embed', 'nomic-embed-text or equiv',
    'model', 'GPU required');
  o(`  ${cyan('│')}  ${gray('vectors')}`);
  o(`  ${cyan('▼')}`);
  oT(`  ${step('[index]')}   ${gray('LanceDB local')}`, 5);
  o(`  ${cyan('│')}  ${gray('vector index')}`);
  o(`  ${cyan('▼')}`);
  oT(`  ${step('[search]')}  ${gray('vector + BM25')}`, 15);
  o(`  ${cyan('│')}  ${gray('candidates')}`);
  o(`  ${cyan('▼')}`);

  modelPanel('▓▓▓▓▓▓▓▓▓', bred, '[rerank]', 'auto-detected', 100,
    'LLM', 'llama3/codellama or equiv',
    'model', 'GPU required');
  o(`  ${cyan('│')}  ${gray('scored results')}`);
  o(`  ${cyan('▼')}`);
  oT(`  ${step('[enrich]')}  ${gray('code summaries')}`, 500);
  o(`  ${cyan('│')}  ${gray('optional')}        ${gray('(same LLM)')}`);
  o(`  ${cyan('▼')}`);
  o(bgreen('▓▓▓ RESULTS ▓▓▓'));
  o('');

  rDiv();
  o(`${green('●')} Runtime   ${white('Ollama / LM Studio')}`);
  o(`${green('●')} Privacy   ${bgreen(bold('AIR-GAPPED'))} ${gray('zero bytes leave machine')}`);
  o(`${green('●')} Requires  ${white('Apple Silicon / NVIDIA GPU')}`);
  o(`${green('●')} Memory    ${byellow('≥16 GB RAM')}`);

  rDiv('LATENCY');
  o(gray('Step     Latency  Gauge      Note'));
  o(gray('──────── ──────── ────────── ───────────────────'));
  latRow('parse', 5, 'tree-sitter (CPU)');
  latRow('embed', 30, 'embed model (GPU)');
  latRow('index', 5, 'LanceDB (disk)');
  latRow('search', 15, 'vector+BM25 (CPU)');
  latRow('rerank', 100, 'LLM scoring (GPU)');
  latRow('enrich', 500, 'LLM summary (opt)');
  o(gray('──────────────────────────────────────────────'));
  o(`${bold('search')}   ${pad(lat(130), 9)}search + rerank`);
  o(`${bold('full')}     ${pad(lat(630), 9)}all steps end-to-end`);
  o(gray('approximate — depends on hardware'));

  rBot('Ollama / LM Studio');
  console.log();
}

// ════════════════════════════════════════════════════════════
// MODE 2: TEAM
// ════════════════════════════════════════════════════════════
function mode2() {
  console.log();
  console.log(`  ${bold('MODE 2: TEAM')}  ${gray('code stays local, search in cloud')}`);
  console.log();

  rTop('Pipeline Flow');
  o('');
  o(gray('source files'));
  o(`  ${cyan('│')}`);
  oT(`  ${cyan('▼')}  ${step('[parse]')}  ${gray('tree-sitter')}`, 5);
  o(`  ${cyan('│')}  ${gray('AST → text chunks')}`);
  o(`  ${cyan('▼')}`);

  modelPanel('▓▓▓▓░░░░░', yellow, '[embed]', 'auto-detected', 30,
    'embed', 'nomic-embed-text or equiv',
    'model', 'local GPU');
  o(`  ${cyan('│')}  ${gray('vectors 768-dim')}`);

  // Network transition: local → cloud
  o('');
  oT(`  ${cyan('═══════')} ${bgGreen(' vectors → cloud ')} ${cyan('═══════')}`, 80);
  o(`  ${gray('~3KB per chunk, anonymous, no source code')}`);
  o('');

  o(`  ${cyan('│')}`);
  oT(`  ${cyan('▼')}  ${step('[index]')}   ${gray('pgvector (shared)')}`, 5);
  o(`  ${cyan('│')}  ${gray('candidates')}`);
  o(`  ${cyan('▼')}`);
  oT(`  ${step('[search]')}  ${gray('vector + BM25')}`, 15);
  o(`  ${cyan('│')}  ${gray('top-K results')}`);
  o(`  ${cyan('▼')}`);

  // Cloud rerank model panel
  o(`${gray('┌───────────┐')}`);
  oT(`${gray('│')} ${magenta('▓▓▓▓▓▓▓▓▓')} ${gray('│')}  ${step('[rerank]')}  ${gray('cloud')}`, 80);
  o(`${gray('│')} ${pad(magenta('Claude'), 9)} ${gray('│')}  ${gray('Claude Sonnet ~175B')}`);
  o(`${gray('│')} ${pad(magenta('Sonnet'), 9)} ${gray('│')}  ${gray('H100 server-side')}`);
  o(`${gray('└─────┬─────┘')}`);
  o(`  ${cyan('│')}  ${gray('scored results')}`);

  // Network transition: cloud → local
  o('');
  oT(`  ${cyan('═══════')} ${bgBlue(' results ← cloud ')} ${cyan('═══════')}`, 80);
  o(`  ${gray('paths + scores, ~1KB')}`);
  o('');

  o(`  ${cyan('│')}`);
  o(`  ${cyan('▼')}`);
  oT(`  ${step('[enrich]')}  ${gray('code summaries')}`, 500);
  o(`  ${cyan('│')}  ${gray('optional, local LLM (same as rerank)')}`);
  o(`  ${cyan('▼')}`);
  o(bgreen('▓▓▓ RESULTS ▓▓▓'));
  o('');

  rDiv();
  o(`${green('●')} Runtime   ${white('Ollama local + cloud server')}`);
  o(`${green('●')} Privacy   ${bgreen(bold('CODE NEVER LEAVES'))} ${gray('only vectors')}`);
  o(`${green('●')} Storage   ${white('PostgreSQL + pgvector (cloud)')}`);
  o(`${green('●')} Requires  ${white('Apple Silicon / NVIDIA GPU')}`);
  o(`${green('●')} Memory    ${byellow('≥5 GB VRAM')}`);

  rDiv('LATENCY');
  o(gray('Step     Where  Latency  Gauge      Note'));
  o(gray('──────── ────── ──────── ────────── ───────────────'));
  latRowLoc('parse', tagLocal, 5, 'tree-sitter');
  latRowLoc('embed', tagLocal, 30, 'embed (GPU)');
  latRowLoc('net →', tagWire, 80, '~3KB vectors');
  latRowLoc('index', tagCloud, 5, 'pgvector');
  latRowLoc('search', tagCloud, 30, 'vector+BM25');
  latRowLoc('rerank', tagCloud, 80, 'Claude ~175B');
  latRowLoc('net ←', tagWire, 80, '~1KB results');
  latRowLoc('enrich', tagLocal, 500, 'local LLM');
  o(gray('──────────────────────────────────────────────'));
  o(`${bold('search')}   ${pad(lat(240), 9)}net + cloud (no enrich)`);
  o(`${bold('full')}     ${pad(lat(810), 9)}all steps end-to-end`);
  o(gray('approximate — depends on network'));

  rBot('Ollama + cloud server');
  console.log();
}

// ════════════════════════════════════════════════════════════
// MODE 3: CLOUD
// ════════════════════════════════════════════════════════════
function mode3() {
  console.log();
  console.log(`  ${bold('MODE 3: CLOUD')}  ${gray('everything runs server-side')}`);
  console.log();

  rTop('Pipeline Flow');
  o('');
  o(gray('source files'));

  // Network transition: upload
  o('');
  oT(`  ${cyan('═══════')} ${bgBlue(' source → cloud ')} ${cyan('════════')}`, 150);
  o(`  ${gray('~50KB-5MB upload')}`);
  o('');

  o(`  ${cyan('│')}`);
  oT(`  ${cyan('▼')}  ${step('[parse]')}  ${gray('tree-sitter')}`, 5);
  o(`  ${cyan('│')}  ${gray('AST → text chunks')}`);
  o(`  ${cyan('▼')}`);

  // Cloud embed model panel
  o(`${gray('┌───────────┐')}`);
  oT(`${gray('│')} ${magenta('▓▓▓▓░░░░░')} ${gray('│')}  ${step('[embed]')}  ${gray('cloud API')}`, 20);
  o(`${gray('│')} ${pad(magenta('OpenAI'), 9)} ${gray('│')}  ${gray('text-embedding-3-large')}`);
  o(`${gray('│')} ${pad(magenta('cluster'), 9)} ${gray('│')}  ${gray('~1-2B params, 3072-dim')}`);
  o(`${gray('└─────┬─────┘')}`);
  o(`  ${cyan('│')}  ${gray('vectors')}`);
  o(`  ${cyan('▼')}`);
  oT(`  ${step('[index]')}   ${gray('pgvector')}`, 5);
  o(`  ${cyan('│')}  ${gray('candidates')}`);
  o(`  ${cyan('▼')}`);
  oT(`  ${step('[search]')}  ${gray('vector + BM25')}`, 30);
  o(`  ${cyan('│')}  ${gray('top-K results')}`);
  o(`  ${cyan('▼')}`);

  // Cloud rerank model panel
  o(`${gray('┌───────────┐')}`);
  oT(`${gray('│')} ${magenta('▓▓▓▓▓▓▓▓▓')} ${gray('│')}  ${step('[rerank]')}  ${gray('cloud')}`, 80);
  o(`${gray('│')} ${pad(magenta('Claude'), 9)} ${gray('│')}  ${gray('Claude Sonnet ~175B')}`);
  o(`${gray('│')} ${pad(magenta('Sonnet'), 9)} ${gray('│')}  ${gray('Anthropic H100 cluster')}`);
  o(`${gray('└─────┬─────┘')}`);
  o(`  ${cyan('│')}  ${gray('scored results')}`);
  o(`  ${cyan('▼')}`);
  oT(`  ${step('[enrich]')}  ${gray('code summaries')}`, 200);
  o(`  ${cyan('│')}  ${gray('Claude Sonnet (shared)')}`);
  o(`  ${cyan('▼')}`);

  // Network transition: download
  o('');
  oT(`  ${cyan('═══════')} ${bgBlue(' results ← cloud ')} ${cyan('═══════')}`, 50);
  o(`  ${gray('~1KB download')}`);
  o('');

  o(bgreen('▓▓▓ RESULTS ▓▓▓'));
  o('');

  rDiv();
  o(`${bblue('●')} Runtime   ${white('Cloud server (mem.madappgang.com)')}`);
  o(`${bred('●')} Privacy   ${bred('Source code uploaded to cloud')}`);
  o(`${bblue('●')} Storage   ${white('PostgreSQL + pgvector (cloud)')}`);
  o(`${bblue('●')} Requires  ${bgreen('API key only — no GPU, no Ollama')}`);
  o(`${bblue('●')} Memory    ${bgreen('no local requirements')}`);

  rDiv('LATENCY');
  o(gray('Step     Where  Latency  Gauge      Note'));
  o(gray('──────── ────── ──────── ────────── ───────────────'));
  latRowLoc('net →', tagWire, 150, '~50KB-5MB up');
  latRowLoc('parse', tagCloud, 5, 'tree-sitter');
  latRowLoc('embed', tagCloud, 20, 'embed-3-lg');
  latRowLoc('index', tagCloud, 5, 'pgvector');
  latRowLoc('search', tagCloud, 30, 'vector+BM25');
  latRowLoc('rerank', tagCloud, 80, 'Claude ~175B');
  latRowLoc('enrich', tagCloud, 200, 'Claude ~175B');
  latRowLoc('net ←', tagWire, 50, '~1KB results');
  o(gray('──────────────────────────────────────────────'));
  o(`${bold('search')}   ${pad(lat(310), 9)}upload + cloud (no enrich)`);
  o(`${bold('full')}     ${pad(lat(540), 9)}all steps end-to-end`);
  o(gray('approximate — depends on file size'));

  rBot('cloud server');
  console.log();
}

// ════════════════════════════════════════════════════════════
// COMPARISON TABLE
// ════════════════════════════════════════════════════════════
function comparison() {
  // Column layout: label(14) + val1(13) + val2(13) + val3(14) = 54
  const c = (label: string, v1: string, v2: string, v3: string) =>
    o(`${pad(label, 14)}${pad(v1, 13)}${pad(v2, 13)}${v3}`);
  const sep = () => o(gray('─'.repeat(W)));

  console.log();
  rTop('COMPARISON');
  o(`${pad('', 14)}${pad(bgGreen('Local'), 13)}${pad(bgGreen('Team'), 13)}${bgBlue('Cloud')}`);
  sep();
  c('Embed model', byellow('auto-detect'), byellow('auto-detect'), magenta('embed-3-lg'));
  c('Embed where', green('local GPU'), green('local GPU'), bblue('cloud API'));
  sep();
  c('Rerank model', byellow('auto-detect'), magenta('Claude'), magenta('Claude'));
  c('Rerank where', green('local GPU'), bblue('H100 cloud'), bblue('H100 cloud'));
  sep();
  c('Enrich model', byellow('same LLM'), byellow('same LLM'), magenta('Claude'));
  c('Enrich where', green('local GPU'), green('local GPU'), bblue('H100 cloud'));
  sep();
  c('GPU needed', byellow('~5 GB'), byellow('~5 GB'), bgreen('no'));
  c('Code leaves?', bgreen('never'), bgreen('never'), bred('uploaded'));
  c('Search', lat(130), lat(240), lat(310));
  c('Offline?', bgreen('yes'), bred('no'), bred('no'));
  sep();
  rBot();
  console.log();
}

// ════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════

export { mode1, mode2, mode3, comparison };

// Capture console.log output as line array
const captureLines = (fn: () => void): string[] => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  fn();
  console.log = orig;
  return lines;
};

/** Interactive mode selector — sidebar on left, diagram on right. */
export async function selectMode(): Promise<'local' | 'shared' | 'full-cloud'> {
  const modes = ['local', 'shared', 'full-cloud'] as const;
  const renderers = [mode1, mode2, mode3];
  let selected = 0;

  const SB_W = 22; // sidebar total visible width
  const SB_IN = SB_W - 2; // inner content width

  const sbi = (s: string) => `│${pad(s, SB_IN)}│`;

  const buildSidebar = (sel: number): string[] => {
    const items = [
      { n: '1', label: 'Local',  desc: 'your machine' },
      { n: '2', label: 'Team',   desc: 'code is local' },
      { n: '3', label: 'Cloud',  desc: 'server-side' },
    ];
    const sb: string[] = [];
    sb.push(`╭${'─'.repeat(SB_IN)}╮`);
    sb.push(sbi(''));
    sb.push(sbi(bold(' DEPLOYMENT MODE')));
    sb.push(sbi(''));

    for (let i = 0; i < items.length; i++) {
      const { n, label, desc } = items[i];
      const isSel = i === sel;
      const marker = isSel ? bgreen('▸') : ' ';
      const title = isSel ? white(bold(`[${n}] ${label}`)) : gray(`[${n}] ${label}`);
      const sub = isSel ? green(desc) : dim(desc);
      sb.push(sbi(` ${marker} ${title}`));
      sb.push(sbi(`    ${sub}`));
      if (i < 2) sb.push(sbi(''));
    }

    sb.push(sbi(''));
    sb.push(`├${'─'.repeat(SB_IN)}┤`);
    sb.push(sbi(` ${gray('↑↓ 1/2/3')}  ${gray('select')}`));
    sb.push(sbi(` ${gray('Enter')}    ${gray('confirm')}`));
    sb.push(sbi(` ${gray('q')}        ${gray('quit')}`));
    sb.push(`╰${'─'.repeat(SB_IN)}╯`);
    return sb;
  };

  const render = () => {
    process.stdout.write('\x1b[2J\x1b[H');

    const dLines = captureLines(() => renderers[selected]());
    const sbLines = buildSidebar(selected);

    // Header
    console.log();
    console.log(`${gray('┌─')} ${bold('claudemem')} ${gray('─ Setup ─ Step 1 ─ Choose Deployment Mode ─┐')}`);

    // Merge sidebar + diagram side by side
    const maxLen = Math.max(sbLines.length, dLines.length);
    const sbBlank = ' '.repeat(SB_W);
    for (let i = 0; i < maxLen; i++) {
      const left = i < sbLines.length ? sbLines[i] : sbBlank;
      const right = i < dLines.length ? dLines[i] : '';
      console.log(`${left}${right}`);
    }
  };

  return new Promise((resolve) => {
    const { stdin } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    render();

    const onData = (data: string) => {
      if (data === '1') { selected = 0; render(); }
      else if (data === '2') { selected = 1; render(); }
      else if (data === '3') { selected = 2; render(); }
      else if (data === '\x1b[C' || data === '\x1b[B' || data === 'j' || data === 'l') {
        selected = Math.min(selected + 1, 2); render();
      }
      else if (data === '\x1b[D' || data === '\x1b[A' || data === 'k' || data === 'h') {
        selected = Math.max(selected - 1, 0); render();
      }
      else if (data === '\r' || data === '\n') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write('\x1b[2J\x1b[H');
        resolve(modes[selected]);
      }
      else if (data === 'q' || data === '\x03') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write('\x1b[2J\x1b[H');
        process.exit(0);
      }
    };

    stdin.on('data', onData);
  });
}

// ════════════════════════════════════════════════════════════
// MAIN (standalone execution)
// ════════════════════════════════════════════════════════════
if (import.meta.main) {
  console.log();
  console.log(bold('  ╔══════════════════════════════════════════════════════════╗'));
  console.log(bold('  ║          CLAUDEMEM DEPLOYMENT MODE DIAGRAMS             ║'));
  console.log(bold('  ╚══════════════════════════════════════════════════════════╝'));

  mode1();
  mode2();
  mode3();
  comparison();
}
