// @x-article/inject-core — public exports.
//
// This package exposes the host-agnostic X article injection pipeline.
// All host capabilities (network fetch, local image resolution, progress
// UI, i18n) are passed in through `InjectCoreAdapters` — see ADR-0002
// for the contract rationale.
//
// Used by:
//   - x-article-md-paste (Chrome extension): adapters wrap chrome.runtime.*
//   - x-article-in-obsidian (Obsidian plugin via playwright-mcp-bridge):
//     adapters use Obsidian requestUrl + vault file read
//
// Skeleton — files land in subsequent commits:
//   commit 1 (this one): package skeleton + 4 dependency-free files
//   commit 2: orchestrator-core fork + image-loader fetcher refactor
//   commit 3: x-article-md-paste switches to importing this package

export { renderTableToImage } from './vendor/render-table.js';
export { parseMarkdownText } from './vendor/parse-md.js';

// detect.js is currently const-only and not yet a named export; surfaced
// through default import for the moment, formalized in commit 2.
export * as detect from './content/detect.js';

// injector-main.js is a side-effect script that registers a window.postMessage
// listener and exposes hooks on window.__xmpMain__. It's intended to be
// loaded as a content_script (extension) or stringified into page.evaluate
// (plugin via bridge). Not re-exported here — host loads it directly via
// the `./main/injector-main.js` subpath in `exports`.

// adapter contract — formalized here so both calling sides typecheck against
// the same shape. TypeScript declarations will arrive in commit 2.
//
// Image result uses a discriminated union so callers (and the pipeline)
// don't have to defend against the half-successful `ok:true` + missing
// base64/mime shape. Both `fetchImage` and `resolveLocalImage` share the
// type. `fileName` is optional — inject-core derives one from source URL
// (or timestamp for data: URIs) when the adapter omits it, so hosts can
// skip naming concerns entirely.
//
// /** @typedef {(
//  *   | { ok: true;  base64: string; mime: string; fileName?: string }
//  *   | { ok: false; error: string }
//  * )} ImageResult
//  */
//
// /** @typedef {{
//  *   fetchImage:         (url: string) => Promise<ImageResult>;
//  *   resolveLocalImage?: (path: string) => Promise<ImageResult>;
//  *   onProgress?:        (
//  *     status: 'idle' | 'work' | 'warn' | 'done' | 'error',
//  *     msg: string
//  *   ) => void;
//  *   i18n?:              (key: string, vars?: Record<string, string>) => string;
//  * }} InjectCoreAdapters
//  */
//
// `runPipeline({ markdown, articleId?, adapters })` will live here once
// `orchestrator-core.js` lands in commit 2.
