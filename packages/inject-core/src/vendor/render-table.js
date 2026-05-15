// Vendored from G:\Projects\0Tools\x-article-workspace\skills\x-article-upload\
//   scripts\api-mode\render-table.mjs (commit context: 2026-05-10)
//
// Adapted for browser extension: extracted from the bridge.evalJS template
// literal so it runs natively in the content script. Returns a base64 PNG.

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

export async function renderTableToImage(table, opts = {}) {
  const dpr = opts.dpr || 2;
  const fileName = opts.fileName || `table-${Date.now()}.png`;

  const meas = document.createElement("canvas").getContext("2d");
  const measureLine = (text, font) => {
    meas.font = font;
    return meas.measureText(text).width;
  };
  const wrapText = (text, maxW, font) => {
    meas.font = font;
    const lines = [];
    const explicitLines = String(text == null ? "" : text).split(/\r?\n|<br\s*\/?\s*>/i);
    for (const raw of explicitLines) {
      if (!raw) {
        lines.push("");
        continue;
      }
      if (meas.measureText(raw).width <= maxW) {
        lines.push(raw);
        continue;
      }
      let cur = "";
      let lastBreak = -1;
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        const tentative = cur + ch;
        if (meas.measureText(tentative).width > maxW && cur.length > 0) {
          if (lastBreak >= 0 && lastBreak < cur.length - 1) {
            lines.push(cur.slice(0, lastBreak + 1).trimEnd());
            cur = cur.slice(lastBreak + 1) + ch;
            lastBreak = -1;
          } else {
            lines.push(cur);
            cur = ch;
          }
        } else {
          cur = tentative;
          if (/[\s　、。,.!?;:，。！？；：、]/.test(ch)) {
            lastBreak = cur.length - 1;
          }
        }
      }
      if (cur) lines.push(cur);
    }
    return lines.length ? lines : [""];
  };

  const colCount = table.headers.length;
  const naturalContentW = new Array(colCount).fill(0);
  const naturalize = (text, col, font) => {
    const lines = String(text == null ? "" : text).split(/\r?\n|<br\s*\/?\s*>/i);
    for (const ln of lines) {
      const w = measureLine(ln, font);
      if (w > naturalContentW[col]) naturalContentW[col] = w;
    }
  };
  table.headers.forEach((h, i) => naturalize(h, i, FONT_HEAD));
  for (const row of table.rows) {
    for (let i = 0; i < colCount; i++) naturalize(row[i] || "", i, FONT_BODY);
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
    wrapText(h, colWidths[i] - PAD_X * 2, FONT_HEAD),
  );
  const headerHeight = rowHeightFor(headerLines, HEAD_PAD_Y);
  rowLines.push({ kind: "head", cells: headerLines, height: headerHeight });
  for (const row of table.rows) {
    const cells = row
      .slice(0, colCount)
      .concat(new Array(Math.max(0, colCount - row.length)).fill(""))
      .map((c, i) => wrapText(c, colWidths[i] - PAD_X * 2, FONT_BODY));
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
  for (let r = 0; r < rowLines.length; r++) {
    const row = rowLines[r];
    const isHead = row.kind === "head";
    ctx.font = isHead ? FONT_HEAD : FONT_BODY;
    ctx.fillStyle = isHead ? COLOR_HEAD : COLOR_TEXT;
    let cx = tx;
    const padTop = isHead ? HEAD_PAD_Y : PAD_Y;
    for (let c = 0; c < colCount; c++) {
      const cw = colWidths[c];
      const lines = row.cells[c];
      const align = table.alignments[c] || "left";
      let yLine = rowY[r] + padTop;
      for (const ln of lines) {
        const lw = measureLine(ln, isHead ? FONT_HEAD : FONT_BODY);
        ctx.fillText(ln, alignToX(align, cx, cw, lw), yLine);
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
