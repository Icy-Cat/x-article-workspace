import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageLoader } from '../src/content/image-loader.js';

test('image loader rejects SVG data URI payloads', async () => {
  const loadImage = createImageLoader({
    fetchImage: async () => ({ ok: false, error: 'should not fetch data URI' }),
  });

  const result = await loadImage('data:image/svg+xml;base64,PHN2Zy8+');
  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported image MIME/);
});

test('image loader rejects adapter SVG results', async () => {
  const loadImage = createImageLoader({
    fetchImage: async () => ({
      ok: true,
      base64: 'PHN2Zy8+',
      mime: 'image/svg+xml',
    }),
  });

  const result = await loadImage('https://example.com/a.svg');
  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported image MIME/);
});
