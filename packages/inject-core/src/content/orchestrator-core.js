// inject-core orchestrator — host-agnostic fork of the original
// `x-article-md-paste/src/content/orchestrator.js`.
//
// Owns:
//   - Image / table parallel prefetch (via host adapters)
//   - HTML payload + marker plan construction (via segments-to-html)
//   - postRun() message dance with MAIN world (Fiber injection target)
//
// Does NOT own (compared to the original extension orchestrator):
//   - License / tier-limit gating  → extension keeps its `applyTierLimits`
//     wrapper around `runPipeline` if it wants caps; inject-core is
//     tier-agnostic
//   - Banner DOM                   → host renders via `onProgress` adapter
//   - i18n string source           → host passes `i18n` adapter (English
//     fallback strings embedded in segments-to-html for image errors)
//   - Vault prompt                 → host decides if/how to prompt for
//     local-image authorization before calling `runPipeline`
//
// MAIN world side (`src/main/injector-main.js`) is unchanged and reached
// via `window.postMessage` with the documented {source, kind, payload}
// envelope.

import { buildPastePayload } from './segments-to-html.js';
import { createImageLoader } from './image-loader.js';
import { renderTableToImage } from '../vendor/render-table.js';
import { isLocalPath } from '../local-image/resolver.js';

const SOURCE_OUT = typeof __X_ARTICLE_SOURCE_OUT__ !== 'undefined' ? __X_ARTICLE_SOURCE_OUT__ : 'xmp';
const SOURCE_IN = typeof __X_ARTICLE_SOURCE_IN__ !== 'undefined' ? __X_ARTICLE_SOURCE_IN__ : 'xmp-main';

// Inactivity timeout — reset every time the MAIN world posts a 'progress'
// message. Long articles with X media-pipeline stalls can take 1m+ per
// image during retry; the old fixed 90s ceiling cut them off mid-flight.
// 60s of NO progress is the bail-out signal.
const PROGRESS_TIMEOUT_MS = 60000;

// MAIN-world readiness handshake — lazy because page.evaluate-driven hosts
// (Obsidian via bridge) may load this module before the MAIN script is
// injected. Extension load order is also `document_idle` for both, but the
// promise is harmless when MAIN is already ready (the early postMessage
// probe will resolve it).
let mainReady = false;
let mainReadyPromise = null;
function ensureMainReadyListener() {
  if (mainReadyPromise) return mainReadyPromise;
  mainReadyPromise = new Promise((resolve) => {
    const onReady = (ev) => {
      if (ev.source !== window) return;
      if (ev.data?.source !== SOURCE_IN) return;
      if (ev.data.kind === 'ready') {
        mainReady = true;
        window.removeEventListener('message', onReady);
        resolve();
      }
    };
    window.addEventListener('message', onReady);
    // Probe in case MAIN was already ready before this script loaded.
    window.postMessage({ source: SOURCE_OUT, kind: 'ready?' }, '*');
  });
  return mainReadyPromise;
}

function postRun(payload, { onProgress, i18n }) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const armTimeout = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMsg);
        reject(new Error('main world response timeout (no progress for 60s)'));
      }, PROGRESS_TIMEOUT_MS);
    };
    armTimeout();

    const onMsg = (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.source !== SOURCE_IN) return;
      if (d.kind === 'progress') {
        // MAIN sends an i18n key + vars. Translate here using the host's
        // i18n adapter (no host i18n → falls back to the i18n function's
        // own behavior; segments-to-html's defaultI18n is one such
        // fallback the host may borrow).
        const localized = i18n && d.textKey
          ? i18n(d.textKey, d.vars || {})
          : (d.text || d.textKey || '...');
        if (onProgress) onProgress(d.level || 'work', localized);
        armTimeout();
        return;
      }
      if (d.kind === 'done') {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(d.summary || {});
        return;
      }
      if (d.kind === 'error') {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        reject(new Error(d.error || 'main world error'));
        return;
      }
    };
    window.addEventListener('message', onMsg);
    window.postMessage({ source: SOURCE_OUT, kind: 'run', payload }, '*');
  });
}

/**
 * Run the inject pipeline.
 *
 * @param {object}   opts
 * @param {object}   opts.parsed      Output of `parseMarkdownText(rawMd)`:
 *                                    `{ segments, title?, cover? }`.
 * @param {object}   opts.adapters    InjectCoreAdapters — see src/index.js.
 *                                    Required: `fetchImage`.
 *                                    Optional: `resolveLocalImage`,
 *                                    `onProgress`, `i18n`.
 * @returns {Promise<{ok: boolean, skipped?: boolean, summary?: object}>}
 */
