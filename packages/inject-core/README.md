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
 * a half-successful `ok: true` with missing base64/mime/fileName.
 */
type ImageResult =
  | { ok: true;  base64: string; mime: string; fileName: string }
  | { ok: false; error: string };

interface InjectCoreAdapters {
  /**
   * Fetch a remote image URL. Host-defined because:
   *   - Extension: chrome.runtime.sendMessage to background fetch (CORS bypass)
   *   - Plugin: Obsidian requestUrl / Electron net.fetch (no CORS to begin with)
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

## Layout

```
src/
├── index.js                       # public exports
├── main/
│   └── injector-main.js           # MAIN-world Fiber + onFilesAdded (commit 1)
├── content/                       # ISOLATED-world / bridge-side logic
│   ├── detect.js                  # Markdown heuristics                  (commit 1)
│   ├── orchestrator-core.js       # pipeline orchestrator                (commit 2)
│   ├── segments-to-html.js        # build paste payload + marker plan    (commit 2)
│   ├── image-loader.js            # remote image fetch via adapter       (commit 2)
│   └── file-import.js             # .md file → markdown text             (commit 2)
├── vendor/
│   ├── parse-md.js                # vendored MD parser                   (commit 1)
│   └── render-table.js            # table → PNG via SVG/Canvas           (commit 1)
└── local-image/
    └── resolver.js                # `isLocalPath` + path classification  (commit 2)
```

## Status

**Pre-1.0**. API surface still settling — first stable version coincides with `x-article-md-paste v1.2.0` and `x-article-in-obsidian v1.1.0`, which will be the first host releases to consume this package.

## Releases

This package is workspace-private (no npm publish). Both host repos link it via pnpm workspace protocol.

Roadmap:

| Phase | Tracked in | Description |
|---|---|---|
| commit 1 | task #16 (this) | Package skeleton + 4 dependency-free files |
| commit 2 | task #16 | `orchestrator-core` fork + `image-loader` fetcher refactor + adapter contract codification |
| commit 3 | task #16 | `x-article-md-paste` switches to importing this package, 5 fixtures pass |
| follow-up | task #17 | `x-article-in-obsidian` adopts via `page.evaluate` + bridge |
