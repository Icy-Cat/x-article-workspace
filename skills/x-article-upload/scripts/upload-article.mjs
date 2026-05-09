#!/usr/bin/env node
/**
 * upload-article.mjs
 *
 * End-to-end: read a local .md file → convert to HTML payload →
 * spawn playwright MCP via npx → navigate X article editor → inject content.
 *
 * Usage:
 *   node upload-article.mjs <file.md> [--token <TOKEN>]
 *
 * Token resolution order:
 *   1. --token CLI arg
 *   2. <skill-dir>/.env  PLAYWRIGHT_MCP_EXTENSION_TOKEN=...
 *   3. PLAYWRIGHT_MCP_EXTENSION_TOKEN environment variable
 *   4. MCP config files (~/.cursor/mcp.json, ~/.claude.json, etc.)
 *   5. Browser LevelDB scan (Chrome / Edge)
 *
 * If no token is found, the script exits with a clear error message.
 *
 * Optional .env settings:
 *   X_ARTICLE_AUTO_APPLY_COVER=true|false
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { homedir, platform } from 'node:os';
import { env, argv, exit } from 'node:process';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const TOKEN_ENV     = 'PLAYWRIGHT_MCP_EXTENSION_TOKEN';
const EXTENSION_ID  = 'mmlmfjhmonkocbjadbfplnigmagldckm';
const TOKEN_RE      = /([A-Za-z0-9_-]{40,50})/;
const SKILL_DIR     = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOT_ENV_PATH  = join(SKILL_DIR, '.env');
const WORKSPACE_DIR = resolve(SKILL_DIR, '..', '..');
const SHARED_TEMPLATE_PATH = join(WORKSPACE_DIR, 'packages', 'publish', 'src', 'template.ts');
// Resolve jiti from any of the workspace's pnpm-managed locations.
// (Previously hard-coded to apps/obsidian/node_modules; that package was
// dropped after the standalone plugin took over via vendored sync.)
const JITI_PATH = (() => {
  const candidates = [
    join(WORKSPACE_DIR, 'node_modules', 'jiti'),
    join(WORKSPACE_DIR, 'packages', 'publish', 'node_modules', 'jiti'),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  // pnpm flattens deps under .pnpm/<pkg>@<ver>/node_modules/<pkg>
  try {
    const pnpmDir = join(WORKSPACE_DIR, 'node_modules', '.pnpm');
    if (existsSync(pnpmDir)) {
      const dirs = readdirSync(pnpmDir).filter((d) => d.startsWith('jiti@'));
      if (dirs.length) return join(pnpmDir, dirs[0], 'node_modules', 'jiti');
    }
  } catch { /* ignore */ }
  return candidates[0]; // fall through with a useful path for the error message
})();

const MCP_INIT_TIMEOUT_MS     = 10_000;
const MCP_CALL_TIMEOUT_MS     = 10_000;
const MCP_EVALUATE_TIMEOUT_MS = 180_000;
const IMAGE_FETCH_CONCURRENCY = 4;
const DEFAULT_AUTO_APPLY_COVER = true;
let sharedBrowserPublishBuilder = null;

// ─────────────────────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────────────────────
const args = argv.slice(2);
const filePath = args.find(a => !a.startsWith('-') && !looksLikeFlagValue(a));
if (!filePath) {
  console.error('Usage: node upload-article.mjs <file.md> [--mode=api|menu] [--token <TOKEN>]');
  exit(1);
}
const absFilePath = resolve(filePath);
if (!existsSync(absFilePath)) {
  console.error(`File not found: ${absFilePath}`);
  exit(1);
}

const cliTokenIdx = args.indexOf('--token');
const cliToken    = cliTokenIdx !== -1 ? args[cliTokenIdx + 1] : null;

// --mode=api (default) | --mode=menu
const modeArg = args.find(a => a.startsWith('--mode='));
const MODE = modeArg ? modeArg.slice('--mode='.length).trim() : 'api';
if (MODE !== 'api' && MODE !== 'menu') {
  console.error(`Unknown --mode value: ${MODE}. Use 'api' or 'menu'.`);
  exit(1);
}

// Helper: positional file arg should not be the value following --token
function looksLikeFlagValue(a) {
  const idx = args.indexOf(a);
  return idx > 0 && args[idx - 1] === '--token';
}

// ═════════════════════════════════════════════════════════════════════════════
// StdioMcpClient — JSON-RPC over stdio (must be defined before main() is called)
// ═════════════════════════════════════════════════════════════════════════════

class StdioMcpClient {
  #proc;
  #nextId  = 1;
  #pending = new Map();
  #buffer  = '';
  #closed  = false;
  #exitCode = null;
  #spawnError = null;

