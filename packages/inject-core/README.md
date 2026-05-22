# `@x-article/inject-core`

> Host-agnostic injection pipeline for posting Markdown to X.com (Twitter) article drafts.
> Used by **x-article-md-paste** (Chrome extension) and **x-article-in-obsidian** (Obsidian plugin via playwright-mcp-bridge).

📄 Architecture rationale: see [ADR-0002](../../docs/adr/0002-d4-injection-rework.md).

---

## What this package owns

- **Markdown parsing** → segments (paragraphs / headers / code / table / image / divider / tweet-embed)
- **Segments → HTML payload** + atomic marker plan for Fiber injection
- **Image fetcher**: paid `<img>` / remote URL / local-path resolution through host adapter
- **Table → PNG** via SVG `<foreignObject>` + Canvas (no extra tab, no UI flash)
- **MAIN-world script** (`injector-main.js`): React Fiber walking + Immutable.js blockMap mutation + atomic marker replacement + X's own `onFilesAdded` for image upload

## What this package does **not** own

- **Service worker** lifecycle (extension-only)
- **Licensing / tier gating** (extension-only)
- **UI**: popup, banner DOM, vault prompts (host renders its own)
- **Page-script entry points**: paste capture, drag-drop overlay, URL guards (host's call when to call us)
- **i18n strings**: host owns its own localization framework

## Adapter contract

The pipeline is **pure** in the sense that it takes no global state — all I/O goes through an `InjectCoreAdapters` object passed in by the host:

```ts
/**
 * Discriminated union — `fetchImage` and `resolveLocalImage` share this shape.
 * Used everywhere so the pipeline (and host code) never has to defend against
 * a half-successful `ok: true` with missing base64/mime.
 *
 * `fileName` is optional: if the adapter omits it, inject-core derives one
 * from the source URL (or timestamp for data: URIs) and uses the mime to
 * pick an extension. Lets host adapters skip naming concerns entirely.
 */
type ImageResult =
  | { ok: true;  base64: string; mime: string; fileName?: string }
  | { ok: false; error: string };

interface InjectCoreAdapters {
  /**
   * Fetch a remote `http(s)://` image URL. Host-defined because:
   *   - Extension: chrome.runtime.sendMessage to background fetch (CORS bypass)
   *   - Plugin: Obsidian requestUrl / Electron net.fetch (no CORS to begin with)
   *
   * **Adapter is NOT expected to handle `data:` URIs** — inject-core parses
   * those itself in `image-loader.js`'s data-URI branch, ensuring identical
   * inline-image behavior across hosts.
   */
  fetchImage: (url: string) => Promise<ImageResult>;

  /**
   * Resolve a "local-path" image reference (e.g. `./img.png` in MD) to bytes.
   * Optional. If omitted, local-path images are skipped with a warning.
   *
   *   - Extension: File System Access API + persisted directory handle
   *   - Plugin: Obsidian vault.getResourcePath + file read
   */
  resolveLocalImage?: (path: string) => Promise<ImageResult>;

  /**
   * Progress / status callback. Host renders its own UI for this — banner DOM
   * in extension, Obsidian Notice in plugin.
   *
   * Statuses:
   *   - `idle`  no operation in progress, banner can clear
   *   - `work`  in-flight operation, host shows working state
   *   - `warn`  non-fatal warning (e.g. partial image failure), pipeline continues
   *   - `done`  pipeline finished successfully (alignment with existing banner.js usage)
   *   - `error` fatal failure, pipeline aborted
   */
  onProgress?: (
    status: 'idle' | 'work' | 'warn' | 'done' | 'error',
    msg: string,
  ) => void;

  /**
   * Localized string lookup. If host omits this, package falls back to
   * its embedded English literals.
   */
  i18n?: (key: string, vars?: Record<string, string>) => string;
}
```

## Usage

```js
// commit 2+:
import { runPipeline } from '@x-article/inject-core';

