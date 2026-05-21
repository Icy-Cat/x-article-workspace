// Vendored from G:\Projects\0Tools\x-article-workspace\skills\x-article-upload\
//   scripts\api-mode\render-table.mjs (commit context: 2026-05-10)
//
// Adapted for browser extension: extracted from the bridge.evalJS template
// literal so it runs natively in the content script. Returns a base64 PNG.

import { parseMarkdownInline } from "./parse-md.js";

const MAX_TABLE_W = 1080;
const PAD_X = 16;
const PAD_Y = 14;
const HEAD_PAD_Y = 16;
const FONT_SIZE = 26;
const HEAD_FONT_SIZE = 26;
const LINE_HEIGHT = Math.round(FONT_SIZE * 1.5);
const FONT_FAMILY =
  '-apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';
const FONT_BODY = `${FONT_SIZE}px ${FONT_FAMILY}`;
const FONT_HEAD = `600 ${HEAD_FONT_SIZE}px ${FONT_FAMILY}`;
const COLOR_TEXT = "#0f1419";
const COLOR_HEAD = "#536471";
const COLOR_HEAD_BG = "#f7f8fa";
const COLOR_BORDER_OUTER = "#cfd9de";
const COLOR_BORDER_INNER = "#e6e9ec";
const BG = "#ffffff";
const RADIUS = 12;
const OUTER_PAD = 32;
const COL_MIN_W = 80;
const COLOR_LINK = "#1d9bf0";
const COLOR_CODE_BG = "#eff3f4";
const COLOR_CODE_TEXT = "#0f1419";
const FONT_CODE =
  `${Math.round(FONT_SIZE * 0.92)}px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`;

export function inlineMarkdownSpansForTable(rawText) {
  const parsed = parseMarkdownInline(rawText);
  const text = parsed.text || "";
  if (!text) return [{ text: "" }];
  const styleAt = new Array(text.length).fill(null).map(() => ({
    bold: false,
    italic: false,
    strike: false,
    code: false,
    href: "",
  }));
  const applyRange = (offset, length, patch) => {
    const end = Math.min(text.length, offset + length);
    for (let i = Math.max(0, offset); i < end; i++) {
      Object.assign(styleAt[i], patch);
    }
  };
  for (const r of parsed.inlineStyleRanges || []) {
    if (r.style === "Bold") applyRange(r.offset, r.length, { bold: true });
    else if (r.style === "Italic") applyRange(r.offset, r.length, { italic: true });
    else if (r.style === "Strikethrough") applyRange(r.offset, r.length, { strike: true });
    else if (r.style === "Code") applyRange(r.offset, r.length, { code: true });
  }
  // Table output is a static PNG. Keep only the link display text from
  // `[text](url)` and intentionally discard URL/link styling so the image
  // does not suggest the text is clickable.

  const spans = [];
  const push = (value, style = {}) => {
    if (!value) return;
    const last = spans[spans.length - 1];
    if (
      last &&
      !!last.bold === !!style.bold &&
      !!last.italic === !!style.italic &&
      !!last.strike === !!style.strike &&
      !!last.code === !!style.code &&
      (last.href || "") === (style.href || "")
    ) {
      last.text += value;
      return;
    }
    spans.push({ text: value, ...style });
  };
  for (let i = 0; i < text.length; i++) {
    push(text[i], styleAt[i]);
  }
  return spans.length ? spans : [{ text: "" }];
}

