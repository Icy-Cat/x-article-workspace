// Image loader — factory that takes host adapter callbacks (fetcher +
// optional local resolver) and returns a `loadImage(source)` function.
//
// Replaces the extension's chrome.runtime.sendMessage round-trip to the
// background fetch proxy. Each host wraps its native fetch story:
//
//   Extension:  fetcher = (url) => chrome.runtime.sendMessage(
//                                    { type: 'fetchImage', url })
//   Obsidian:   fetcher = (url) => requestUrl({ url }).then(adapt)
//
// Routing inside inject-core:
//
//   data:image/...;base64,...  → parsed in-core (NO adapter call;
//                                 pure-logic, identical across hosts)
//   http(s)://...              → adapters.fetchImage (real network I/O)
//   anything else              → adapters.resolveLocalImage (if provided)
//
// data: URIs deliberately stay inside core so behavior is byte-identical
// between hosts. The old extension routed data: through the background's
// `fetchImage` which had its own parseDataUri branch; an Obsidian adapter
// using `requestUrl` would have no equivalent and silently mishandle
// inline images. Centralising parsing here removes that gotcha.
//
// Return shape aligns with the `ImageResult` discriminated union declared
// in src/index.js: `{ ok: true, base64, mime, fileName }` or
// `{ ok: false, error }`. Each adapter result is also passed through
// `normalizeImageResult()` so a half-successful `ok:true` with missing
// fields throws at the adapter boundary instead of propagating to the
// downstream pipeline.

import { isLocalPath } from '../local-image/resolver.js';

/**
 * @typedef {(
 *   | { ok: true;  base64: string; mime: string; fileName: string }
 *   | { ok: false; error: string }
 * )} ImageResult
 */

/**
 * @param {object}   adapters
 * @param {(url: string) => Promise<ImageResult>}  adapters.fetchImage
 * @param {(path: string) => Promise<ImageResult>} [adapters.resolveLocalImage]
 * @returns {(source: string, opts?: { fileName?: string }) => Promise<ImageResult & { source?: string; isLocal?: boolean }>}
 */
export function createImageLoader(adapters) {
  if (!adapters || typeof adapters.fetchImage !== 'function') {
    throw new Error(
      'createImageLoader: adapters.fetchImage is required (host-provided ' +
      'remote fetcher; see InjectCoreAdapters contract in src/index.js)',
    );
  }
  const { fetchImage, resolveLocalImage } = adapters;

  return async function loadImage(source, opts = {}) {
    const fileName = opts.fileName || deriveFileName(source);

    // data: URI branch — parsed in-core, never hits an adapter
    if (typeof source === 'string' && source.startsWith('data:')) {
      const parsed = parseDataUri(source);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error, source };
      }
      return {
        ok: true,
        base64: parsed.base64,
        mime: parsed.mime,
        fileName: ensureExtension(fileName, parsed.mime),
        source,
      };
    }

    // Local-path branch
    if (isLocalPath(source)) {
      if (!resolveLocalImage) {
        return {
          ok: false,
          error:
            'local image not supported: host did not provide ' +
            'adapters.resolveLocalImage',
          source,
          isLocal: true,
        };
      }
      try {
        const raw = await resolveLocalImage(source);
        const r = normalizeImageResult(raw, 'resolveLocalImage');
        if (!r.ok) {
          return { ok: false, error: r.error, source, isLocal: true };
        }
        return {
          ok: true,
          base64: r.base64,
          mime: r.mime,
          fileName: r.fileName || ensureExtension(fileName, r.mime),
          source,
          isLocal: true,
        };
      } catch (e) {
        return {
          ok: false,
          error: String(e?.message || e),
          source,
          isLocal: true,
        };
      }
    }

    // Network branch — http(s) only; data: was handled above
    try {
      const raw = await fetchImage(source);
      const r = normalizeImageResult(raw, 'fetchImage');
      if (!r.ok) {
        return { ok: false, error: r.error, source };
      }
      return {
        ok: true,
        base64: r.base64,
        mime: r.mime,
        fileName: r.fileName || ensureExtension(fileName, r.mime),
        source,
      };
    } catch (e) {
      return { ok: false, error: String(e?.message || e), source };
    }
  };
}

// ---------------------------------------------------------------------
// data: URI parsing (pure, in-core)
// ---------------------------------------------------------------------

// Matches `data:[<mime>][;base64],<payload>`. Accepts the optional mime
// (defaults to image/png) and optional base64 flag. Non-base64 payloads
// are percent-decoded then base64-encoded so the downstream pipeline only
// ever sees base64.
const DATA_URI_RE = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/;

function parseDataUri(source) {
  const m = DATA_URI_RE.exec(source);
  if (!m) return { ok: false, error: 'malformed data: URI' };
  const mime = (m[1] || 'image/png').toLowerCase();
  const isB64 = !!m[2];
  const payload = m[3] || '';
  if (!payload) return { ok: false, error: 'empty data: URI payload' };
  let base64;
  if (isB64) {
    base64 = payload.replace(/\s+/g, '');
  } else {
    // Percent-decoded text payload (rare for images, but legal).
    let decoded;
    try { decoded = decodeURIComponent(payload); }
    catch (e) { return { ok: false, error: 'data: URI percent-decode failed' }; }
    try {
      // btoa needs binary string; encode as Latin-1 surrogate-safe.
      base64 = typeof btoa === 'function'
        ? btoa(unescape(encodeURIComponent(decoded)))
        : Buffer.from(decoded, 'utf8').toString('base64');
    } catch (e) {
      return { ok: false, error: 'data: URI base64 encode failed' };
    }
  }
  return { ok: true, base64, mime };
}

// ---------------------------------------------------------------------
// Adapter-result validation
// ---------------------------------------------------------------------

// Throws if an adapter returned `ok: true` without the required payload
// fields. Caught by the surrounding try/catch and surfaced as a normal
// `{ ok: false, error }` so the pipeline doesn't have to defend.
export function normalizeImageResult(r, adapterName) {
  if (!r || typeof r !== 'object') {
    throw new Error(`${adapterName}: returned non-object: ${typeof r}`);
  }
  if (r.ok === false) {
    return { ok: false, error: r.error ? String(r.error) : 'adapter reported failure' };
  }
  if (r.ok !== true) {
    throw new Error(`${adapterName}: returned without ok flag`);
  }
  if (typeof r.base64 !== 'string' || !r.base64) {
    throw new Error(`${adapterName}: ok:true result missing base64`);
  }
  if (typeof r.mime !== 'string' || !r.mime) {
    throw new Error(`${adapterName}: ok:true result missing mime`);
  }
  return {
    ok: true,
    base64: r.base64,
    mime: r.mime,
    fileName: typeof r.fileName === 'string' ? r.fileName : undefined,
  };
}

function deriveFileName(source) {
  if (source.startsWith('data:')) return `image-${Date.now()}.png`;
  try {
    const u = new URL(source);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last;
    return `image-${Date.now()}.png`;
  } catch {
    return `image-${Date.now()}.png`;
  }
}

function ensureExtension(name, mime) {
  if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
  const ext = mimeToExt(mime);
  return `${name}.${ext}`;
}

function mimeToExt(mime) {
  switch ((mime || '').toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/svg+xml':
      return 'svg';
    default:
      return 'png';
  }
}