await runPipeline({
  markdown: '# Hello\n\n...',
  articleId: 'xxxxxx',           // optional, host can resolve if absent
  adapters: {
    fetchImage:        myHostFetcher,
    resolveLocalImage: myVaultResolver,   // optional
    onProgress:        (status, msg) => host.showBanner(status, msg),
    i18n:              (key) => host.t(key),
  },
});
```

The MAIN-world Fiber script (`injector-main.js`) must be loaded into the X.com page in one of two ways:

1. **Chrome extension**: `content_scripts` entry with `"world": "MAIN"` (see x-article-md-paste manifest)
2. **Obsidian plugin via bridge**: `page.evaluate(injectorMainSource)` — `injectorMainSource` is the contents of `node_modules/@x-article/inject-core/src/main/injector-main.js` read at runtime and stringified

For hosts that ship without this workspace on the user's machine, run
`pnpm -C packages/inject-core build` and vendor
`packages/inject-core/dist/inject-core-runner.iife.js`. The bundle exposes
`window.__xArticleInjectCore` with:

- `installMain()` — installs the bundled MAIN-world Fiber injector once.
- `runMarkdown({ markdown, imageMap, title, cover })` — parses Markdown and runs the shared pipeline.
- `runParsed({ parsed, adapters })` — lower-level entry when the host already parsed or wants custom adapters.
- `createMappedImageAdapters(imageMap)` — adapter helper for Playwright hosts that pre-resolve vault/remote images before `browser_evaluate`.

## Layout

```
src/
├── index.js                       # public exports + InjectCoreAdapters typedef
├── main/
│   └── injector-main.js           # MAIN-world Fiber + onFilesAdded
├── content/
│   ├── detect.js                  # Markdown heuristic patterns
│   ├── orchestrator-core.js       # pipeline orchestrator (runPipeline)
│   ├── segments-to-html.js        # build paste payload + marker plan
│   └── image-loader.js            # data: parser + adapter-driven fetch
├── vendor/
│   ├── parse-md.js                # vendored MD parser
│   └── render-table.js            # table → PNG via SVG/Canvas
└── local-image/
    └── resolver.js                # isLocalPath classifier
```

**Not in inject-core (intentionally):**

- `file-import.js` — the extension's "drop a .md → create new draft → paste plain text" UX is host-specific DOM choreography (clicks X.com buttons by locale-invariant SVG path, navigates via `history.pushState`, dispatches synthetic paste events). The Obsidian D4 path replaces it with Playwright navigation + direct page.evaluate, so no shared abstraction is meaningful.
- `banner.js` / `i18n.js` / `local-prompt.js` — UI / host concerns, see adapter contract.
- `license/` — extension monetization.
- `background/` — service worker lifecycle.

## Status

**Pre-1.0**. API surface still settling — first stable version coincides with `x-article-md-paste v1.2.0` and `x-article-in-obsidian v1.1.0`, which will be the first host releases to consume this package.

## Releases

This package is workspace-private (no npm publish). Both host repos link it via pnpm workspace protocol.

Roadmap:

| Phase | Tracked in | Description |
|---|---|---|
| commit 1 | task #16 | Package skeleton + 4 dependency-free files |
| commit 1.5 | task #16 | Contract tightening: `ImageResult` discriminated union, `onProgress` add `'done'` |
| commit 2a | task #16 | `image-loader` factory + `isLocalPath` stub |
| commit 2b | task #16 | `segments-to-html` (i18n adapter) + `image-loader` data: in-core + `normalizeImageResult` |
| commit 2c | task #16 | `orchestrator-core` fork (license / vault prompt / banner DOM stripped) + adapter-driven `runPipeline` |
| commit 3 | task #16 | `x-article-md-paste` switches to importing this package, 5 fixtures pass |
| follow-up | task #17 | `x-article-in-obsidian` adopts via `page.evaluate` + bridge |