  constructor(proc) { this.#proc = proc; }

  static async connect(token) {
    // On Windows, .cmd scripts must be invoked via cmd.exe to avoid EINVAL
    const isWin = process.platform === 'win32';
    const command = isWin
      ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe')
      : 'npx';
    const spawnArgs = isWin
      ? ['/d', '/s', '/c', 'npx', '-y', '@playwright/mcp@latest', '--extension']
      : ['-y', '@playwright/mcp@latest', '--extension'];

    const proc = spawn(command, spawnArgs, {
      stdio: 'pipe',
      env: { ...env, [TOKEN_ENV]: token },
    });
    const client = new StdioMcpClient(proc);
    client.#attach();
    await client.#request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'x-article-upload-skill', version: '1.0.0' },
    }, MCP_INIT_TIMEOUT_MS);
    client.#writeFrame({ jsonrpc: '2.0', method: 'notifications/initialized' });
    console.log('🔌  MCP connected.');
    return client;
  }

  async call(toolName, toolArgs, timeoutMs = MCP_CALL_TIMEOUT_MS) {
    const result = await this.#request('tools/call', { name: toolName, arguments: toolArgs }, timeoutMs);
    return this.#parseToolResult(result);
  }

  async evaluate(fnSource, timeoutMs = MCP_EVALUATE_TIMEOUT_MS) {
    const raw = await this.call('browser_evaluate', { function: fnSource }, timeoutMs);
    const text = Array.isArray(raw) ? (raw.find(i => i?.text)?.text ?? '') : String(raw ?? '');
    // MCP wraps the return value in "### Result\n{...}\n### Ran Playwright code..."
    const resultMatch = text.match(/###\s*Result\s*\n([\s\S]*?)(?:\n###|$)/);
    const jsonStr = resultMatch ? resultMatch[1].trim() : text.trim();
    try { return JSON.parse(jsonStr); } catch { return jsonStr || text; }
  }

  async close() {
    try { this.#proc.stdin.end(); await new Promise(r => this.#proc.once('close', r)); } catch { /* ignore */ }
  }

  #attach() {
    this.#proc.stdout.on('data', chunk => {
      this.#buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      const lines = this.#buffer.split('\n');
      this.#buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (typeof msg.id !== 'number') continue;
          const p = this.#pending.get(msg.id);
          if (!p) continue;
          this.#pending.delete(msg.id);
          p.resolve(msg);
        } catch { /* ignore */ }
      }
    });
    this.#proc.stderr.on('data', chunk => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      if (/error|warn|fail/i.test(text)) process.stderr.write(`[MCP] ${text}`);
    });
    this.#proc.on('error', err => { this.#spawnError = err; });
    this.#proc.on('close', (code) => {
      this.#closed = true; this.#exitCode = code;
      const detail = this.#spawnError ? `Spawn error: ${this.#spawnError.message}` : `MCP process exited (code ${code})`;
      for (const p of this.#pending.values()) p.reject(new Error(detail));
      this.#pending.clear();
    });
  }

  #request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.#closed) return reject(new Error('MCP client is closed.'));
      const id = this.#nextId++;
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, timeoutMs);
      this.#pending.set(id, {
        resolve: msg => { clearTimeout(timer); resolve(msg); },
        reject:  err => { clearTimeout(timer); reject(err); },
      });
      this.#writeFrame({ jsonrpc: '2.0', id, method, params });
    });
  }

  #writeFrame(obj) { try { this.#proc.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* closed */ } }
  #parseToolResult(msg) {
    if (msg?.error) throw new Error(`MCP error: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    return msg?.result?.content ?? msg?.result ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {

// Step 1 — Resolve token
const token = cliToken || detectToken();
if (!token) {
  console.error([
    '',
    '❌  Playwright MCP Bridge token not found.',
    '',
    'To fix this, provide the token one of these ways:',
    '  1. Pass it directly:  node upload-article.mjs file.md --token <TOKEN>',
    '  2. Save it to .env:   echo "PLAYWRIGHT_MCP_EXTENSION_TOKEN=<TOKEN>" > ' + DOT_ENV_PATH,
    '  3. Set env var:       set PLAYWRIGHT_MCP_EXTENSION_TOKEN=<TOKEN>',
    '',
    'You can find the token in the Playwright MCP Bridge extension popup in Chrome/Edge.',
    '',
  ].join('\n'));
  exit(1);
}

console.log(`✅  Token resolved (${detectTokenSource(token)})`);

console.log(`🚦  Mode: ${MODE}`);

// Step 3 — Spawn playwright MCP, navigate to compose, click Create
console.log('🚀  Starting playwright MCP...');
const client = await StdioMcpClient.connect(token);

try {
  console.log('🌐  Navigating to X article editor...');
  await client.call('browser_navigate', { url: 'https://x.com/compose/articles' });
  await client.call('browser_wait_for', { time: 2 });

  console.log('🖱️   Clicking Create button...');
  await client.evaluate(`async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const btn =
      document.querySelector("button[aria-label='create']") ||
      Array.from(document.querySelectorAll('button')).find(
        b => (b.getAttribute('aria-label') || '').toLowerCase() === 'create'
      ) ||
      // Fallback: empty-state "撰写" link in the article home
      document.querySelector("a[data-testid='empty_state_button_text']");
    if (!btn) throw new Error('Create button not found.');
    btn.click();
    for (let i = 0; i < 30; i++) {
      const ed =
        document.querySelector("[data-contents='true'] [contenteditable='true']") ||
        document.querySelector("[contenteditable='true']");
      if (ed) return true;
      await sleep(200);
    }
    throw new Error('Editor did not become ready after clicking Create.');
  }`);

  if (MODE === 'api') {
    // API mode: parse markdown into segments, upload images via onFilesAdded,
    // POST ArticleEntityUpdateContent directly. No menu interaction.
    const { runApiMode } = await import('./api-mode/main.mjs');
    const result = await runApiMode({ mcpClient: client, mdPath: absFilePath });
    console.log('');
    console.log('✅  Article uploaded (api mode).');
    console.log(`    Draft URL: ${result.url}`);
    if (result.missingImages?.length) {
      console.log(`    ⚠ Missing images (insert manually): ${result.missingImages.length}`);
      result.missingImages.forEach(s => console.log(`      - ${s}`));
    }
  } else {
    // Menu mode: legacy flow — paste full HTML + click Insert menu for code/divider/image
    console.log(`📄  Processing markdown (legacy v1 path)...`);
    const payload = await processMarkdown(absFilePath);
    const itemSummary = payload.items.map(i => i.type).join(', ') || 'none';
    console.log(`    Title: ${payload.title ?? '(none)'} | Items: [${itemSummary}]${payload.cover ? ' | Cover: ✓' : ''}`);
    console.log('✍️   Publishing via shared browser template...');
    let publishResult = null;
    let publishErr = null;
    try {
      publishResult = await client.evaluate(buildSharedWorkspaceBrowserPublishFunction(payload));
    } catch (e) {
      publishErr = e;
      console.warn(`    ⚠ publish raised: ${e.message?.slice(0, 200) || e}`);
    }
    if (publishResult?.ok) {
      console.log(`    Structured items processed: ${publishResult.processedItems ?? 0}/${publishResult.totalItems ?? payload.items.length}`);
    }

    // Independent marker cleanup phase: even if publish errored mid-flight
    // (e.g. "Execution context was destroyed" from X-side navigation), this
    // Fiber pass scrubs every remaining MPH_MARKER_N block from the live
    // EditorState. Synthesized events don't trigger autosave, so we follow
    // up with a CDP-level Backspace.
    console.log('🧹  Running independent marker cleanup (Fiber)...');
    try {
      const cleanupResult = await client.evaluate(`async () => {
        const ed = document.querySelector("[data-contents='true']")?.closest("[contenteditable='true']")
                || document.querySelector("[contenteditable='true']");
        if (!ed) return { ok: false, reason: 'no editor' };
        const fiberKey = Object.keys(ed).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (!fiberKey) return { ok: false, reason: 'no fiber' };
        let f = ed[fiberKey], depth = 0, sn = null;
        while (f && depth < 60) {
          const node = f.stateNode;
          if (node?.props?.editorState && typeof node.props.onChange === 'function') { sn = node; break; }
          f = f.return; depth += 1;
        }
        if (!sn) return { ok: false, reason: 'no draft' };
        const editorState = sn.props.editorState;
        const onChange = sn.props.onChange;
        const ESCtor = editorState.constructor;
        const SSCtor = editorState.getSelection().constructor;
        const cs = editorState.getCurrentContent();
        const blockMap = cs.getBlockMap();
        const markerLine = /^\\s*MPH_MARKER_\\d+\\s*$/;
        const before = blockMap.size;
        const newMap = blockMap.filter((b) => {
          if (b.getType() === 'atomic') return true;
          return !markerLine.test(b.getText() || '');
        });
        const removed = before - newMap.size;
        if (removed === 0) return { ok: true, removed: 0 };
        const survivor = newMap.first();
        const safeSel = survivor ? SSCtor.createEmpty(survivor.getKey()) : editorState.getSelection();
        const newCs = cs.set('blockMap', newMap).set('selectionBefore', safeSel).set('selectionAfter', safeSel);
        let newState = ESCtor.push(editorState, newCs, 'remove-range');
        newState = ESCtor.moveSelectionToEnd(newState);
        onChange(newState);
        return { ok: true, removed, remainingBlocks: newMap.size };
      }`);
      console.log(`    Removed ${cleanupResult?.removed ?? '?'} marker block(s); remaining ${cleanupResult?.remainingBlocks ?? '?'}`);
    } catch (e) {
      console.warn(`    ⚠ marker cleanup failed: ${e.message?.slice(0, 200)}`);
    }

    // Trigger autosave so the cleanup persists. X's debouncer needs a
    // trusted input event — synthesized events from inside the page don't
    // count (verified in spike/x-article-direct-api). One CDP keystroke
    // does the job.
    console.log('💾  Nudging autosave (Backspace + 8s wait)...');
    try {
      await client.call('browser_press_key', { key: 'Backspace' });
    } catch (e) {
      console.warn(`    ⚠ autosave nudge failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 8000));

    // If publish itself raised AND cleanup didn't help, surface the error.
    if (publishErr && !publishResult?.ok) {
      throw publishErr;
    }

    const draftUrl = await client.evaluate(`() => {
      const href = window.location.href || '';
      return typeof href === 'string' ? href : '';
    }`);
    console.log('');
    console.log('✅  Article uploaded (menu mode).');
    if (payload.title) console.log(`    Title: "${payload.title}"`);
    console.log(`    Draft URL: ${typeof draftUrl === 'string' && draftUrl ? draftUrl : 'https://x.com/compose/articles'}`);
  }
} finally {
  await client.close();
}

} // end main()

