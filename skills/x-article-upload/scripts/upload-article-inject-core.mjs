#!/usr/bin/env node
/**
 * Minimal inject-core upload path:
 *   local .md -> prefetch images -> Playwright MCP browser_evaluate ->
 *   window.__xArticleInjectCore.runMarkdown().
 *
 * This intentionally does not touch the older api-mode/menu scripts.
 */
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { argv, env, exit, execPath, platform } from 'node:process';
import { fileURLToPath } from 'node:url';

const TOKEN_ENV = 'PLAYWRIGHT_MCP_EXTENSION_TOKEN';
const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_DIR = resolve(SKILL_DIR, '..', '..');
const RUNNER_PATH = join(WORKSPACE_DIR, 'packages', 'inject-core', 'dist', 'inject-core-runner.iife.js');
const DETECT_TOKEN_SCRIPT = join(SKILL_DIR, 'scripts', 'detect-playwright-token.mjs');
const MCP_REQUEST_TIMEOUT_MS = 10_000;
const MCP_EVALUATE_TIMEOUT_MS = 180_000;
const IMAGE_FETCH_CONCURRENCY = 4;

async function main() {
const args = argv.slice(2);
const filePath = args.find((arg, index) => !arg.startsWith('-') && args[index - 1] !== '--token');
const tokenIdx = args.indexOf('--token');
const cliToken = tokenIdx >= 0 ? args[tokenIdx + 1] : null;

if (!filePath) {
  console.error('Usage: node upload-article-inject-core.mjs <file.md> [--token <TOKEN>]');
  exit(1);
}

const absFilePath = resolve(filePath);
if (!existsSync(absFilePath)) {
  console.error(`File not found: ${absFilePath}`);
  exit(1);
}
if (!existsSync(RUNNER_PATH)) {
  console.error(`inject-core runner bundle not found: ${RUNNER_PATH}`);
  console.error('Run: pnpm -C packages/inject-core build');
  exit(1);
}

const token = cliToken || detectToken();
if (!token) {
  console.error('Playwright MCP Bridge token not found. Pass --token <TOKEN> or run detect-playwright-token.mjs --save <TOKEN>.');
  exit(1);
}

const markdown = readFileSync(absFilePath, 'utf-8').replace(/\r\n/g, '\n');
const runnerSource = readFileSync(RUNNER_PATH, 'utf-8');
const imageMap = await buildImageMap(absFilePath, markdown);
const client = await StdioMcpClient.connect(token);

try {
  console.log('🌐 Navigating to X article editor...');
  await client.call('browser_navigate', { url: 'https://x.com/compose/articles' });
  await client.call('browser_wait_for', { time: 2 });
  await client.evaluate(CREATE_OR_FIND_EDITOR_FUNCTION);
  console.log(`✍️ Uploading through inject-core (${Object.keys(imageMap).length} staged image keys)...`);
  const result = await client.evaluate(buildInjectCoreEvaluateFunction(runnerSource, markdown, imageMap));
  if (!result?.ok) {
    throw new Error(`inject-core upload did not report ok: ${JSON.stringify(result)}`);
  }
  try {
    await client.call('browser_press_key', { key: 'Backspace' }, MCP_REQUEST_TIMEOUT_MS);
  } catch {
    // Older MCP versions may not expose browser_press_key.
  }
  await client.call('browser_wait_for', { time: 3 });
  console.log('✅ Article uploaded through inject-core.');
} finally {
  await client.close();
}
}

function detectToken() {
  if (env[TOKEN_ENV]) return env[TOKEN_ENV];
  const result = spawnSync(execPath, [DETECT_TOKEN_SCRIPT], { encoding: 'utf-8' });
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    return parsed.token || null;
  } catch {
    return null;
  }
}

async function buildImageMap(mdPath, md) {
  const references = collectImageReferences(md);
  const map = {};
  const limit = createConcurrencyLimiter(IMAGE_FETCH_CONCURRENCY);
  await Promise.all(
    references.map((reference) =>
      limit(async () => {
        const asset = await resolveImageAsset(mdPath, reference.normalized);
        addImageMapEntry(map, reference.raw, asset);
        addImageMapEntry(map, reference.normalized, asset);
      }),
    ),
  );
  return map;
}

