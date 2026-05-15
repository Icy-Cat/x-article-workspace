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
// Routing inside inject-core stays the same as the old code:
//
//   http(s)://... | data:...   → adapters.fetchImage
//   anything else              → adapters.resolveLocalImage (if provided)
//
// Return shape aligns with the `ImageResult` discriminated union declared
// in src/index.js: `{ ok: true, base64, mime, fileName }` or
// `{ ok: false, error }`. No partial-success shape.

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
        const r = await resolveLocalImage(source);
        if (!r.ok) {
          return { ok: false, error: r.error || 'local resolve failed', source, isLocal: true };
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

    // Network / data-URI branch
    try {
      const r = await fetchImage(source);
      if (!r.ok) {
        return { ok: false, error: r.error || 'fetch failed', source };
      }
      return {
        ok: true,
        base64: r.base64,
        mime: r.mime || 'image/png',
        fileName: r.fileName || ensureExtension(fileName, r.mime),
        source,
      };
    } catch (e) {
      return { ok: false, error: String(e?.message || e), source };
    }
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
