// Build the HTML payload that the bridge dispatches to MAIN world. Atomic
// segments (code, divider, tweet, image, table) become marker placeholders;
// the bridge sends the matching `plan` so MAIN world knows how to replace
// each marker after the paste settles.
//
// inject-core port (ADR-0002): the original `import { t } from './i18n.js'`
// dependency is gone. Callers pass an optional `i18n` callback in opts; if
// absent, the package falls back to the English strings below. The full
// localization (zh / en / ja) remains in the extension repo and is wired
// in by the host via the adapter contract — see `InjectCoreAdapters.i18n`
// in `src/index.js`.

const DEFAULT_I18N_STRINGS = {
  img_err_no_vault:                 'image skipped — vault folder not authorized',
  img_err_no_permission:            'image skipped — vault permission denied',
  img_err_not_found:                'image not found in vault',
  img_err_absolute_outside_vault:   'image path is outside the authorized vault',
  img_err_path_escapes_vault:       'image path escapes the authorized vault',
  img_err_fetch_failed:             'image fetch failed',
};

function defaultI18n(key) {
  return DEFAULT_I18N_STRINGS[key] || key;
}

const TEXT_KIND_TO_BLOCK = {
  unstyled: 'p',
  'header-one': 'h1',
  'header-two': 'h2',
  'header-three': 'h3',
  'header-four': 'h4',
  'header-five': 'h5',
  'header-six': 'h6',
  blockquote: 'blockquote',
};

// Returns { html, plain, plan, markerPrefix }
//   plan: ordered array of { marker, op } for MAIN world to apply
//
// op shapes:
//   { type: 'atomic', entityType: 'DIVIDER'|'MARKDOWN'|'TWEET', data, mutability }
//   { type: 'image',  file: { base64, mime, fileName, alt } }
//
// opts.i18n — optional adapter, see InjectCoreAdapters contract.
export function buildPastePayload(segments, { imageMap, tableMap, sessionId, i18n } = {}) {
  const tr = typeof i18n === 'function' ? i18n : defaultI18n;
  const sid = sessionId || Math.random().toString(36).slice(2, 6);
  const markerPrefix = `__XARTICLE_${sid}_`;
  const plan = [];

  let nextIdx = 0;
  const newMarker = (kind) => `${markerPrefix}${kind}_${nextIdx++}__`;

  const out = [];
  let listKind = null;
  let listItems = [];

  const flushList = () => {
    if (!listKind || !listItems.length) return;
    out.push(`<${listKind}>${listItems.map((li) => `<li>${li}</li>`).join('')}</${listKind}>`);
    listKind = null;
    listItems = [];
  };

  for (const seg of segments) {
    if (seg.type === 'text') {
      const inner = renderInline(seg) || '<br>';
      if (seg.kind === 'unordered-list-item') {
        if (listKind && listKind !== 'ul') flushList();
        listKind = 'ul';
        listItems.push(inner);
        continue;
      }
      if (seg.kind === 'ordered-list-item') {
        if (listKind && listKind !== 'ol') flushList();
        listKind = 'ol';
        listItems.push(inner);
        continue;
      }
      flushList();
      const tag = TEXT_KIND_TO_BLOCK[seg.kind] || 'p';
      out.push(`<${tag}>${inner}</${tag}>`);
      continue;
    }

    flushList();

    if (seg.type === 'divider') {
      const m = newMarker('DIV');
      out.push(`<p>${m}</p>`);
      plan.push({ marker: m, op: { type: 'atomic', entityType: 'DIVIDER', data: {}, mutability: 'IMMUTABLE' } });
      continue;
    }

    if (seg.type === 'code') {
      const m = newMarker('CODE');
      out.push(`<p>${m}</p>`);
      const md = '```' + (seg.language || '') + '\n' + (seg.code || '') + '\n```';
      plan.push({ marker: m, op: { type: 'atomic', entityType: 'MARKDOWN', data: { markdown: md }, mutability: 'MUTABLE' } });
      continue;
    }

    if (seg.type === 'tweet') {
      const m = newMarker('TWEET');
      out.push(`<p>${m}</p>`);
      const url = `https://twitter.com/i/web/status/${seg.tweetId}`;
      plan.push({ marker: m, op: { type: 'atomic', entityType: 'TWEET', data: { url, tweetId: seg.tweetId }, mutability: 'IMMUTABLE' } });
      continue;
    }

    if (seg.type === 'image') {
      const r = imageMap?.get(seg);
      if (r?.ok) {
        const m = newMarker('IMG');
        out.push(`<p>${m}</p>`);
        plan.push({
          marker: m,
          op: {
            type: 'image',
            file: { base64: r.base64, mime: r.mime, fileName: r.fileName, alt: seg.alt || '' },
            // Carry the original markdown ref so MAIN injector can fall
            // back to readable text if X's media upload times out.
            fallbackText: `![${seg.alt || ''}](${seg.source})`,
            // Source URL — used by cover matching in MAIN injector to
            // reuse the body image's mediaId for the cover endpoint.
            source: seg.source || null,
          },
        });
      } else {
        // Friendly error wording
        const msg =
          r?.error === 'no_vault' ? tr('img_err_no_vault')
          : r?.error === 'no_permission' ? tr('img_err_no_permission')
          : r?.error === 'not_found' ? tr('img_err_not_found')
          : r?.error === 'absolute_outside_vault' ? tr('img_err_absolute_outside_vault')
          : r?.error === 'path_escapes_vault' ? tr('img_err_path_escapes_vault')
          : r?.error || tr('img_err_fetch_failed');
        out.push(`<p>${escapeText(`![${seg.alt || ''}](${seg.source}) — ${msg}`)}</p>`);
      }
      continue;
    }

    if (seg.type === 'table') {
      const r = tableMap?.get(seg);
      if (r?.ok) {
        const m = newMarker('IMG');
        out.push(`<p>${m}</p>`);
        plan.push({
          marker: m,
          op: {
            type: 'image',
            file: { base64: r.base64, mime: r.mime, fileName: r.fileName, alt: 'table' },
            fallbackText: serializeTableToMd(seg),
          },
        });
      } else {
        const md = serializeTableToMd(seg);
        out.push(`<pre><code>${escapeText(md)}</code></pre>`);
      }
      continue;
    }
  }

  flushList();

  return {
    html: out.join(''),
    plain: segmentsToPlain(segments),
    plan,
    markerPrefix,
  };
}