export async function runPipeline({ parsed, adapters }) {
  if (!adapters || typeof adapters.fetchImage !== 'function') {
    throw new Error(
      'runPipeline: adapters.fetchImage is required (see ' +
      'InjectCoreAdapters contract in @x-article/inject-core/src/index.js)',
    );
  }
  const { fetchImage, resolveLocalImage, onProgress, i18n } = adapters;
  const tr = typeof i18n === 'function' ? i18n : (k) => k;
  const progress = (level, msg) => { if (onProgress) onProgress(level, msg); };

  const segments = parsed?.segments || [];
  if (!segments.length) return { ok: true, skipped: true };

  const counts = countTypes(segments);

  progress('warn', tr('preparing'));

  // Wait for main world to be ready
  try {
    if (!mainReady) {
      progress('warn', tr('startup'));
      const timeoutP = new Promise((_, rej) =>
        setTimeout(() => rej(new Error(tr('startup_failed'))), 5000),
      );
      await Promise.race([ensureMainReadyListener(), timeoutP]);
    }
  } catch (e) {
    throw new Error(e?.message || tr('startup_failed_short'));
  }

  // Local-image authorization is HOST responsibility. If host wanted a
  // vault picker (extension FSA, Obsidian vault permission etc.), it
  // should have run that before calling us. We just count for the banner.
  const localImageCount = segments.filter(
    (s) => s.type === 'image' && isLocalPath(s.source),
  ).length;
  if (localImageCount > 0 && !resolveLocalImage) {
    progress('warn', tr('local_images_detected_banner', { n: localImageCount }));
  }

  // Prefetch / pre-render in parallel
  const loadImage = createImageLoader({ fetchImage, resolveLocalImage });
  const imageJobs = segments
    .filter((s) => s.type === 'image')
    .map(async (s, idx) => {
      const r = await loadImage(s.source, { fileName: `paste-img-${idx + 1}` });
      return { seg: s, result: r };
    });
  const tableJobs = segments
    .filter((s) => s.type === 'table')
    .map(async (s, idx) => {
      try {
        const png = await renderTableToImage(s, { fileName: `table-${idx + 1}.png` });
        return { seg: s, result: { ok: true, ...png } };
      } catch (e) {
        return { seg: s, result: { ok: false, error: String(e?.message || e) } };
      }
    });

  if (imageJobs.length && tableJobs.length) {
    progress('work', tr('downloading_and_rendering', {
      imgs: imageJobs.length,
      tables: tableJobs.length,
    }));
  } else if (imageJobs.length) {
    progress('work', tr('downloading', { n: imageJobs.length }));
  } else if (tableJobs.length) {
    progress('work', tr('rendering_tables', { n: tableJobs.length }));
  }
  const [images, tables] = await Promise.all([
    Promise.all(imageJobs),
    Promise.all(tableJobs),
  ]);
  const imageMap = new Map(images.map((x) => [x.seg, x.result]));
  const tableMap = new Map(tables.map((x) => [x.seg, x.result]));
  const imgFails = images.filter((x) => !x.result.ok).length;
  const tableFails = tables.filter((x) => !x.result.ok).length;
  if (imgFails) {
    // Console log is fine in MAIN/isolated world; host can still wire its
    // own logger via onProgress 'warn' on individual failures upstream.
    // eslint-disable-next-line no-console
    console.warn('[inject-core] image fetch failures:',
      images.filter((x) => !x.result.ok));
  }

  progress('work', tr('arranging'));
  const payload = buildPastePayload(segments, { imageMap, tableMap, i18n });
  // The browser runner is commonly used on machines where the XMP browser
  // extension is also installed. Keep the clipboard text/plain fallback
  // marker-only so extension paste listeners don't re-parse our original
  // Markdown and replace the run with their own XMP/XPOSTER marker flow.
  payload.plain = payload.html.replace(/<[^>]*>/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // Carry title/cover hints to MAIN. Cover is matched against body images
  // by source URL there; if the cover URL matches an uploaded body image,
  // we reuse its mediaId — no separate upload needed.
  payload.title = parsed.title || null;
  payload.cover = parsed.cover || null;

  progress('work', tr('dispatching'));
  let mainSummary;
  try {
    mainSummary = await postRun(payload, { onProgress, i18n });
  } catch (e) {
    throw new Error(`MAIN world: ${e.message}`);
  }

  const summary = {
    segments: segments.length,
    counts,
    mainSummary,
    imagesPrefetch: { ok: images.length - imgFails, fail: imgFails },
    tablesRendered: { ok: tables.length - tableFails, fail: tableFails },
  };
  progress('done', tr('pipeline_complete'));
  // eslint-disable-next-line no-console
  console.log('[inject-core] pipeline complete', summary);
  return { ok: true, summary };
}

function countTypes(segs) {
  const c = {};
  for (const s of segs) c[s.type] = (c[s.type] || 0) + 1;
  return c;
}
