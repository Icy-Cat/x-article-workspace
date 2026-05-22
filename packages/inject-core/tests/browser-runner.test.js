import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const bundlePath = resolve(root, 'dist/inject-core-runner.iife.js');

test('browser runner bundle exposes inject-core API for Playwright hosts', () => {
  execFileSync(process.execPath, [resolve(root, 'scripts/build-browser-bundle.mjs')], {
    cwd: root,
    stdio: 'pipe',
  });

  const bundle = readFileSync(bundlePath, 'utf8');
  assert.match(bundle, /__xArticleInjectCore/);
  assert.match(bundle, /runMarkdown/);
  assert.match(bundle, /createMappedImageAdapters/);
  assert.match(bundle, /main-world injector ready/);
  assert.doesNotMatch(bundle, /^\s*import\s/m);
  assert.doesNotMatch(bundle, /^\s*export\s/m);
});

test('package exports browser runner source and vendorable bundle', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

  assert.equal(pkg.exports['./browser/runner.js'], './src/browser/runner.js');
  assert.equal(pkg.exports['./dist/inject-core-runner.iife.js'], './dist/inject-core-runner.iife.js');
  assert.ok(pkg.files.includes('dist/**/*.js'));
  assert.equal(pkg.scripts.build, 'node scripts/build-browser-bundle.mjs');
  assert.equal(pkg.devDependencies, undefined);
});