main().catch(err => { console.error('❌ ', err.message); exit(1); });

function buildSharedWorkspaceBrowserPublishFunction(payload) {
  if (!sharedBrowserPublishBuilder) {
    if (!existsSync(SHARED_TEMPLATE_PATH)) {
      throw new Error(`Shared browser template not found: ${SHARED_TEMPLATE_PATH}`);
    }
    if (!existsSync(JITI_PATH)) {
      throw new Error(`jiti not found for shared template import: ${JITI_PATH}`);
    }
    const require = createRequire(import.meta.url);
    const { createJiti } = require(JITI_PATH);
    const jiti = createJiti(import.meta.url, { moduleCache: true, interopDefault: true });
    const mod = jiti(SHARED_TEMPLATE_PATH);
    const builder = mod?.getBrowserPublishFunctionTemplate;
    if (typeof builder !== 'function') {
      throw new Error(`Failed to load getBrowserPublishFunctionTemplate from ${SHARED_TEMPLATE_PATH}`);
    }
    sharedBrowserPublishBuilder = builder;
  }

  return sharedBrowserPublishBuilder(payload);
}


// ═════════════════════════════════════════════════════════════════════════════
// Token detection
// ═════════════════════════════════════════════════════════════════════════════

function detectToken() {
  // 1. .env file
  if (existsSync(DOT_ENV_PATH)) {
    try {
      for (const line of readFileSync(DOT_ENV_PATH, 'utf-8').split('\n')) {
        const m = line.match(/^\s*PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*["']?([^"'\s]+)["']?\s*$/);
        if (m?.[1] && validateToken(m[1])) return m[1];
      }
    } catch { /* ignore */ }
  }

  // 2. Environment variable
  if (env[TOKEN_ENV] && validateToken(env[TOKEN_ENV])) return env[TOKEN_ENV];

  // 3. MCP config files
  const home = homedir();
  const cwd  = process.cwd();
  for (const p of [
    join(home, '.codex', 'config.toml'),
    join(home, '.codex', 'mcp.json'),
    join(home, '.cursor', 'mcp.json'),
    join(home, '.claude.json'),
    join(home, '.gemini', 'settings.json'),
    join(home, '.gemini', 'antigravity', 'mcp_config.json'),
    join(home, '.config', 'opencode', 'opencode.json'),
    join(cwd, '.cursor', 'mcp.json'),
    join(cwd, '.vscode', 'mcp.json'),
    join(cwd, '.mcp.json'),
  ]) {
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, 'utf-8');
      const t = p.endsWith('.toml') ? extractFromToml(content) : extractFromJson(content);
      if (t) return t;
    } catch { /* ignore */ }
  }

  // 4. Browser LevelDB scan
  return scanBrowserProfiles();
}

function detectTokenSource(t) {
  if (cliToken === t) return '--token arg';
  if (existsSync(DOT_ENV_PATH)) {
    try {
      if (readFileSync(DOT_ENV_PATH, 'utf-8').includes(t)) return '.env';
    } catch { /* ignore */ }
  }
  if (env[TOKEN_ENV] === t) return 'env var';
  return 'config/browser scan';
}

function createConcurrencyLimiter(limit) {
  let activeCount = 0;
  const queue = [];

  const next = () => {
    if (activeCount >= limit || queue.length === 0) return;
    const task = queue.shift();
    if (!task) return;
    activeCount += 1;
    Promise.resolve()
      .then(task.run)
      .then(task.resolve, task.reject)
      .finally(() => {
        activeCount -= 1;
        next();
      });
  };

  return (run) => new Promise((resolve, reject) => {
    queue.push({ run, resolve, reject });
    next();
  });
}

