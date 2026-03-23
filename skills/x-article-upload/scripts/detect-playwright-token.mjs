#!/usr/bin/env node
/**
 * detect-playwright-token.mjs
 *
 * Detects the Playwright MCP Bridge extension token from various sources,
 * mirroring the logic used by the x-article-in-obsidian Obsidian plugin.
 *
 * Detection priority:
 *   0. Skill .env file  (fastest, local cache)
 *   1. PLAYWRIGHT_MCP_EXTENSION_TOKEN environment variable
 *   2. MCP config files (Cursor, Claude, Codex, Gemini, OpenCode, etc.)
 *   3. Browser profile LevelDB scan (Chrome / Edge)
 *
 * Output (stdout): JSON
 *   { token: string, source: string }            — found
 *   { token: null, source: null, error: string } — not found
 *
 * Modes:
 *   node detect-playwright-token.mjs              — detect and print
 *   node detect-playwright-token.mjs --save <TOKEN> — write token to .env and exit
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { env, argv } from 'node:process';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';

const TOKEN_ENV = 'PLAYWRIGHT_MCP_EXTENSION_TOKEN';
const EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';
const TOKEN_RE = /([A-Za-z0-9_-]{40,50})/;
const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOT_ENV_PATH = join(SKILL_DIR, '.env');

// ── --save mode ───────────────────────────────────────────────────────────────
const saveIdx = argv.indexOf('--save');
if (saveIdx !== -1) {
  const tokenToSave = argv[saveIdx + 1];
  if (!tokenToSave || !validateToken(tokenToSave)) {
    out({ token: null, source: null, error: 'Invalid token format. Expected 40-50 char base64url string.' });
    process.exit(1);
  }
  try {
    writeFileSync(DOT_ENV_PATH, `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${tokenToSave}\n`, 'utf-8');
    out({ ok: true, saved: DOT_ENV_PATH, token: tokenToSave });
    process.exit(0);
  } catch (e) {
    out({ ok: false, error: String(e) });
    process.exit(1);
  }
}

// ── Detection mode ────────────────────────────────────────────────────────────

// 0. Skill .env file
if (existsSync(DOT_ENV_PATH)) {
  try {
    for (const line of readFileSync(DOT_ENV_PATH, 'utf-8').split('\n')) {
      const m = line.match(/^\s*PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*["']?([^"'\s]+)["']?\s*$/);
      if (m?.[1] && validateToken(m[1])) found(m[1], '.env');
    }
  } catch { /* ignore */ }
}

// 1. Environment variable
const envToken = env[TOKEN_ENV];
if (envToken && validateToken(envToken)) found(envToken, `env:${TOKEN_ENV}`);

// 2. MCP config files
const home = homedir();
const cwd = process.cwd();
const configPaths = [
  join(home, '.codex', 'config.toml'),
  join(home, '.codex', 'mcp.json'),
  join(home, '.cursor', 'mcp.json'),
  join(home, '.claude.json'),
  join(home, '.gemini', 'settings.json'),
  join(home, '.gemini', 'antigravity', 'mcp_config.json'),
  join(home, '.config', 'opencode', 'opencode.json'),
  join(cwd, '.cursor', 'mcp.json'),
  join(cwd, '.vscode', 'mcp.json'),
  join(cwd, '.opencode', 'opencode.json'),
  join(cwd, '.mcp.json'),
];

for (const p of configPaths) {
  if (!existsSync(p)) continue;
  try {
    const content = readFileSync(p, 'utf-8');
    const token = p.endsWith('.toml') ? extractFromToml(content) : extractFromJson(content);
    if (token) found(token, p);
  } catch { /* ignore */ }
}

// 3. Browser LevelDB scan
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
const keyBuf = Buffer.from('auth-token');
const profiles = ['Default', 'Profile 1', 'Profile 2', 'Profile 3'];

for (const base of bases) {
  for (const profile of profiles) {
    const dir = join(base, profile, 'Local Storage', 'leveldb');
    if (!existsSync(dir)) continue;

    let files;
    try {
      files = readdirSync(dir)
        .filter(f => f.endsWith('.ldb') || f.endsWith('.log'))
        .map(f => join(dir, f))
        .sort((a, b) => {
          try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
        });
    } catch { continue; }

    for (const filePath of files) {
      let data;
      try { data = readFileSync(filePath); } catch { continue; }
      if (data.indexOf(extIdBuf) === -1) continue;

      let cursor = 0;
      while (true) {
        const keyPos = data.indexOf(keyBuf, cursor);
        if (keyPos === -1) break;
        const contextStart = Math.max(0, keyPos - 500);
        const extPos = data.indexOf(extIdBuf, contextStart);
        if (extPos !== -1 && extPos < keyPos) {
          const candidate = data
            .subarray(keyPos + keyBuf.length, keyPos + keyBuf.length + 200)
            .toString('latin1')
            .match(TOKEN_RE)?.[1];
          if (candidate && validateToken(candidate)) found(candidate, `browser:${profile}`);
        }
        cursor = keyPos + 1;
      }
    }
  }
}

// Not found
out({ token: null, source: null, error: 'No Playwright MCP Bridge token found.' });
process.exit(1);

// ── Helpers ───────────────────────────────────────────────────────────────────

function found(token, source) {
  out({ token, source });
  process.exit(0);
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function validateToken(token) {
  try {
    const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(normalized, 'base64');
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
