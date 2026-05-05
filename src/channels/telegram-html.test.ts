import { describe, it, expect } from 'vitest';
import { markdownToTelegramHtml } from './telegram-html.js';

describe('markdownToTelegramHtml', () => {
  it('passes plain text through unchanged', () => {
    expect(markdownToTelegramHtml('hello world')).toBe('hello world');
  });

  it('returns empty string for empty input', () => {
    expect(markdownToTelegramHtml('')).toBe('');
  });

  it('escapes HTML special characters', () => {
    expect(markdownToTelegramHtml('a < b & c > d')).toBe(
      'a &lt; b &amp; c &gt; d',
    );
  });

  it('converts double-star bold to <b>', () => {
    expect(markdownToTelegramHtml('**bold**')).toBe('<b>bold</b>');
  });

  it('converts double-underscore bold to <b>', () => {
    expect(markdownToTelegramHtml('__bold__')).toBe('<b>bold</b>');
  });

  it('converts single-star italic to <i>', () => {
    expect(markdownToTelegramHtml('this is *italic* here')).toBe(
      'this is <i>italic</i> here',
    );
  });

  it('does not treat snake_case as italic', () => {
    expect(markdownToTelegramHtml('foo_bar_baz')).toBe('foo_bar_baz');
  });

  it('does not treat math like 2*3=6 as italic', () => {
    expect(markdownToTelegramHtml('2*3=6')).toBe('2*3=6');
  });

  it('converts ~~strikethrough~~ to <s>', () => {
    expect(markdownToTelegramHtml('~~old~~')).toBe('<s>old</s>');
  });

  it('converts inline `code` to <code> with escaping inside', () => {
    expect(markdownToTelegramHtml('run `ls -la <dir>`')).toBe(
      'run <code>ls -la &lt;dir&gt;</code>',
    );
  });

  it('converts fenced code blocks to <pre>', () => {
    expect(markdownToTelegramHtml('```\nx = 1\n```')).toBe('<pre>x = 1</pre>');
  });

  it('converts fenced code with language to <pre><code class>', () => {
    expect(markdownToTelegramHtml('```python\nprint(1)\n```')).toBe(
      '<pre><code class="language-python">print(1)</code></pre>',
    );
  });

  it('escapes HTML inside code blocks', () => {
    expect(markdownToTelegramHtml('```\n<script>&\n```')).toBe(
      '<pre>&lt;script&gt;&amp;</pre>',
    );
  });

  it('does not interpret markdown inside code blocks', () => {
    expect(markdownToTelegramHtml('`**not bold**`')).toBe(
      '<code>**not bold**</code>',
    );
  });

  it('converts links [text](url) to <a>', () => {
    expect(markdownToTelegramHtml('[click](https://example.com)')).toBe(
      '<a href="https://example.com">click</a>',
    );
  });

  it('escapes ampersands in URLs', () => {
    expect(markdownToTelegramHtml('[q](https://x.com/?a=1&b=2)')).toBe(
      '<a href="https://x.com/?a=1&amp;b=2">q</a>',
    );
  });

  it('converts headings to <b>', () => {
    expect(markdownToTelegramHtml('# Title\n## Sub')).toBe(
      '<b>Title</b>\n<b>Sub</b>',
    );
  });

  it('converts blockquotes to <blockquote>', () => {
    const input = '> first line\n> second line';
    expect(markdownToTelegramHtml(input)).toContain('<blockquote>');
    expect(markdownToTelegramHtml(input)).toContain('first line\nsecond line');
  });

  it('handles the real-world payload that broke production', () => {
    // The exact "Кнопка" reply that produced the 400 entity error
    const input =
      'Кнопка отлично отработала — её уже не нужно ждать, она **уже сработала**:\n\n- **Кнопка**: жива';
    const out = markdownToTelegramHtml(input);
    expect(out).toContain('<b>уже сработала</b>');
    expect(out).toContain('<b>Кнопка</b>');
    expect(out).not.toContain('**');
  });

  it('combines bold + italic + code in one message', () => {
    expect(markdownToTelegramHtml('**bold** and *italic* with `code`')).toBe(
      '<b>bold</b> and <i>italic</i> with <code>code</code>',
    );
  });

  it('escapes user-provided HTML to prevent injection', () => {
    expect(markdownToTelegramHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('does not re-escape entities inside code blocks (no double-escape)', () => {
    // Ensures the placeholder mechanism prevents stash content from being
    // escaped a second time when the surrounding text is escaped.
    const out = markdownToTelegramHtml('hello `<x>` world');
    expect(out).toBe('hello <code>&lt;x&gt;</code> world');
  });
});