function readDotEnvValue(name) {
  if (!existsSync(DOT_ENV_PATH)) return null;
  try {
    for (const line of readFileSync(DOT_ENV_PATH, 'utf-8').split('\n')) {
      const match = line.match(new RegExp(`^\\s*${name}\\s*=\\s*["']?([^"'\r\n]+)["']?\\s*$`));
      if (match?.[1]) return match[1].trim();
    }
  } catch { /* ignore */ }
  return null;
}

function parseBooleanSetting(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function resolveAutoApplyCover() {
  return parseBooleanSetting(readDotEnvValue('X_ARTICLE_AUTO_APPLY_COVER'), DEFAULT_AUTO_APPLY_COVER);
}

function validateToken(t) {
  try {
    const decoded = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return decoded.length >= 28 && decoded.length <= 36;
  } catch { return false; }
}

function extractFromJson(content) {
  try {
    const p = JSON.parse(content);
    return p?.mcpServers?.playwright?.env?.[TOKEN_ENV]
      || p?.mcp?.playwright?.env?.[TOKEN_ENV]
      || null;
  } catch { return null; }
}

function extractFromToml(content) {
  const sec = content.match(/\[mcp_servers\.playwright\]([\s\S]*?)(?=\[|$)/)?.[1];
  if (!sec) return null;
  const envSec = sec.match(/\[mcp_servers\.playwright\.env\]([\s\S]*?)(?=\[|$)/)?.[1];
  if (!envSec) return null;
  return envSec.match(new RegExp(`^\\s*${TOKEN_ENV}\\s*=\\s*"([^"]+)"`, 'm'))?.[1] ?? null;
}

function scanBrowserProfiles() {
  const home       = homedir();
  const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const bases = [
    join(localAppData, 'Google', 'Chrome', 'User Data'),
    join(localAppData, 'Microsoft', 'Edge', 'User Data'),
  ];
  if (platform() === 'darwin') {
    bases.push(
      join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
      join(home, 'Library', 'Application Support', 'Microsoft Edge'),
    );
  }

  const extIdBuf = Buffer.from(EXTENSION_ID);
  const keyBuf   = Buffer.from('auth-token');

  for (const base of bases) {
    for (const profile of ['Default', 'Profile 1', 'Profile 2', 'Profile 3']) {
      const dir = join(base, profile, 'Local Storage', 'leveldb');
      if (!existsSync(dir)) continue;
      let files;
      try {
        files = readdirSync(dir)
          .filter(f => f.endsWith('.ldb') || f.endsWith('.log'))
          .map(f => join(dir, f))
          .sort((a, b) => { try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; } });
      } catch { continue; }

      for (const fp of files) {
        let data;
        try { data = readFileSync(fp); } catch { continue; }
        if (data.indexOf(extIdBuf) === -1) continue;
        let cursor = 0;
        while (true) {
          const keyPos = data.indexOf(keyBuf, cursor);
          if (keyPos === -1) break;
          const extPos = data.indexOf(extIdBuf, Math.max(0, keyPos - 500));
          if (extPos !== -1 && extPos < keyPos) {
            const candidate = data.subarray(keyPos + keyBuf.length, keyPos + keyBuf.length + 200)
              .toString('latin1').match(TOKEN_RE)?.[1];
            if (candidate && validateToken(candidate)) return candidate;
          }
          cursor = keyPos + 1;
        }
      }
    }
  }
  return null;
}


// ═════════════════════════════════════════════════════════════════════════════
// Remote image fetching
// ═════════════════════════════════════════════════════════════════════════════

async function fetchRemoteImage(url, alt) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; x-article-upload/1.0)' },
      redirect: 'follow',
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || 'image/png';
    const mimeType = inferMimeType(url, contentType);
    const arrayBuffer = await response.arrayBuffer();
    const fileName = extractFileName(url, mimeType);
    return { alt, fileName, mimeType, base64: Buffer.from(arrayBuffer).toString('base64') };
  } catch { return null; }
}

function inferMimeType(url, contentType) {
  const normalized = (contentType.split(';')[0] || '').trim().toLowerCase();
  if (normalized.startsWith('image/')) return normalized;
  const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' })[ext] || 'image/png';
}

function extractFileName(url, mimeType) {
  const cleanUrl = url.split('?')[0];
  const last = (cleanUrl.split('/').pop() || '').trim();
  if (last && last.includes('.')) return last;
  const ext = mimeType.split('/')[1] || 'png';
  return last || `remote-image.${ext}`;
}

async function resolveImageAsset(target, alt, baseDir) {
  if (!target) return null;
  // Strip wikilink pipe alias: "file.png|200" → "file.png"
  const pipeIdx = target.indexOf('|');
  const cleanTarget = (pipeIdx >= 0 ? target.slice(0, pipeIdx) : target).trim();
  if (!cleanTarget) return null;

  if (/^https?:\/\//i.test(cleanTarget)) {
    return fetchRemoteImage(cleanTarget, alt);
  }

  // Local file path
  const localPath = resolve(baseDir, cleanTarget);
  if (!existsSync(localPath)) return null;
  try {
    const data = readFileSync(localPath);
    const ext = extname(localPath).slice(1).toLowerCase();
    const mimeType = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', png: 'image/png' })[ext] || 'image/png';
    return { alt, fileName: localPath.split(/[/\\]/).pop(), mimeType, base64: data.toString('base64') };
  } catch { return null; }
}


// ═════════════════════════════════════════════════════════════════════════════
// Markdown processor
// ═════════════════════════════════════════════════════════════════════════════

