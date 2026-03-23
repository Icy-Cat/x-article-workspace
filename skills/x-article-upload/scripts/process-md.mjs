#!/usr/bin/env node
/**
 * process-md.mjs
 * Usage: node process-md.mjs <file.md>
 *
 * Reads a local Markdown file and outputs a JSON payload
 * suitable for injecting into X (Twitter) article editor via browser_evaluate.
 *
 * Output JSON shape:
 * {
 *   html: string,       // HTML to paste into editor
 *   markdown: string,   // processed markdown (frontmatter stripped)
 *   title: string|null, // from frontmatter `title` field
 *   cover: null,        // image cover (not handled here)
 *   items: []           // special items (code blocks extracted separately)
 * }
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node process-md.mjs <file.md>');
  process.exit(1);
}

const raw = readFileSync(resolve(filePath), 'utf-8').replace(/\r\n/g, '\n');

// ── 1. Strip frontmatter and extract title ─────────────────────────────────
function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n*/);
  if (!match) return { meta: {}, body: text };

  const body = text.slice(match[0].length).trim();
  const meta = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
    meta[key] = value;
  }
  return { meta, body };
}

const { meta, body } = parseFrontmatter(raw);
const title = meta.title || meta.Title || null;

// ── 2. Use filename as title if no heading present ─────────────────────────
let markdown = body;
if (title && !/^\s*#\s+/m.test(markdown)) {
  // leave title to be set via title field, don't prepend heading
}

// ── 3. Extract special items (code blocks) and replace with markers ────────
const items = [];
let processedMarkdown = markdown;

// Extract code blocks
const codePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
const segments = [];
let match;
while ((match = codePattern.exec(markdown)) !== null) {
  segments.push({
    type: 'code',
    start: match.index,
    end: match.index + match[0].length,
    language: (match[1] || '').trim(),
    code: (match[2] || '').replace(/\n$/, ''),
  });
}

// Extract HR dividers (outside code blocks)
const dividerPattern = /^(?: {0,3})(?:(?:-{3,})|(?:\*{3,})|(?:_{3,}))(?:[ \t]*)$/gm;
while ((match = dividerPattern.exec(markdown)) !== null) {
  const start = match.index;
  const end = match.index + match[0].length;
  if (!segments.some(s => start >= s.start && start < s.end)) {
    segments.push({ type: 'divider', start, end });
  }
}

segments.sort((a, b) => a.start - b.start);

for (let i = segments.length - 1; i >= 0; i--) {
  const seg = segments[i];
  const marker = `MPH_MARKER_${i + 1}`;
  processedMarkdown =
    processedMarkdown.slice(0, seg.start) + `\n${marker}\n` + processedMarkdown.slice(seg.end);
  if (seg.type === 'code') {
    items.unshift({ type: 'code', marker, language: seg.language, code: seg.code });
  } else if (seg.type === 'divider') {
    items.unshift({ type: 'divider', marker });
  }
}

// ── 4. Convert processed markdown to HTML ─────────────────────────────────
function mdToHtml(md) {
  let html = md;

  // Preserve markers before processing
  const markerPlaceholders = {};
  html = html.replace(/MPH_MARKER_\d+/g, m => {
    const key = `___MARKER_${Object.keys(markerPlaceholders).length}___`;
    markerPlaceholders[key] = m;
    return key;
  });

  // Headings
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Bold & italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Images (simplified — no base64 conversion here)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');

  // Unordered lists (simple single-level)
  html = html.replace(/(^(?:[ \t]*[-*+][ \t].+\n?)+)/gm, block => {
    const items = block.trim().split('\n').map(line =>
      `<li>${line.replace(/^[ \t]*[-*+][ \t]/, '').trim()}</li>`
    ).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists
  html = html.replace(/(^(?:[ \t]*\d+\.[ \t].+\n?)+)/gm, block => {
    const items = block.trim().split('\n').map(line =>
      `<li>${line.replace(/^[ \t]*\d+\.[ \t]/, '').trim()}</li>`
    ).join('');
    return `<ol>${items}</ol>`;
  });

  // Blockquotes
  html = html.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');

  // Paragraphs: wrap non-tagged lines
  html = html.split('\n\n').map(block => {
    block = block.trim();
    if (!block) return '';
    if (/^<(h[1-6]|ul|ol|blockquote|p)/.test(block)) return block;
    if (/^___MARKER_/.test(block)) return block;
    return `<p>${block.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  // Restore markers
  for (const [key, val] of Object.entries(markerPlaceholders)) {
    html = html.split(key).join(val);
  }

  return html.trim();
}

const html = mdToHtml(processedMarkdown);

const payload = {
  html,
  markdown: processedMarkdown,
  title,
  cover: null,
  items,
};

process.stdout.write(JSON.stringify(payload, null, 2));
