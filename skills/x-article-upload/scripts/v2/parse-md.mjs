// Parse markdown to ordered segments — designed for X article RawDraftContentState.
//
// Output:
//   { title, segments: [
//       { type:'text', kind:'unstyled'|'header-one'|...|'blockquote'|'unordered-list-item'|'ordered-list-item',
//         text: '...', inlineStyleRanges: [...], entityRanges: [...] (LINK only),
//         links: [{offset,length,url}] }
//       { type:'image', source: '<absolute path or http url>', alt: '...' }
//       { type:'code', language: 'python', code: '...' }
//       { type:'divider' }
//       { type:'tweet', tweetId: '...' }
//     ] }
//
// 注意：这一版只处理常见 markdown 子集。复杂语法（表格、嵌套列表、HTML）暂不支持。
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

export function parseMarkdown(filePath) {
  const raw = readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
  const baseDir = dirname(resolve(filePath));

  // 1. Frontmatter
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
  let body = (fmMatch ? raw.slice(fmMatch[0].length) : raw).trim();

  // 2. Find all "block-level atomic" segments (code, divider, image, tweet, image-only-line)
  //    and split text in between
  const segments = [];

  function findAtomics(text) {
    const found = [];
    // Code blocks
    const codeRe = /```([^\n`]*)\n([\s\S]*?)```/g;
    let m;
    while ((m = codeRe.exec(text)) !== null) {
      found.push({
        start: m.index,
        end: m.index + m[0].length,
        seg: { type: "code", language: (m[1] || "").trim(), code: (m[2] || "").replace(/\n$/, "") },
      });
    }
    // Dividers
    const hrRe = /^(?: {0,3})(?:-{3,}|\*{3,}|_{3,})(?:[ \t]*)$/gm;
    while ((m = hrRe.exec(text)) !== null) {
      if (!found.some((f) => m.index >= f.start && m.index < f.end))
        found.push({ start: m.index, end: m.index + m[0].length, seg: { type: "divider" } });
    }
    // Bare tweet URLs on their own line
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
    // Image-only lines: `![alt](src)` 单独成行
    const imgLineRe = /^[ \t]*!\[([^\]]*)\]\(([^)]+)\)[ \t]*$/gm;
    while ((m = imgLineRe.exec(text)) !== null) {
      if (!found.some((f) => m.index >= f.start && m.index < f.end))
        found.push({
          start: m.index,
          end: m.index + m[0].length,
          seg: { type: "image", source: m[2].trim(), alt: m[1].trim() },
        });
    }
    // Wikilink images: ![[file]]
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

  const atomics = findAtomics(body);

  // 3. Walk: text-between-atomics → text segments; atomic → atomic segments
  let cursor = 0;
  const out = [];
  for (const a of atomics) {
    if (a.start > cursor) {
      const chunk = body.slice(cursor, a.start);
      out.push(...textChunkToSegments(chunk));
    }
    // Resolve image source to absolute path if local
    if (a.seg.type === "image" && !/^https?:\/\//i.test(a.seg.source)) {
      a.seg.source = resolve(baseDir, a.seg.source);
    }
    out.push(a.seg);
    cursor = a.end;
  }
  if (cursor < body.length) {
    out.push(...textChunkToSegments(body.slice(cursor)));
  }

  return { title, segments: out, baseDir };
}

// ───────────────────────────────────────────────────────────────────────────
// Text chunk → array of text segments (one per markdown line/paragraph)
// ───────────────────────────────────────────────────────────────────────────
function textChunkToSegments(chunk) {
  const lines = chunk.split("\n");
  const segs = [];
  let listType = null; // 'ul' | 'ol'
  let para = []; // paragraph buffer
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
      listType = null;
      continue;
    }
    // Heading
    let m;
    if ((m = trimmed.match(/^(#{1,6})\s+(.+)$/))) {
      flushPara();
      const kindMap = ["", "header-one", "header-two", "header-three", "header-four", "header-five", "header-six"];
      segs.push(makeTextSeg(kindMap[m[1].length], m[2].trim()));
      continue;
    }
    // Blockquote
    if ((m = trimmed.match(/^>\s+(.+)$/))) {
      flushPara();
      segs.push(makeTextSeg("blockquote", m[1].trim()));
      continue;
    }
    // Unordered list item
    if ((m = trimmed.match(/^[-*+]\s+(.+)$/))) {
      flushPara();
      segs.push(makeTextSeg("unordered-list-item", m[1].trim()));
      listType = "ul";
      continue;
    }
    // Ordered list item
    if ((m = trimmed.match(/^\d+\.\s+(.+)$/))) {
      flushPara();
      segs.push(makeTextSeg("ordered-list-item", m[1].trim()));
      listType = "ol";
      continue;
    }
    // Plain paragraph line
    para.push(trimmed);
  }
  flushPara();
  return segs;
}

// ───────────────────────────────────────────────────────────────────────────
// Inline parsing: bold/italic/strike + links → inlineStyleRanges + entityRanges (LINK)
// ───────────────────────────────────────────────────────────────────────────
function makeTextSeg(kind, rawText) {
  // Walk the string left-to-right, building plain text + ranges as we go.
  // 支持：**bold**, *italic*, ~~strike~~, `code`(忽略代码片段格式，原样保留), [text](url)
  const out = { text: "", inlineStyleRanges: [], links: [] };
  let i = 0;
  const n = rawText.length;
  while (i < n) {
    const c = rawText[i];
    // Link: [text](url)
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
    // ***bold-italic***
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
    // **bold**
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
    // ~~strike~~
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
    // *italic* or _italic_
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
    // `inline code` — strip backticks, no special style (X article doesn't have inline code style?)
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
