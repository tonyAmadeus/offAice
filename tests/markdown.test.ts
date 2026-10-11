import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, plainText } from '../src/renderer/Markdown';

test('markdown blocks: headings, lists, tables, quotes and fenced code', () => {
  const blocks = parseBlocks('## 结果\n\n1. 第一\n2. 第二\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> 注意\n\n```js\nconst x = 1;\n```\n\n普通段落\n第二行');
  assert.deepEqual(blocks.map(block => block.type), ['heading', 'list', 'table', 'quote', 'code', 'paragraph']);
  assert.deepEqual(blocks[1], { type: 'list', ordered: true, items: ['第一', '第二'] });
  assert.deepEqual(blocks[2], { type: 'table', header: ['a', 'b'], rows: [['1', '2']] });
  assert.deepEqual(blocks[4], { type: 'code', lang: 'js', text: 'const x = 1;' });
  assert.equal((blocks[5] as { text: string }).text, '普通段落\n第二行');
});

test('member HTML stays text and an unclosed fence does not swallow the parser', () => {
  const blocks = parseBlocks('<script>alert(1)</script>\n\n```\nunterminated');
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal((blocks[0] as { text: string }).text, '<script>alert(1)</script>');
  assert.deepEqual(blocks[1], { type: 'code', lang: '', text: 'unterminated' });
});

test('plain previews drop markdown punctuation', () => {
  assert.equal(plainText('**Decoding mojibake** in `README`\n## next'), 'Decoding mojibake in README next');
});