async function processMarkdown(filePath) {
  const raw = readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
  const fileDir = dirname(filePath);

  // Parse frontmatter
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n*/);
  const meta    = {};
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const ci = line.indexOf(':');
      if (ci < 0) continue;
      meta[line.slice(0, ci).trim()] = line.slice(ci + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  const title = meta.title || meta.Title || null;
  let body    = fmMatch ? raw.slice(fmMatch[0].length).trim() : raw.trim();

  // Collect all special segments in document order
  const segments = [];
  let m;

  // Code blocks
  const codeRe = /```([^\n`]*)\n([\s\S]*?)```/g;
  while ((m = codeRe.exec(body)) !== null) {
    segments.push({ type: 'code', start: m.index, end: m.index + m[0].length,
      language: (m[1] || '').trim(), code: (m[2] || '').replace(/\n$/, '') });
  }

  // HR dividers (outside code blocks)
  const hrRe = /^(?: {0,3})(?:-{3,}|\*{3,}|_{3,})(?:[ \t]*)$/gm;
  while ((m = hrRe.exec(body)) !== null) {
    if (!segments.some(s => m.index >= s.start && m.index < s.end))
      segments.push({ type: 'divider', start: m.index, end: m.index + m[0].length });
  }

  // X/Twitter post URLs (bare, on own line)
  const postUrlRe = /^(?: {0,3})(https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+(?:\?[^\s]+)?)\s*$/gm;
  while ((m = postUrlRe.exec(body)) !== null) {
    if (!segments.some(s => m.index >= s.start && m.index < s.end))
      segments.push({ type: 'post', start: m.index, end: m.index + m[0].length, url: m[1].trim() });
  }

  // X/Twitter post markdown links: [url](url)
  const postLinkRe = /\[(https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+(?:\?[^\]\s]+)?)\]\((https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+(?:\?[^)\s]+)?)\)/g;
  while ((m = postLinkRe.exec(body)) !== null) {
    if (!segments.some(s => m.index >= s.start && m.index < s.end))
      segments.push({ type: 'post', start: m.index, end: m.index + m[0].length, url: (m[2] || m[1]).trim() });
  }

  // Markdown images: ![alt](url)
  const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
  while ((m = imgRe.exec(body)) !== null) {
    if (!segments.some(s => m.index >= s.start && m.index < s.end))
      segments.push({ type: 'image', start: m.index, end: m.index + m[0].length, alt: m[1].trim(), target: m[2].trim() });
  }

  // Wikilink images: ![[file]]
  const wikiRe = /!\[\[([^\]]+)\]\]/g;
  while ((m = wikiRe.exec(body)) !== null) {
    if (!segments.some(s => m.index >= s.start && m.index < s.end))
      segments.push({ type: 'image', start: m.index, end: m.index + m[0].length, alt: '', target: m[1].trim() });
  }

  segments.sort((a, b) => a.start - b.start);

  // Replace segments with markers in reverse order so indices stay valid.
  let processed = body;
  const imageTasks = new Map();
  const limitImageFetch = createConcurrencyLimiter(IMAGE_FETCH_CONCURRENCY);

  for (let i = segments.length - 1; i >= 0; i--) {
    const seg    = segments[i];
    const marker = `MPH_MARKER_${i + 1}`;
    processed = processed.slice(0, seg.start) + `\n\n${marker}\n\n` + processed.slice(seg.end);

    if (seg.type === 'image') {
      const targetPreview = (seg.target || '').slice(0, 60);
      process.stdout.write(`    Queueing image: ${targetPreview}...\n`);
      imageTasks.set(
        marker,
        limitImageFetch(() => resolveImageAsset(seg.target, seg.alt, fileDir)).then(asset => {
          if (asset) {
            process.stdout.write(`    ✓ Image fetched: ${asset.fileName} (${Math.round(asset.base64.length * 0.75 / 1024)} KB)\n`);
          } else {
            process.stdout.write(`    ⚠ Image not resolved: ${targetPreview}\n`);
          }
          return asset;
        }),
      );
    }
  }

  const items = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    const marker = `MPH_MARKER_${i + 1}`;
    if (seg.type === 'code') {
      items.push({ type: 'code', marker, language: seg.language, code: seg.code });
    } else if (seg.type === 'divider') {
      items.push({ type: 'divider', marker });
    } else if (seg.type === 'post') {
      items.push({ type: 'post', marker, url: seg.url });
    } else if (seg.type === 'image') {
      const asset = await imageTasks.get(marker);
      if (asset) {
        items.push({ type: 'image', marker, ...asset });
      }
    }
  }

  // Resolve cover image
  let cover = null;
  const coverTarget = meta.cover || meta.Cover || null;
  if (coverTarget) {
    // Normalize: strip ![[...]] or ![...](...)  wrappers
    const normalized = coverTarget
      .replace(/^!\[\[|\]\]$/g, '')
      .replace(/^!\[[^\]]*\]\((.+)\)$/u, '$1')
      .trim();
    process.stdout.write(`    Fetching cover: ${normalized.slice(0, 60)}...\r`);
    cover = await resolveImageAsset(normalized, '', fileDir);
    if (cover) {
      process.stdout.write(`    ✓ Cover fetched: ${cover.fileName} (${Math.round(cover.base64.length * 0.75 / 1024)} KB)\n`);
    } else {
      process.stdout.write(`    ⚠ Cover not resolved: ${normalized.slice(0, 60)}\n`);
    }
  }

  const html = mdToHtml(processed);
  return { html, markdown: processed, title, cover, items, autoApplyCover: resolveAutoApplyCover() };
}

function mdToHtml(md) {
  // Use safe non-markdown placeholders to protect MPH_MARKER_N from inline processing.
  // MPH_MARKER_N contains underscores which would be corrupted by _..._  bold/italic rules.
  const markerMap = {};
  let s = md.replace(/MPH_MARKER_(\d+)/g, (_, n) => {
    const key = `MPHMKR${n}END`;
    markerMap[key] = `MPH_MARKER_${n}`;
    return key;
  });

  // Headings
  s = s.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  s = s.replace(/^#####\s+(.+)$/gm,  '<h5>$1</h5>');
  s = s.replace(/^####\s+(.+)$/gm,   '<h4>$1</h4>');
  s = s.replace(/^###\s+(.+)$/gm,    '<h3>$1</h3>');
  s = s.replace(/^##\s+(.+)$/gm,     '<h2>$1</h2>');
  s = s.replace(/^#\s+(.+)$/gm,      '<h1>$1</h1>');

  // Bold & italic
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g,         '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g,         '<em>$1</em>');
  s = s.replace(/_(.+?)_/g,           '<em>$1</em>');

  // Inline code
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Links — but NOT image links (those are already replaced by markers)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Unordered lists
  s = s.replace(/((?:^[ \t]*[-*+][ \t].+\n?)+)/gm, block => {
    const lis = block.trim().split('\n')
      .map(l => `<li>${l.replace(/^[ \t]*[-*+][ \t]/, '').trim()}</li>`).join('');
    return `<ul>${lis}</ul>`;
  });

  // Ordered lists
  s = s.replace(/((?:^[ \t]*\d+\.[ \t].+\n?)+)/gm, block => {
    const lis = block.trim().split('\n')
      .map(l => `<li>${l.replace(/^[ \t]*\d+\.[ \t]/, '').trim()}</li>`).join('');
    return `<ol>${lis}</ol>`;
  });

  // Blockquotes
  s = s.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');

  // Paragraphs: wrap non-tagged, non-marker lines
  s = s.split('\n\n').map(block => {
    block = block.trim();
    if (!block) return '';
    if (/^<(h[1-6]|ul|ol|blockquote|p)/.test(block)) return block;
    if (/^(?:MPHMKR\d+END\s*)+$/.test(block)) {
      const markers = block.match(/MPHMKR\d+END/g) || [];
      return markers.map(marker => `<p>${marker}</p>`).join('\n');
    }
    return `<p>${block.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  // Restore markers
  for (const [key, orig] of Object.entries(markerMap)) {
    s = s.split(key).join(orig);
  }

  return s.trim();
}