export function renderInline(seg) {
  const text = seg.text || '';
  if (!text) return '';
  const ranges = (seg.inlineStyleRanges || []).slice();
  const links = (seg.links || []).slice();
  const opens = new Array(text.length + 1).fill(null).map(() => []);
  const closes = new Array(text.length + 1).fill(null).map(() => []);
  const styleTag = (s) => {
    if (s === 'Bold') return 'strong';
    if (s === 'Italic') return 'em';
    if (s === 'Strikethrough') return 's';
    if (s === 'Underline') return 'u';
    if (s === 'Code') return 'code';
    return null;
  };
  for (const r of ranges) {
    const tag = styleTag(r.style);
    if (!tag) continue;
    opens[r.offset].push(tag);
    closes[r.offset + r.length].push(tag);
  }
  for (const l of links) {
    const href = sanitizeHref(l.url);
    if (!href) continue;
    opens[l.offset].push({ tag: 'a', href });
    closes[l.offset + l.length].push('a');
  }
  let out = '';
  for (let i = 0; i <= text.length; i++) {
    for (let j = closes[i].length - 1; j >= 0; j--) out += `</${closes[i][j]}>`;
    for (const open of opens[i]) {
      if (typeof open === 'string') out += `<${open}>`;
      else out += `<${open.tag} href="${escapeAttr(open.href)}">`;
    }
    if (i < text.length) out += escapeText(text[i]);
  }
  return out;
}

export function sanitizeHref(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (['https:', 'http:', 'mailto:'].includes(parsed.protocol)) return raw;
  } catch {
    return '';
  }
  return '';
}

export function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function segmentsToPlain(segments) {
  const lines = [];
  for (const s of segments) {
    if (s.type === 'text') lines.push(s.text || '');
    else if (s.type === 'code') lines.push('```' + (s.language || '') + '\n' + (s.code || '') + '\n```');
    else if (s.type === 'divider') lines.push('---');
    else if (s.type === 'tweet') lines.push(`https://twitter.com/i/web/status/${s.tweetId}`);
    else if (s.type === 'image') lines.push(`![${s.alt || ''}](${s.source})`);
    else if (s.type === 'table') lines.push(serializeTableToMd(s));
  }
  return lines.join('\n\n');
}

function serializeTableToMd(table) {
  const out = [];
  out.push('| ' + table.headers.join(' | ') + ' |');
  out.push(
    '| ' +
      table.alignments.map((a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : ':---')).join(' | ') +
      ' |',
  );
  for (const row of table.rows) out.push('| ' + row.join(' | ') + ' |');
  return out.join('\n');
}
