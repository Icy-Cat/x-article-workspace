#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const workspaceRoot = resolve(root, '../..');
const esbuild = await import(pathToFileURL(resolveEsbuild()).href);
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const injectorMainSource = readFileSync(resolve(root, 'src/main/injector-main.js'), 'utf8');
const runnerInjectorMainSource = injectorMainSource
  .replace(
    "const SOURCE_OUT = typeof __X_ARTICLE_SOURCE_IN__ !== 'undefined' ? __X_ARTICLE_SOURCE_IN__ : 'xmp-main';",
    "const SOURCE_OUT = 'x-article-inject-core-main';",
  )
  .replace(
    "const SOURCE_IN = typeof __X_ARTICLE_SOURCE_OUT__ !== 'undefined' ? __X_ARTICLE_SOURCE_OUT__ : 'xmp';",
    "const SOURCE_IN = 'x-article-inject-core';",
  );
const outdir = resolve(root, 'dist');
const outfile = resolve(outdir, 'inject-core-runner.iife.js');

mkdirSync(outdir, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(root, 'src/browser/runner.js')],
  outfile,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['es2020'],
  minify: false,
  legalComments: 'none',
  define: {
    __INJECTOR_MAIN_SOURCE__: JSON.stringify(runnerInjectorMainSource),
    __INJECT_CORE_VERSION__: JSON.stringify(pkg.version),
    __X_ARTICLE_SOURCE_OUT__: JSON.stringify('x-article-inject-core'),
    __X_ARTICLE_SOURCE_IN__: JSON.stringify('x-article-inject-core-main'),
  },
});

console.log(`built ${outfile}`);

function resolveEsbuild() {
  const candidates = [
    resolve(workspaceRoot, 'node_modules/esbuild/lib/main.js'),
    resolve(workspaceRoot, 'apps/vscode/node_modules/esbuild/lib/main.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  const pnpmDir = resolve(workspaceRoot, 'node_modules/.pnpm');
  if (existsSync(pnpmDir)) {
    const entry = readdirSync(pnpmDir).find((name) => name.startsWith('esbuild@'));
    if (entry) {
      const candidate = resolve(pnpmDir, entry, 'node_modules/esbuild/lib/main.js');
      if (existsSync(candidate)) return candidate;
    }
  }

  throw new Error('esbuild not found; run pnpm install from x-article-workspace');
}
