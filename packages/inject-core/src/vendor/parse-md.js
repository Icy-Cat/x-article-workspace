// Vendored from G:\Projects\0Tools\x-article-workspace\skills\x-article-upload\
//   scripts\api-mode\parse-md.mjs (commit context: 2026-05-10)
//
// Adapted for browser extension: no node:fs, no path resolution.
// `parseMarkdownText(raw)` takes the raw markdown string directly.
// Frontmatter cover field is preserved as-is (string), the caller decides
// whether to fetch it (network) or drop it (local path, v1).

export function parseMarkdownText(raw) {
  const text = String(raw == null ? "" : raw).replace(/\r\n/g, "\n");

  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n*/);
  const meta = {};
  if (fmMatch) {
    for (const line of fmMatch[1].split("\n")) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      meta[line.slice(0, i).trim()] = line
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }
  // Frontmatter title/cover with Chinese aliases. Frontmatter wins over
  // body-derived fallback below.
  let title = meta.title || meta.Title || meta["标题"] || null;
  let cover = meta.cover || meta.Cover || meta["封面"] || null;
  let titleFromFrontmatter = !!title;
  if (cover) {
    cover = cover
      .replace(/^!\[\[|\]\]$/g, "")
      .replace(/^!\[[^\]]*\]\(([^)]+)\)$/u, "$1")
      .trim();
  }
  const body = (fmMatch ? text.slice(fmMatch[0].length) : text).trim();

  const atomics = findAtomics(body);
  let cursor = 0;
  const out = [];
  for (const a of atomics) {
    if (a.start > cursor) out.push(...textChunkToSegments(body.slice(cursor, a.start)));
    out.push(a.seg);
    cursor = a.end;
  }
  if (cursor < body.length) out.push(...textChunkToSegments(body.slice(cursor)));

  // Fallback: when no frontmatter title, promote the FIRST header-one
  // segment to title AND remove it from the body — otherwise it would
  // appear twice (once as X's article title, once as an H1 inside body).
  if (!title) {
    const firstH1Idx = out.findIndex((s) => s.type === "text" && s.kind === "header-one");
    if (firstH1Idx >= 0) {
      title = out[firstH1Idx].text || null;
      if (title) {
        out.splice(firstH1Idx, 1);
        downgradeBodyHeadings(out);
      }
    }
  }

  // Fallback: when no frontmatter cover, use the FIRST image's source as
  // cover. Keep the image in body — the injector uploads it normally,
  // uses its mediaId for the cover endpoint, then deletes the atomic
  // from body after the cover is bound (so it doesn't render twice).
  if (!cover) {
    const firstImg = out.find((s) => s.type === "image" && s.source);
    if (firstImg) cover = firstImg.source;
  }

  return { title, cover, segments: out, titleFromFrontmatter };
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
  const tableRe =
    /^(?:[ \t]*\|.+\|[ \t]*\n)(?:[ \t]*\|[ \t:|\-]+\|[ \t]*\n)((?:[ \t]*\|.+\|[ \t]*\n?)*)/gm;
  while ((m = tableRe.exec(text)) !== null) {
    if (found.some((f) => m.index >= f.start && m.index < f.end)) continue;
    const table = parseMarkdownTable(m[0]);
    if (!table) continue;
    found.push({ start: m.index, end: m.index + m[0].length, seg: { type: "table", ...table } });
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
  // Image with x.com/.../status URL inside ![](...) — also a tweet embed.
  const imgLineRe = /^[ \t]*!\[([^\]]*)\]\(([^)]+)\)[ \t]*$/gm;
  while ((m = imgLineRe.exec(text)) !== null) {
    if (found.some((f) => m.index >= f.start && m.index < f.end)) continue;
    const url = m[2].trim();
    const tweetMatch = url.match(
      /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/(\d+)/,
    );
    if (tweetMatch) {
      found.push({
        start: m.index,
        end: m.index + m[0].length,
        seg: { type: "tweet", tweetId: tweetMatch[1] },
      });
    } else {
      found.push({
        start: m.index,
        end: m.index + m[0].length,
        seg: { type: "image", source: url, alt: m[1].trim() },
      });
    }
  }
  // Markdown-link form on its own line — only treat as tweet if URL is a
  // tweet status URL. Non-tweet links fall through to inline link parsing
  // inside textChunkToSegments and end up as <a href> inside a paragraph.
  const linkLineRe = /^[ \t]*\[([^\]]*)\]\(([^)]+)\)[ \t]*$/gm;
  while ((m = linkLineRe.exec(text)) !== null) {
    if (found.some((f) => m.index >= f.start && m.index < f.end)) continue;
    const url = m[2].trim();
    const tweetMatch = url.match(
      /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/(\d+)/,
    );
    if (tweetMatch) {
      found.push({
        start: m.index,
        end: m.index + m[0].length,
        seg: { type: "tweet", tweetId: tweetMatch[1] },
      });
    }
    // else: not a tweet link — leave for inline processing.
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

function parseMarkdownTable(block) {
  const splitCells = (line) => {
    const PLACEHOLDER = "\u0000";
    const escaped = line.replace(/\\\|/g, PLACEHOLDER);
    let parts = escaped.split("|");
    if (parts[0] !== undefined && parts[0].trim() === "") parts = parts.slice(1);
    if (parts.length && parts[parts.length - 1].trim() === "") parts = parts.slice(0, -1);
    return parts.map((c) => c.replace(new RegExp(PLACEHOLDER, "g"), "|").trim());
  };
  const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const headers = splitCells(lines[0]);
  const alignSpec = splitCells(lines[1]);
  if (!alignSpec.every((s) => /^:?-+:?$/.test(s))) return null;
  const alignments = alignSpec.map((s) => {
    const left = s.startsWith(":");
    const right = s.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
  const rows = lines.slice(2).map((l) => {
    const cells = splitCells(l);
    while (cells.length < headers.length) cells.push("");
    return cells.slice(0, headers.length);
  });
  return { headers, alignments, rows };
}

function textChunkToSegments(chunk) {
  const lines = chunk.split("\n");
  const segs = [];
  let para = [];
  function flushPara() {
    if (!para.length) return;
    const t = para.join("\n").trim();
    if (t) segs.push(makeTextSeg("unstyled", t));
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

const HEADING_DOWNGRADE = {
  "header-two": "header-one",
  "header-three": "header-two",
  "header-four": "header-three",
  "header-five": "header-four",
  "header-six": "header-five",
};

function downgradeBodyHeadings(segments) {
  for (const seg of segments) {
    if (seg?.type !== "text") continue;
    if (HEADING_DOWNGRADE[seg.kind]) seg.kind = HEADING_DOWNGRADE[seg.kind];
  }
}

export function parseMarkdownInline(rawText) {
  const out = { text: "", inlineStyleRanges: [], links: [] };
  rawText = String(rawText == null ? "" : rawText);
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
    if (rawText.startsWith("**", i) || rawText.startsWith("__", i)) {
      const mark = rawText.slice(i, i + 2);
      const end = rawText.indexOf(mark, i + 2);
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
        const inner = rawText.slice(i + 1, end);
        const start = out.text.length;
        out.text += inner;
        out.inlineStyleRanges.push({ offset: start, length: inner.length, style: "Code" });
        i = end + 1;
        continue;
      }
    }
    out.text += c;
    i++;
  }
  return out;
}

function makeTextSeg(kind, rawText) {
  const out = parseMarkdownInline(rawText);
  return { type: "text", kind, ...out };
}
