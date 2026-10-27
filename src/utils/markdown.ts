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