// ═════════════════════════════════════════════════════════════════════════════
// Browser function builders
// ═════════════════════════════════════════════════════════════════════════════

// Common DOM helpers (embedded in every evaluate function).
// All regex backslashes are doubled because these are JS template literals.
const BROWSER_HELPERS = `
  const sleep = ms => new Promise(r => window.setTimeout(r, ms));

  function findEditor() {
    return document.querySelector("[data-contents='true'] [contenteditable='true']")
      || document.querySelector("[contenteditable='true']");
  }

  function isVisibleElement(node) {
    if (!(node instanceof HTMLElement)) return false;
    const s = window.getComputedStyle(node);
    if (s.display === 'none' || s.visibility === 'hidden' || s.pointerEvents === 'none') return false;
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function normalizeText(value) {
    return (value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  }

  function measureDistanceToRect(node, targetRect) {
    if (!(node instanceof HTMLElement) || !targetRect) return Number.POSITIVE_INFINITY;
    const rect = node.getBoundingClientRect();
    const dx = (rect.left + rect.width / 2) - (targetRect.left + targetRect.width / 2);
    const dy = (rect.top + rect.height / 2) - (targetRect.top + targetRect.height / 2);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function findClickableByText(labels, targetRect) {
    const normalized = (Array.isArray(labels) ? labels : [labels]).map(normalizeText);
    const nodes = Array.from(document.querySelectorAll("button,[role='button'],[role='menuitem'],[role='option']"))
      .filter(isVisibleElement)
      .filter(n => normalized.some(l => normalizeText(n.textContent || '') === l || normalizeText(n.textContent || '').includes(l)));
    if (!nodes.length) return null;
    nodes.sort((a, b) => measureDistanceToRect(a, targetRect) - measureDistanceToRect(b, targetRect));
    return nodes[0] || null;
  }

  function findAnchorToken(token) {
    const editor = findEditor();
    if (!editor) return null;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let cur;
    while ((cur = walker.nextNode())) {
      const off = cur.textContent.indexOf(token);
      if (off >= 0) return { node: cur, offset: off };
    }
    return null;
  }

  function deleteMarkerFromTextNode(node, marker, offset) {
    const text = node.textContent || '';
    const off = typeof offset === 'number' ? offset : text.indexOf(marker);
    if (off < 0) return false;
    node.textContent = text.slice(0, off) + text.slice(off + marker.length);
    return true;
  }

  function clickAt(rect) {
    const x = rect.left + Math.min(rect.width, 8);
    const y = rect.top + rect.height / 2;
    const target = document.elementFromPoint(x, y);
    if (!target) return;
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
    target.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, clientX: x, clientY: y }));
    target.dispatchEvent(new MouseEvent('click',     { bubbles: true, clientX: x, clientY: y }));
  }

  function placeCaretFromPoint(rect) {
    const x = rect.left + Math.min(Math.max(rect.width, 4), 12);
    const y = rect.top + Math.max(rect.height / 2, 4);
    const sel = window.getSelection();
    if (!sel) return false;
    if (document.caretPositionFromPoint) {
      const cp = document.caretPositionFromPoint(x, y);
      if (cp?.offsetNode) {
        const range = document.createRange();
        range.setStart(cp.offsetNode, cp.offset);
        range.collapse(true);
        sel.removeAllRanges(); sel.addRange(range);
        return true;
      }
    }
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      if (range) {
        range.collapse(true);
        sel.removeAllRanges(); sel.addRange(range);
        return true;
      }
    }
    return false;
  }

  async function restoreCaretAtRect(rect) {
    const editor = findEditor();
    if (editor) editor.focus();
    await sleep(30);
    if (!placeCaretFromPoint(rect)) { clickAt(rect); await sleep(30); placeCaretFromPoint(rect); }
  }

  function getRectAfterToken(token) {
    const found = findAnchorToken(token);
    if (!found) return null;
    const range = document.createRange();
    range.setStart(found.node, found.offset + token.length);
    range.collapse(true);
    return range.getBoundingClientRect();
  }

  async function clickAnchorToken(token) {
    const rect = getRectAfterToken(token);
    if (!rect) return false;
    await restoreCaretAtRect(rect);
    await sleep(30);
    clickAt(rect);
    await sleep(60);
    return true;
  }

  function removeEmptyBlock(block) {
    if (!block) return;
    const text = (block.textContent || '').replace(/\\u200b/g, '').trim();
    const hasContent = Boolean(block.querySelector("img,video,iframe,figure,pre,hr,[data-testid='tweet'],[data-testid='tweetPhoto']"));
    if (!hasContent && text.length === 0) block.remove();
  }

  function removeAnchorToken(token) {
    const found = findAnchorToken(token);
    if (!found) return false;
    deleteMarkerFromTextNode(found.node, token, found.offset);
    removeEmptyBlock(found.node.parentElement?.closest("[data-block='true']"));
    return true;
  }

  function removeResidualMarkers() {
    const editor = findEditor();
    if (!editor) return;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const pattern = /(?:^|\\s)MPH_MARKER_\\d+(?=\\s|$)/g;
    const touched = new Set();
    let cur;
    while ((cur = walker.nextNode())) {
      const text = cur.textContent || '';
      const cleaned = text.replace(pattern, ' ').replace(/\\s{2,}/g, ' ').trim();
      if (cleaned !== text.trim()) {
        cur.textContent = cleaned;
        touched.add(cur.parentElement?.closest("[data-block='true']"));
      }
    }
    touched.forEach(block => removeEmptyBlock(block));
  }

  async function focusMarker(marker) {
    const editor = findEditor();
    if (!editor) return null;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let cur;
    while ((cur = walker.nextNode())) {
      const off = cur.textContent.indexOf(marker);
      if (off < 0) continue;
      const block = cur.parentElement?.closest("[data-block='true']") || cur.parentElement;
      if (!block) return null;
      block.scrollIntoView({ behavior: 'instant', block: 'center' });
      await sleep(150);
      const range = document.createRange();
      range.setStart(cur, off);
      range.setEnd(cur, off + marker.length);
      const rect = range.getBoundingClientRect();
      const sel = window.getSelection();
      sel?.removeAllRanges(); sel?.addRange(range);
      await sleep(200);
      return { rect: getRectAfterToken(marker) || rect, marker, token: marker };
    }
    return null;
  }

  async function openInsertMenu(optionLabels, anchorInfo) {
    if (anchorInfo?.token) await clickAnchorToken(anchorInfo.token);
    else if (anchorInfo?.rect) await restoreCaretAtRect(anchorInfo.rect);
    const insertBtn = findClickableByText(['插入', 'Insert', 'insert'], anchorInfo?.rect);
    if (!insertBtn) throw new Error('Insert button not found.');
    insertBtn.click();
    await sleep(300);
    const option = findClickableByText(optionLabels, anchorInfo?.rect);
    if (!option) throw new Error('Insert menu option not found: ' + optionLabels.join('/'));
    option.click();
    await sleep(400);
  }
`;

