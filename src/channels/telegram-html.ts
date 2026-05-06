/**
 * Convert markdown text (CommonMark-ish, what Claude actually emits) to
 * Telegram HTML parse_mode. We pick HTML over MarkdownV2 because:
 *
 *   - V2 requires escaping a long list of punctuation in plain text
 *     (`_*[]()~>#+-=|{}.!\`) — every forgotten dot at end of sentence = 400.
 *   - V1 ('Markdown') only supports *single-star* bold, but Claude
 *     consistently emits **double-star** bold (CommonMark default), so
 *     every other reply landed as 400 → silently fell back to plain text
 *     and the user saw raw `**bold**`.
 *   - HTML mode escapes only `<`, `>`, `&` and accepts a small fixed tag
 *     set, which is exactly what we need.
 *
 * Supported Telegram HTML tags (from core.telegram.org/bots/api#html-style):
 *   <b> <i> <u> <s> <code> <pre> <pre><code class="language-X"> <a> <blockquote>
 *
 * Headings collapse to <b> (Telegram has no <h*>), bullet/numeric lists
 * pass through as plain text (no <ul>/<li> support).
 */

const PLACEHOLDER_OPEN = '\u0000';
const PLACEHOLDER_CLOSE = '\u0001';

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;',
  );
}

// URL has already been through escapeHtml() by the time the link transform
// runs (step 3 escapes the whole work string, including the URL). So we
// only need to neutralise `"` here — re-escaping `&` would double up to
// `&amp;amp;`. Quotes need escaping because the URL ends up inside
// `href="..."`.
function escapeHref(url: string): string {
  return url.replace(/"/g, '&quot;');
}

export function markdownToTelegramHtml(input: string): string {
  if (!input) return '';
  const blocks: string[] = [];
  const stash = (html: string): string => {
    blocks.push(html);
    return `${PLACEHOLDER_OPEN}${blocks.length - 1}${PLACEHOLDER_CLOSE}`;
  };

  let work = input;

  // 1) Stash fenced code blocks first (greedy regex would break inline `code`)
  work = work.replace(/```([a-zA-Z0-9_+\-]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const trimmed = code.replace(/\n$/, '');
    const escaped = escapeHtml(trimmed);
    const html = lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`;
    return stash(html);
  });

  // 2) Stash inline `code` (single backticks, no newlines inside)
  work = work.replace(/`([^`\n]+?)`/g, (_m, code) =>
    stash(`<code>${escapeHtml(code)}</code>`),
  );

  // 3) HTML-escape everything else BEFORE applying markdown transforms,
  //    so user-provided `<` / `>` / `&` cannot inject tags.
  work = escapeHtml(work);

  // 4) Markdown inline transforms — order matters:
  //    bold `**` / `__` BEFORE italic `*` / `_` (otherwise `**x**` would be
  //    consumed as two separate italics).
  work = work.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>');
  work = work.replace(/__([^\n]+?)__/g, '<b>$1</b>');
  work = work.replace(/~~([^\n]+?)~~/g, '<s>$1</s>');
  // Italic: single `*` not adjacent to alphanumeric (avoids "2*3=6" math)
  work = work.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<i>$2</i>');
  // Italic: single `_` only between word boundaries (avoids snake_case)
  work = work.replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<i>$2</i>');

  // 5) Links [text](url). Run AFTER inline emphasis so link text can contain bold/italic.
  work = work.replace(/\[([^\]\n]+?)\]\(([^)\s]+?)\)/g, (_m, text, url) => {
    return `<a href="${escapeHref(url)}">${text}</a>`;
  });

  // 6) Headings (# .. ###### at line start) → <b>. Telegram has no <h*>.
  work = work.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // 7) Blockquotes: consecutive lines starting with `>` (escaped to `&gt;`)
  work = work.replace(
    /(?:^|\n)((?:&gt;\s.*(?:\n&gt;\s.*)*))/g,
    (_m, block) => {
      const inner = (block as string)
        .split('\n')
        .map((l) => l.replace(/^&gt;\s?/, ''))
        .join('\n');
      return `\n<blockquote>${inner}</blockquote>`;
    },
  );

  // 8) Restore stashed code blocks
  work = work.replace(
    new RegExp(`${PLACEHOLDER_OPEN}(\\d+)${PLACEHOLDER_CLOSE}`, 'g'),
    (_m, idx) => blocks[Number(idx)] ?? '',
  );

  return work;
}
