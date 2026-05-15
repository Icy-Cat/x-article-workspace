// Pure-function utilities for classifying Markdown image source strings.
//
// inject-core only owns the *classification* — actual local-path resolution
// (extension's File System Access API + persisted directory handle, or the
// Obsidian plugin's vault.adapter.readBinary) lives in the host and reaches
// inject-core via the `resolveLocalImage` adapter callback declared in
// `src/index.js`'s InjectCoreAdapters contract.
//
// The full resolver (with FSA store + permission flow) stays in the
// extension at `x-article-md-paste/src/local-image/resolver.js`; only this
// stub is shared.

const REMOTE_SCHEMES = /^https?:\/\//i;

/**
 * Returns true if a Markdown image source looks like a local-filesystem path
 * (anything that isn't an http(s):// URL or data: URI). The host's
 * `resolveLocalImage` adapter is responsible for actually reading the bytes.
 */
export function isLocalPath(source) {
  if (!source || typeof source !== 'string') return false;
  if (REMOTE_SCHEMES.test(source)) return false;
  if (source.startsWith('data:')) return false;
  return true;
}
