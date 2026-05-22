// Browser-evaluate runner for Playwright/Obsidian/VS Code hosts.
//
// This file is bundled as a single IIFE for hosts that cannot rely on a
// sibling workspace package at runtime. The source of `main/injector-main.js`
// is injected by scripts/build-browser-bundle.mjs via esbuild `define`.

import { runPipeline, parseMarkdownText } from '../index.js';

const GLOBAL_NAME = '__xArticleInjectCore';
const MAIN_INSTALLED_FLAG = '__xArticleInjectCoreMainInstalled_v2';
const INJECTOR_MAIN_SOURCE = __INJECTOR_MAIN_SOURCE__;
const VERSION = __INJECT_CORE_VERSION__;

function asImageResult(value, source) {
  if (!value) return { ok: false, error: `image not staged: ${source}` };
  if (value.ok === false) return value;
  if (value.ok === true) return value;
  if (value.base64 && value.mime) {
    return {
      ok: true,
      base64: value.base64,
      mime: value.mime,
      fileName: value.fileName,
    };
  }
  return { ok: false, error: `invalid staged image result: ${source}` };
}

function createMappedImageAdapters(imageMap = {}, extra = {}) {
  const lookup = (source) => {
    const direct = imageMap[source];
    if (direct) return direct;
    const normalized = String(source || '').replace(/\\/g, '/');
    return imageMap[normalized] || imageMap[decodeURI(normalized)];
  };

  const fetchImage = async (url) => asImageResult(lookup(url), url);
  const resolveLocalImage = async (path) => asImageResult(lookup(path), path);
  return {
    fetchImage,
    resolveLocalImage,
    onProgress: extra.onProgress,
    i18n: extra.i18n,
  };
}

function installMain({ force = false } = {}) {
  if (window[MAIN_INSTALLED_FLAG] && !force) {
    return { ok: true, installed: false, reason: 'already-installed' };
  }
  (0, eval)(INJECTOR_MAIN_SOURCE);
  window[MAIN_INSTALLED_FLAG] = true;
  return { ok: true, installed: true };
}

async function runParsed({ parsed, adapters }) {
  installMain();
  return runPipeline({ parsed, adapters });
}

async function runMarkdown({ markdown, parsed, imageMap, adapters, title, cover } = {}) {
  const finalParsed = parsed || parseMarkdownText(String(markdown || ''));
  if (title !== undefined) finalParsed.title = title || null;
  if (cover !== undefined) finalParsed.cover = cover || null;
  const finalAdapters = adapters || createMappedImageAdapters(imageMap || {});
  return runParsed({ parsed: finalParsed, adapters: finalAdapters });
}

const api = {
  version: VERSION,
  injectorMainSource: INJECTOR_MAIN_SOURCE,
  createMappedImageAdapters,
  installMain,
  parseMarkdownText,
  runMarkdown,
  runParsed,
  runPipeline,
};
window[GLOBAL_NAME] = api;

export {
  createMappedImageAdapters,
  installMain,
  parseMarkdownText,
  runMarkdown,
  runParsed,
  runPipeline,
};
