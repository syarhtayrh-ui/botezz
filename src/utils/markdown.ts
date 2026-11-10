/**
 * Markdown utilities for Telegram Bot API messages.
 * Prevents unescaped dynamic text (session IDs with underscores, custom labels,
 * raw error messages) from triggering Telegram entity parsing failures.
 */

/**
 * Escapes characters that have special syntactic meaning in Telegram Legacy Markdown.
 * Characters escaped: `_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``.
 */
export function escapeMarkdown(text: string): string {
  if (!text) return '';
  return text.replace(/([_*[\]()~`\\])/g, '\\$1');
}

/**
 * Strips markdown formatting delimiters from text if Telegram parser fails,
 * enabling safe fallback delivery as plain text without crashing.
 */
export function stripMarkdown(text: string): string {
  if (!text) return '';
  return text.replace(/[*_`~]/g, '');
}

/**
 * Detects whether a Telegram / grammY API error is caused by invalid entity parsing.
 */
export function isMarkdownEntityError(err: unknown): boolean {
  if (!err) return false;
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'description' in err
        ? String((err as { description?: unknown }).description)
        : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes("can't parse entities") ||
    lower.includes('cant parse entities') ||
    lower.includes('entity') ||
    lower.includes('parse mode')
  );
}

/**
 * Safely truncates a string by Unicode grapheme clusters (or code points fallback)
 * and strips any orphaned UTF-16 surrogates so emojis are never split in half.
 */
export function truncateGraphemes(text: string, maxGraphemes: number): string {
  if (!text) return '';
  const sanitized = text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    ''
  );
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('ar', { granularity: 'grapheme' });
    const segments: string[] = [];
    for (const item of segmenter.segment(sanitized)) {
      if (segments.length >= maxGraphemes) break;
      segments.push(item.segment);
    }
    return segments.join('').trim();
  }
  return Array.from(sanitized).slice(0, maxGraphemes).join('').trim();
}