function collectImageReferences(md) {
  const references = [];
  const seen = new Set();
  const add = (raw) => {
    const normalized = normalizeImageTarget(raw);
    if (!normalized) return;
    const key = `${raw}\n${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push({ raw, normalized });
  };

  let match;
  const markdownImagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
  while ((match = markdownImagePattern.exec(md)) !== null) add(match[2] || '');
  const wikiImagePattern = /!\[\[([^\]]+)\]\]/g;
  while ((match = wikiImagePattern.exec(md)) !== null) add(match[1] || '');
  const cover = extractFrontmatterCover(md);
  if (cover) add(cover);
  return references;
}

async function resolveImageAsset(mdPath, target) {
  if (/^https?:\/\//i.test(target)) return resolveRemoteImageAsset(target);
  const localPath = resolve(dirname(mdPath), safeDecodeUri(target).replace(/^\.?\//, ''));
  try {
    const bytes = readFileSync(localPath);
    return {
      ok: true,
      fileName: localPath.replace(/\\/g, '/').split('/').pop() || 'image.png',
      mime: getMimeType(localPath),
      base64: bytes.toString('base64'),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function resolveRemoteImageAsset(target) {
  try {
    const response = await fetch(target);
    if (!response.ok) return { ok: false, error: `remote image ${response.status}: ${target}` };
    const mime = response.headers.get('content-type')?.split(';')[0] || getMimeType(target);
    return {
      ok: true,
      fileName: target.split('?')[0]?.split('/').pop() || `remote-image.${mime.split('/')[1] || 'png'}`,
      mime,
      base64: Buffer.from(await response.arrayBuffer()).toString('base64'),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function createConcurrencyLimiter(limit) {
  let activeCount = 0;
  const queue = [];
  const next = () => {
    if (activeCount >= limit || queue.length === 0) return;
    const task = queue.shift();
    activeCount += 1;
    Promise.resolve()
      .then(task.run)
      .then(task.resolve, task.reject)
      .finally(() => {
        activeCount -= 1;
        next();
      });
  };
  return (run) =>
    new Promise((resolvePromise, reject) => {
      queue.push({ run, resolve: resolvePromise, reject });
      next();
    });
}

function addImageMapEntry(map, key, asset) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return;
  map[trimmed] = asset;
  try {
    map[decodeURI(trimmed)] = asset;
  } catch {
    // ignore malformed URI encodings
  }
}

function safeDecodeUri(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function normalizeImageTarget(target) {
  return String(target || '')
    .replace(/^!\[\[|\]\]$/g, '')
    .replace(/^!\[[^\]]*\]\((.+)\)$/u, '$1')
    .split('|')[0]
    ?.replace(/^</, '')
    .replace(/>$/, '')
    .trim() || '';
}

function extractFrontmatterCover(md) {
  const match = md.match(/^---\n([\s\S]*?)\n---\n*/);
  if (!match?.[1]) return null;
  for (const line of match[1].split('\n')) {
    const index = line.indexOf(':');
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    if (key !== 'cover' && key !== 'Cover' && key !== '封面') continue;
    return normalizeImageTarget(line.slice(index + 1).trim().replace(/^["']|["']$/g, ''));
  }
  return null;
}

function getMimeType(target) {
  switch (extname(target).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'image/png';
  }
}

function buildInjectCoreEvaluateFunction(bundle, markdownSource, imageMap) {
  return `async () => {
    const runnerSource = ${JSON.stringify(bundle)};
    const markdown = ${JSON.stringify(markdownSource)};
    const imageMap = ${JSON.stringify(imageMap)};
    (0, eval)(runnerSource);
    const api = window.__xArticleInjectCore;
    if (!api || typeof api.runMarkdown !== 'function') throw new Error('inject-core runner did not install.');
    return api.runMarkdown({ markdown, imageMap });
  }`;
}

const CREATE_OR_FIND_EDITOR_FUNCTION = `async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function isVisible(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function findEditor() {
    return document.querySelector("[data-contents='true'] [contenteditable='true']")
      || document.querySelector("[contenteditable='true']");
  }
  async function ensureArticleListPage() {
    if (!/\/compose\/articles\/edit\//.test(location.pathname)) return;
    history.pushState({}, '', '/compose/articles');
    window.dispatchEvent(new PopStateEvent('popstate'));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!/\/compose\/articles\/edit\//.test(location.pathname)) return;
      await sleep(100);
    }
    location.href = 'https://x.com/compose/articles';
    await sleep(1500);
  }
  function findCreateButton() {
    const ariaTerms = new Set([
      'create','compose','write','draft','new article','撰写','新建','创建',
      '新規','作成','作成する','redactar','écrire','créer','escribir','schreiben',
      'verfassen','escrever','새 글 작성','글 작성','記事を作成'
    ].map((s) => s.toLowerCase()));
    for (const btn of document.querySelectorAll("button, a[role='button'], [role='link']")) {
      if (!isVisible(btn)) continue;
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase().trim();
      if (aria && ariaTerms.has(aria)) return btn;
    }
    const empty = document.querySelector("a[data-testid='empty_state_button_text']");
    if (empty && isVisible(empty)) return empty;
    for (const a of document.querySelectorAll("a[href*='/compose/articles']")) {
      if (isVisible(a)) return a;
    }
    return null;
  }
  await ensureArticleListPage();
  const button = findCreateButton();
  if (!button) throw new Error('Create button not found.');
  button.click();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (findEditor()) return true;
    await sleep(200);
  }
  throw new Error('Editor did not become ready after clicking create.');
}`;

class StdioMcpClient {
  #proc;
  #nextId = 1;
  #pending = new Map();
  #buffer = '';
  #closed = false;

  constructor(proc) {
    this.#proc = proc;
  }

  static async connect(token) {
    const isWin = platform === 'win32';
    const command = isWin ? env.ComSpec || 'C:\\Windows\\System32\\cmd.exe' : 'npx';
    const args = isWin
      ? ['/d', '/s', '/c', 'npx', '-y', '@playwright/mcp@latest', '--extension']
      : ['-y', '@playwright/mcp@latest', '--extension'];
    const proc = spawn(command, args, {
      stdio: 'pipe',
      env: { ...env, [TOKEN_ENV]: token },
    });
    const client = new StdioMcpClient(proc);
    client.#attach();
    await client.#request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'x-article-upload-inject-core', version: '1.0.0' },
    }, MCP_REQUEST_TIMEOUT_MS);
    client.#writeFrame({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return client;
  }

  async call(toolName, toolArgs, timeoutMs = MCP_REQUEST_TIMEOUT_MS) {
    const result = await this.#request('tools/call', { name: toolName, arguments: toolArgs }, timeoutMs);
    if (result?.error) throw new Error(`MCP error: ${result.error.message || JSON.stringify(result.error)}`);
    return result?.result ?? null;
  }

  async evaluate(functionSource, timeoutMs = MCP_EVALUATE_TIMEOUT_MS) {
    const raw = await this.call('browser_evaluate', { function: functionSource }, timeoutMs);
    return parseToolResult(raw);
  }

  async close() {
    try {
      this.#proc.kill();
    } catch {
      // ignore
    }
  }

  #attach() {
    this.#proc.stdout.on('data', (chunk) => {
      this.#buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const lines = this.#buffer.split('\n');
      this.#buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          if (typeof response.id !== 'number') continue;
          const pending = this.#pending.get(response.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.#pending.delete(response.id);
          pending.resolve(response);
        } catch {
          // ignore non-json stdout
        }
      }
    });
    this.#proc.on('close', () => {
      this.#closed = true;
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('MCP process closed.'));
      }
      this.#pending.clear();
    });
  }

  #request(method, params, timeoutMs) {
    if (this.#closed) return Promise.reject(new Error('MCP client is closed.'));
    const id = this.#nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolvePromise, reject, timer });
      this.#writeFrame({ jsonrpc: '2.0', id, method, params });
    });
  }

  #writeFrame(obj) {
    this.#proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }
}

function parseToolResult(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return result;
  const text = content.find((part) => part?.type === 'text' && typeof part.text === 'string')?.text;
  if (!text) return result;
  const resultMarker = text.indexOf('### Result\n');
  const sliced = resultMarker >= 0 ? text.slice(resultMarker + '### Result\n'.length).split('\n###')[0]?.trim() : text.trim();
  try {
    return JSON.parse(sliced);
  } catch {
    return sliced;
  }
}

await main();