// Phase 1: inject title + HTML only. Structured items are inserted afterward in marker order.
function buildTextInjectFunction(payload) {
  return `async () => {
  const payload = ${JSON.stringify({ title: payload.title, html: payload.html, markdown: payload.markdown })};
${BROWSER_HELPERS}

  function findTitleField() {
    const editor = findEditor();
    const keywords = ['title', '标题', 'add title', '输入标题'];
    return Array.from(document.querySelectorAll("input[type='text'], textarea, [contenteditable='true']"))
      .filter(n => n !== editor && isVisibleElement(n))
      .map(n => {
        const text = normalizeText(n.getAttribute('aria-label') || n.getAttribute('placeholder') || n.getAttribute('data-testid') || '');
        const rect = n.getBoundingClientRect();
        let score = 0;
        if (keywords.some(k => text.includes(k))) score += 10;
        if (rect.top < 420) score += 4;
        if (rect.width > 240) score += 2;
        return { n, score };
      })
      .sort((a, b) => b.score - a.score)[0]?.n || null;
  }

  async function setArticleTitle() {
    if (!payload.title) return;
    const f = findTitleField();
    if (!f) { console.warn('Title field not found.'); return; }
    if (f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement) {
      const proto = f instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(f, payload.title);
      f.dispatchEvent(new Event('input', { bubbles: true }));
      f.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      f.focus(); await sleep(80);
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, payload.title);
      f.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await sleep(250);
  }

  async function insertArticleHtml() {
    const editor = findEditor();
    if (!editor) throw new Error('Editor not found.');
    editor.focus(); await sleep(100);
    const before = (editor.textContent || '').replace(/\\s/g, '').length;
    const dt = new DataTransfer();
    dt.setData('text/html', payload.html);
    dt.setData('text/plain', payload.markdown);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(500);
    if ((editor.textContent || '').replace(/\\s/g, '').length <= before) {
      document.execCommand('insertHTML', false, payload.html);
      await sleep(200);
    }
  }

  await setArticleTitle();
  await sleep(200);
  await insertArticleHtml();
  await sleep(800);
  return { ok: true };
}`;
}