export async function renderTableToImage(table, opts = {}) {
  const dpr = opts.dpr || 2;
  const fileName = opts.fileName || `table-${Date.now()}.png`;

  const meas = document.createElement("canvas").getContext("2d");
  const spanFont = (span, baseFont, isHead) => {
    if (span.code) return FONT_CODE;
    const size = isHead ? HEAD_FONT_SIZE : FONT_SIZE;
    const weight = isHead || span.bold ? "600 " : "";
    const style = span.italic ? "italic " : "";
    return `${style}${weight}${size}px ${FONT_FAMILY}`;
  };
  const spanColor = (span, baseColor) => {
    if (span.href) return COLOR_LINK;
    if (span.code) return COLOR_CODE_TEXT;
    return baseColor;
  };
  const measureText = (text, font) => {
    meas.font = font;
    return meas.measureText(text).width;
  };
  const measureSpans = (spans, baseFont, isHead) =>
    spans.reduce((sum, span) => sum + measureText(span.text, spanFont(span, baseFont, isHead)), 0);
  const pushWrappedChar = (lines, line, ch, span, baseFont, isHead, maxW) => {
    const font = spanFont(span, baseFont, isHead);
    const chW = measureText(ch, font);
    const wouldOverflow = line.width + chW > maxW && line.spans.length > 0;
    const target = wouldOverflow ? { spans: [], width: 0 } : line;
    if (wouldOverflow) lines.push(target);
    const last = target.spans[target.spans.length - 1];
    if (
      last &&
      !!last.bold === !!span.bold &&
      !!last.italic === !!span.italic &&
      !!last.strike === !!span.strike &&
      !!last.code === !!span.code &&
      (last.href || "") === (span.href || "")
    ) {
      last.text += ch;
    } else {
      target.spans.push({ ...span, text: ch });
    }
    target.width += chW;
    return target;
  };
  const wrapText = (text, maxW, baseFont, isHead = false) => {
    const lines = [];
    const explicitLines = String(text == null ? "" : text).split(/\r?\n|<br\s*\/?\s*>/i);
    for (const raw of explicitLines) {
      if (!raw) {
        lines.push({ spans: [{ text: "" }], width: 0 });
        continue;
      }
      const spans = inlineMarkdownSpansForTable(raw);
      const rawW = measureSpans(spans, baseFont, isHead);
      if (rawW <= maxW) {
        lines.push({ spans, width: rawW });
        continue;
      }
      let line = { spans: [], width: 0 };
      lines.push(line);
      for (const span of spans) {
        for (const ch of span.text) {
          line = pushWrappedChar(lines, line, ch, span, baseFont, isHead, maxW);
        }
      }
    }
    return lines.length ? lines : [{ spans: [{ text: "" }], width: 0 }];
  };

  const colCount = table.headers.length;
  const naturalContentW = new Array(colCount).fill(0);
  const naturalize = (text, col, font, isHead) => {
    const lines = String(text == null ? "" : text).split(/\r?\n|<br\s*\/?\s*>/i);
    for (const ln of lines) {
      const w = measureSpans(inlineMarkdownSpansForTable(ln), font, isHead);
      if (w > naturalContentW[col]) naturalContentW[col] = w;
    }
  };
  table.headers.forEach((h, i) => naturalize(h, i, FONT_HEAD, true));
  for (const row of table.rows) {
    for (let i = 0; i < colCount; i++) naturalize(row[i] || "", i, FONT_BODY, false);
  }

  const padBudget = colCount * PAD_X * 2;
  const contentBudget = MAX_TABLE_W - padBudget;
  const naturalCapped = naturalContentW.map((w) => Math.max(COL_MIN_W, Math.ceil(w)));
  const sumNat = naturalCapped.reduce((a, b) => a + b, 0);
  let contentWidths;
  if (sumNat <= contentBudget) {
    contentWidths = naturalCapped;
  } else {
    const scale = contentBudget / sumNat;
    contentWidths = naturalCapped.map((w) => Math.max(COL_MIN_W, Math.floor(w * scale)));
    let drift = contentBudget - contentWidths.reduce((a, b) => a + b, 0);
    const order = contentWidths
      .map((w, i) => [w, i])
      .sort((a, b) => b[0] - a[0])
      .map((x) => x[1]);
    let k = 0;
    while (drift !== 0) {
      const idx = order[k % order.length];
      if (drift > 0) {
        contentWidths[idx] += 1;
        drift -= 1;
      } else if (contentWidths[idx] > COL_MIN_W) {
        contentWidths[idx] -= 1;
        drift += 1;
      }
      k += 1;
      if (k > 100000) break;
    }
  }
  const colWidths = contentWidths.map((w) => w + PAD_X * 2);

  const rowLines = [];
  const rowHeightFor = (linesPerCell, basePad) => {
    const maxLines = linesPerCell.reduce((m, ls) => Math.max(m, ls.length), 1);
    return maxLines * LINE_HEIGHT + basePad * 2;
  };
  const headerLines = table.headers.map((h, i) =>
    wrapText(h, colWidths[i] - PAD_X * 2, FONT_HEAD, true),
  );
  const headerHeight = rowHeightFor(headerLines, HEAD_PAD_Y);
  rowLines.push({ kind: "head", cells: headerLines, height: headerHeight });
  for (const row of table.rows) {
    const cells = row
      .slice(0, colCount)
      .concat(new Array(Math.max(0, colCount - row.length)).fill(""))
      .map((c, i) => wrapText(c, colWidths[i] - PAD_X * 2, FONT_BODY, false));
    rowLines.push({ kind: "body", cells, height: rowHeightFor(cells, PAD_Y) });
  }

  const tableW = colWidths.reduce((a, b) => a + b, 0);
  const tableH = rowLines.reduce((a, r) => a + r.height, 0);
  const canvasW = (tableW + OUTER_PAD * 2) * dpr;
  const canvasH = (tableH + OUTER_PAD * 2) * dpr;

  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = true;
  ctx.textBaseline = "top";

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvasW, canvasH);

  const tx = OUTER_PAD;
  const ty = OUTER_PAD;

  const roundedRectPath = (x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };

  const rowY = [];
  {
    let y = ty;
    for (const r of rowLines) {
      rowY.push(y);
      y += r.height;
    }
  }

  ctx.save();
  roundedRectPath(tx, ty, tableW, tableH, RADIUS);
  ctx.clip();
  ctx.fillStyle = COLOR_HEAD_BG;
  ctx.fillRect(tx, ty, tableW, headerHeight);

  const alignToX = (align, colX, colW, lineW) => {
    if (align === "center") return colX + (colW - lineW) / 2;
    if (align === "right") return colX + colW - PAD_X - lineW;
    return colX + PAD_X;
  };
  const drawLine = (line, x, y, baseFont, baseColor, isHead) => {
    let xCur = x;
    for (const span of line.spans) {
      const font = spanFont(span, baseFont, isHead);
      const width = measureText(span.text, font);
      ctx.font = font;
      ctx.fillStyle = spanColor(span, baseColor);
      if (span.code) {
        ctx.fillStyle = COLOR_CODE_BG;
        ctx.fillRect(xCur - 3, y - 1, width + 6, LINE_HEIGHT - 4);
        ctx.fillStyle = COLOR_CODE_TEXT;
      }
      ctx.fillText(span.text, xCur, y);
      if (span.strike) {
        ctx.strokeStyle = spanColor(span, baseColor);
        ctx.beginPath();
        ctx.moveTo(xCur, y + LINE_HEIGHT * 0.55);
        ctx.lineTo(xCur + width, y + LINE_HEIGHT * 0.55);
        ctx.stroke();
      }
      xCur += width;
    }
  };
  for (let r = 0; r < rowLines.length; r++) {
    const row = rowLines[r];
    const isHead = row.kind === "head";
    let cx = tx;
    const padTop = isHead ? HEAD_PAD_Y : PAD_Y;
    for (let c = 0; c < colCount; c++) {
      const cw = colWidths[c];
      const lines = row.cells[c];
      const align = table.alignments[c] || "left";
      let yLine = rowY[r] + padTop;
      for (const ln of lines) {
        drawLine(
          ln,
          alignToX(align, cx, cw, ln.width),
          yLine,
          isHead ? FONT_HEAD : FONT_BODY,
          isHead ? COLOR_HEAD : COLOR_TEXT,
          isHead,
        );
        yLine += LINE_HEIGHT;
      }
      cx += cw;
    }
  }

  ctx.strokeStyle = COLOR_BORDER_INNER;
  ctx.lineWidth = 1;
  for (let r = 0; r < rowLines.length - 1; r++) {
    const y = rowY[r] + rowLines[r].height + 0.5;
    ctx.beginPath();
    ctx.moveTo(tx, y);
    ctx.lineTo(tx + tableW, y);
    ctx.stroke();
  }
  if (rowLines.length > 0) {
    const y = rowY[0] + rowLines[0].height + 0.5;
    ctx.strokeStyle = COLOR_BORDER_OUTER;
    ctx.beginPath();
    ctx.moveTo(tx, y);
    ctx.lineTo(tx + tableW, y);
    ctx.stroke();
    ctx.strokeStyle = COLOR_BORDER_INNER;
  }
  let cx = tx;
  for (let c = 0; c < colCount - 1; c++) {
    cx += colWidths[c];
    ctx.beginPath();
    ctx.moveTo(cx + 0.5, ty);
    ctx.lineTo(cx + 0.5, ty + tableH);
    ctx.stroke();
  }

  ctx.restore();

  ctx.strokeStyle = COLOR_BORDER_OUTER;
  ctx.lineWidth = 1;
  roundedRectPath(tx + 0.5, ty + 0.5, tableW - 1, tableH - 1, RADIUS);
  ctx.stroke();

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob null"))), "image/png");
  });
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const base64 = btoa(bin);
  return { base64, mime: "image/png", fileName, width: canvasW, height: canvasH };
}
