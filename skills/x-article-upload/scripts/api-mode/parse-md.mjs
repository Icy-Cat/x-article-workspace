// Parse markdown to ordered segments — designed for X article RawDraftContentState.
// Identical to scripts/v2/parse-md.mjs (the bb-browser spike); kept here so api-mode/
// is self-contained and survives if the spike directory is dropped.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

export function parseMarkdown(filePath) {
  const raw = readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
  const baseDir = dirname(resolve(filePath));

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n*/);
  const meta = {};
  if (fmMatch) {
    for (const line of fmMatch[1].split("\n")) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  const title = meta.title || meta.Title || null;
  const body = (fmMatch ? raw.slice(fmMatch[0].length) : raw).trim();

  const atomics = findAtomics(body);

  let cursor = 0;
  const out = [];
  for (const a of atomics) {
    if (a.start > cursor) out.push(...textChunkToSegments(body.slice(cursor, a.start)));
    if (a.seg.type === "image" && !/^https?:\/\//i.test(a.seg.source)) {
      a.seg.source = resolve(baseDir, a.seg.source);
    }
    out.push(a.seg);
    cursor = a.end;
  }
  if (cursor < body.length) out.push(...textChunkToSegments(body.slice(cursor)));

  return { title, segments: out, baseDir };
}

function findAtomics(text) {
  const found = [];
  let m;
  const codeRe = /```([^\n`]*)\n([\s\S]*?)```/g;
  while ((m = codeRe.exec(text)) !== null) {
    found.push({
      start: m.index,
      end: m.index + m[0].length,
      seg: { type: "code", language: (m[1] || "").trim(), code: (m[2] || "").replace(/\n$/, "") },
    });
  }
  const hrRe = /^(?: {0,3})(?:-{3,}|\*{3,}|_{3,})(?:[ \t]*)$/gm;
  while ((m = hrRe.exec(text)) !== null) {
    if (!found.some((f) => m.index >= f.start && m.index < f.end))
      found.push({ start: m.index, end: m.index + m[0].length, seg: { type: "divider" } });
  }
  const tweetUrlRe =
    /^(?: {0,3})https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/(\d+)(?:[?#][^\s]*)?\s*$/gm;
  while ((m = tweetUrlRe.exec(text)) !== null) {
    if (!found.some((f) => m.index >= f.start && m.index < f.end))
      found.push({
        start: m.index,
        end: m.index + m[0].length,
        seg: { type: "tweet", tweetId: m[1] },
      });
  }
  const imgLineRe = /^[ \t]*!\[([^\]]*)\]\(([^)]+)\)[ \t]*$/gm;
  while ((m = imgLineRe.exec(text)) !== null) {
    if (!found.some((f) => m.index >= f.start && m.index < f.end))
      found.push({
        start: m.index,
        end: m.index + m[0].length,
        seg: { type: "image", source: m[2].trim(), alt: m[1].trim() },
      });
  }
  const wikiRe = /^[ \t]*!\[\[([^\]]+)\]\][ \t]*$/gm;
  while ((m = wikiRe.exec(text)) !== null) {
    if (!found.some((f) => m.index >= f.start && m.index < f.end))
      found.push({
        start: m.index,
        end: m.index + m[0].length,
        seg: { type: "image", source: m[1].trim(), alt: "" },
      });
  }
  return found.sort((a, b) => a.start - b.start);
}

function textChunkToSegments(chunk) {
  const lines = chunk.split("\n");
  const segs = [];
  let para = [];
  function flushPara() {
    if (!para.length) return;
    const text = para.join("\n").trim();
    if (text) segs.push(makeTextSeg("unstyled", text));
    para = [];
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      continue;
    }
    let m;
    if ((m = trimmed.match(/^(#{1,6})\s+(.+)$/))) {
      flushPara();
      const kindMap = ["", "header-one", "header-two", "header-three", "header-four", "header-five", "header-six"];
      segs.push(makeTextSeg(kindMap[m[1].length], m[2].trim()));
      continue;
    }
    if ((m = trimmed.match(/^>\s+(.+)$/))) {
      flushPara();
      segs.push(makeTextSeg("blockquote", m[1].trim()));
      continue;
    }
    if ((m = trimmed.match(/^[-*+]\s+(.+)$/))) {
      flushPara();
      segs.push(makeTextSeg("unordered-list-item", m[1].trim()));
      continue;
    }
    if ((m = trimmed.match(/^\d+\.\s+(.+)$/))) {
      flushPara();
      segs.push(makeTextSeg("ordered-list-item", m[1].trim()));
      continue;
    }
    para.push(trimmed);
  }
  flushPara();
  return segs;
}

function makeTextSeg(kind, rawText) {
  const out = { text: "", inlineStyleRanges: [], links: [] };
  let i = 0;
  const n = rawText.length;
  while (i < n) {
    const c = rawText[i];
    if (c === "[") {
      const m = rawText.slice(i).match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (m) {
        const start = out.text.length;
        out.text += m[1];
        out.links.push({ offset: start, length: m[1].length, url: m[2] });
        i += m[0].length;
        continue;
      }
    }
    if (rawText.startsWith("***", i)) {
      const end = rawText.indexOf("***", i + 3);
      if (end > 0) {
        const inner = rawText.slice(i + 3, end);
        const start = out.text.length;
        out.text += inner;
        out.inlineStyleRanges.push({ offset: start, length: inner.length, style: "Bold" });
        out.inlineStyleRanges.push({ offset: start, length: inner.length, style: "Italic" });
        i = end + 3;
        continue;
      }
    }
    if (rawText.startsWith("**", i)) {
      const end = rawText.indexOf("**", i + 2);
      if (end > 0) {
        const inner = rawText.slice(i + 2, end);
        const start = out.text.length;
        out.text += inner;
        out.inlineStyleRanges.push({ offset: start, length: inner.length, style: "Bold" });
        i = end + 2;
        continue;
      }
    }
    if (rawText.startsWith("~~", i)) {
      const end = rawText.indexOf("~~", i + 2);
      if (end > 0) {
        const inner = rawText.slice(i + 2, end);
        const start = out.text.length;
        out.text += inner;
        out.inlineStyleRanges.push({ offset: start, length: inner.length, style: "Strikethrough" });
        i = end + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && rawText[i + 1] !== c) {
      const end = rawText.indexOf(c, i + 1);
      if (end > 0 && rawText[end + 1] !== c) {
        const inner = rawText.slice(i + 1, end);
        const start = out.text.length;
        out.text += inner;
        out.inlineStyleRanges.push({ offset: start, length: inner.length, style: "Italic" });
        i = end + 1;
        continue;
      }
    }
    if (c === "`") {
      const end = rawText.indexOf("`", i + 1);
      if (end > 0) {
        out.text += rawText.slice(i + 1, end);
        i = end + 1;
        continue;
      }
    }
    out.text += c;
    i++;
  }
  return { type: "text", kind, ...out };
}