// Phase 2: Insert a single structured item at its marker location.
function buildInsertItemFunction(item) {
  return `async () => {
  const item = ${JSON.stringify(item)};
${BROWSER_HELPERS}
  async function waitForSelector(selector, attempts = 20, delayMs = 150) {
    for (let i = 0; i < attempts; i++) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(delayMs);
    }
    return null;
  }

  function findByXPath(xpath) {
    try {
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue;
    } catch { return null; }
  }

  async function waitForXPath(xpath, attempts = 30, delayMs = 200) {
    for (let i = 0; i < attempts; i++) {
      const node = findByXPath(xpath);
      if (node) return node;
      await sleep(delayMs);
    }
    return null;
  }

  async function insertCodeBlock(anchorInfo) {
    await openInsertMenu(['代码', 'Code', 'code'], anchorInfo);
    const langInput = await waitForSelector("input[name='programming-language-input'],input[data-testid='programming-language-input']");
    if (langInput && item.language) {
      const proto = langInput instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(langInput, item.language.trim());
      langInput.dispatchEvent(new Event('input', { bubbles: true }));
      langInput.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(250);
      langInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      langInput.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      await sleep(250);
    }
    let ta = null;
    for (let i = 0; i < 20; i++) {
      ta = document.querySelector("textarea[name='code-input']")
        || document.querySelector("[role='dialog'] textarea[name='code-input']")
        || document.querySelector("[role='dialog'] textarea")
        || document.querySelector('textarea')
        || document.querySelector("[role='dialog'] [contenteditable='true']");
      if (ta) break;
      await sleep(150);
    }
    if (!ta) throw new Error('Code textarea not found.');
    if (ta instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(ta, item.code);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      ta.focus();
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, item.code);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await sleep(200);
    const dialog = ta.closest("[role='dialog']") || document;
    const submitBtn = Array.from(dialog.querySelectorAll("button[role='button'],button")).find(b => {
      const t = normalizeText(b.textContent || '');
      const disabled = b.getAttribute('aria-disabled') === 'true' || b.disabled;
      return (t === '插入' || t.includes('插入') || t === 'insert' || t.includes('insert')) && !disabled;
    });
    if (!submitBtn) throw new Error('Code submit button not found.');
    submitBtn.click();
    await sleep(800);
  }

  async function insertPost(anchorInfo) {
    if (anchorInfo?.token) await clickAnchorToken(anchorInfo.token);
    else if (anchorInfo?.rect) await restoreCaretAtRect(anchorInfo.rect);
    const insertBtn = findClickableByText(['插入', 'Insert', 'insert'], anchorInfo?.rect);
    if (!insertBtn) throw new Error('Insert button not found.');
    insertBtn.click();
    await sleep(300);
    const postOpt = findClickableByText(['帖子', 'Posts', 'posts', 'post', 'tweet']);
    if (!postOpt) throw new Error('Post option not found in insert menu.');
    postOpt.click();
    const urlInput = await waitForSelector("input[name='TweetByUrlInput']");
    if (!urlInput) throw new Error('TweetByUrlInput not found.');
    const proto = urlInput instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(urlInput, item.url);
    urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    urlInput.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    const xpathConfirm = await waitForXPath('//button/article', 30, 200);
    if (xpathConfirm instanceof HTMLElement) {
      xpathConfirm.click();
    } else {
      const fallback = findClickableByText(['插入', 'Insert', '确认', 'Confirm'])
        || (urlInput.closest("[role='dialog']") || document).querySelector("button[role='button'],button");
      if (!(fallback instanceof HTMLElement)) throw new Error('Post confirm button not found.');
      fallback.click();
    }
    await sleep(1000);
  }

  async function insertDivider(anchorInfo) {
    await openInsertMenu(['分割线', 'Divider', 'divider', 'separator', 'horizontal rule'], anchorInfo);
    await sleep(500);
  }

  async function waitForFileInput(targetRect) {
    for (let i = 0; i < 20; i++) {
      const dialogs = Array.from(document.querySelectorAll("div[data-testid='sheetDialog']")).filter(isVisibleElement);
      const sorted = dialogs.sort((a, b) => measureDistanceToRect(a, targetRect) - measureDistanceToRect(b, targetRect));
      const dialog = sorted[0] || dialogs.at(-1) || null;
      const input =
        dialog?.querySelector("input[type='file'], input[data-testid='fileInput']") ||
        document.querySelector("input[type='file'], input[data-testid='fileInput']") ||
        null;
      if (input instanceof HTMLInputElement) return input;
      await sleep(150);
    }
    throw new Error('Media file input not found in sheetDialog.');
  }

  async function waitForMediaUpload(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const prog = document.querySelector("[data-testid='uploadProgress'],[role='progressbar']");
      if (!prog) { await sleep(300); return; }
      await sleep(300);
    }
  }

  function base64ToFile(base64, fileName, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([new Blob([bytes], { type: mimeType })], fileName, { type: mimeType });
  }

  async function insertImage(anchorInfo) {
    await openInsertMenu(['媒体', 'Media', 'media', 'photo', 'image'], anchorInfo);
    const input = await waitForFileInput(anchorInfo.rect);
    const file = base64ToFile(item.base64, item.fileName, item.mimeType);
    const data = new DataTransfer();
    data.items.add(file);
    input.files = data.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitForMediaUpload(15000);
  }

  const anchorInfo = await focusMarker(item.marker);
  if (!anchorInfo) {
    return { ok: false, error: 'Marker not found: ' + item.marker };
  }

  try {
    if (item.type === 'code') await insertCodeBlock(anchorInfo);
    else if (item.type === 'post') await insertPost(anchorInfo);
    else if (item.type === 'divider') await insertDivider(anchorInfo);
    else if (item.type === 'image') await insertImage(anchorInfo);
    else return { ok: false, error: 'Unsupported item type: ' + item.type };
  } finally {
    removeAnchorToken(anchorInfo.token);
  }

  await sleep(500);
  return { ok: true };
}`;
}

// Phase 3: Remove any residual marker text
function buildCleanupFunction() {
  return `async () => {
${BROWSER_HELPERS}
  removeResidualMarkers();
  return { ok: true };
}`;
}

// Phase 4 (cover): Stage cover data then upload via plugin's uploadCover() pattern:
//   find cover button → click → wait for input[data-testid='fileInput'] → set input.files directly.
function buildStageCoverFunction(coverData) {
  return `async () => {
  window.__xUploadImg = ${JSON.stringify({ base64: coverData.base64, fileName: coverData.fileName, mimeType: coverData.mimeType })};
  return { ok: true };
}`;
}

function buildInsertStagedCoverFunction() {
  return `async () => {
${BROWSER_HELPERS}

  async function waitForCoverFileInput(coverButton) {
    for (let i = 0; i < 20; i++) {
      const container = coverButton?.closest('div') || coverButton?.parentElement || document;
      const input = container?.querySelector("input[data-testid='fileInput']")
        || document.querySelector("input[data-testid='fileInput']");
      if (input instanceof HTMLInputElement) return input;
      await sleep(150);
    }
    throw new Error('Cover file input not found.');
  }

  async function waitForMediaUpload(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const prog = document.querySelector("[data-testid='uploadProgress'],[role='progressbar']");
      if (!prog) { await sleep(300); return; }
      await sleep(300);
    }
  }

  function base64ToFile(base64, fileName, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([new Blob([bytes], { type: mimeType })], fileName, { type: mimeType });
  }

  const item = window.__xUploadImg;
  if (!item) return { ok: false, error: 'No staged cover data (window.__xUploadImg is missing)' };

  try {
    const labels = ['封面', 'cover', 'add cover', 'upload cover', '更换封面', '编辑封面', '添加照片或视频', 'add photos or video'];
    let btn = document.querySelector("button[aria-label='添加照片或视频'],button[aria-label='Add photos or video']");
    if (!btn || !isVisibleElement(btn)) {
      btn = Array.from(document.querySelectorAll("button,[role='button']"))
        .filter(isVisibleElement)
        .find(n => {
          const text = normalizeText([n.textContent || '', n.getAttribute('aria-label') || '', n.getAttribute('data-testid') || ''].join(' '));
          return labels.some(l => text.includes(l));
        }) || null;
    }
    if (!btn) { console.warn('Cover button not found.'); return { ok: false, error: 'Cover button not found' }; }

    btn.click();
    await sleep(400);

    const input = await waitForCoverFileInput(btn);
    const file = base64ToFile(item.base64, item.fileName, item.mimeType);
    const data = new DataTransfer();
    data.items.add(file);
    input.files = data.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitForMediaUpload(15000);
    await sleep(600);
  } finally {
    delete window.__xUploadImg;
  }

  return { ok: true };
}`;
}
