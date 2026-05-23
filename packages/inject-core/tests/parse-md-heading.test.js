import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdownText } from '../src/vendor/parse-md.js';

function textKinds(markdown) {
  return parseMarkdownText(markdown)
    .segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => [segment.kind, segment.text]);
}

test('promotes a lone first H1 to title and removes it from body', () => {
  const parsed = parseMarkdownText('# Article title\n\nBody text');

  assert.equal(parsed.title, 'Article title');
  assert.deepEqual(textKinds('# Article title\n\nBody text'), [['unstyled', 'Body text']]);
});

test('downgrades remaining H2 after first H1 is promoted', () => {
  const parsed = parseMarkdownText('# Article title\n\n## Section\n\nBody');

  assert.equal(parsed.title, 'Article title');
  assert.deepEqual(parsed.segments.map((segment) => [segment.type, segment.kind, segment.text]), [
    ['text', 'header-one', 'Section'],
    ['text', 'unstyled', 'Body'],
  ]);
});

test('downgrades nested headings after first H1 is promoted', () => {
  assert.deepEqual(textKinds('# Title\n\n## Section\n\n### Child\n\n#### Deep\n\n##### Fine\n\n###### Tiny'), [
    ['header-one', 'Section'],
    ['header-two', 'Child'],
    ['header-three', 'Deep'],
    ['header-four', 'Fine'],
    ['header-five', 'Tiny'],
  ]);
});

test('frontmatter title preserves body heading levels', () => {
  const parsed = parseMarkdownText('---\ntitle: Frontmatter Title\n---\n# Body H1\n\n## Body H2\n\n### Body H3');

  assert.equal(parsed.title, 'Frontmatter Title');
  assert.equal(parsed.titleFromFrontmatter, true);
  assert.deepEqual(textKinds('---\ntitle: Frontmatter Title\n---\n# Body H1\n\n## Body H2\n\n### Body H3'), [
    ['header-one', 'Body H1'],
    ['header-two', 'Body H2'],
    ['header-three', 'Body H3'],
  ]);
});

test('markdown without H1 does not invent a title or change headings', () => {
  const parsed = parseMarkdownText('## Section only\n\n### Child');

  assert.equal(parsed.title, null);
  assert.deepEqual(textKinds('## Section only\n\n### Child'), [
    ['header-two', 'Section only'],
    ['header-three', 'Child'],
  ]);
});
