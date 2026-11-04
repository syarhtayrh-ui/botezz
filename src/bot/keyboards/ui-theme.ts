import { InlineButtonSpec, InlineKeyboardRows } from './main-menu';

/**
 * Renders a visual breadcrumb bar at the top of Telegram panels.
 * Example: `🧭 *المسار:* 🏠 الرئيسية ◂ 📋 الجلسات ◂ ⚙️ تفاصيل الجلسة`
 */
export function renderBreadcrumb(pathParts: string[]): string {
  const cleaned = pathParts.map((p) => p.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return '🧭 *المسار:* 🏠 الرئيسية';
  }
  const hasHome =
    cleaned[0].includes('الرئيسية') || cleaned[0].includes('🏠');
  const fullParts = hasHome ? cleaned : ['🏠 الرئيسية', ...cleaned];
  return `🧭 *المسار:* ${fullParts.join(' ◂ ')}`;
}

/**
 * Renders a step progress bar for multi-step interactive workflows.
 * Example: `📊 *التقدم:* [▰▰▱▱] الخطوة 2 من 4 — إدخال نص الرسالة`
 */
export function renderStepProgressBar(
  currentStep: number,
  totalSteps: number,
  stepTitle: string
): string {
  const safeTotal = Math.max(1, totalSteps);
  const safeCurrent = Math.min(Math.max(1, currentStep), safeTotal);
  const filled = '▰'.repeat(safeCurrent);
  const empty = '▱'.repeat(safeTotal - safeCurrent);
  return `📊 *التقدم:* [${filled}${empty}] الخطوة ${safeCurrent} من ${safeTotal} — ${stepTitle}`;
}

/**
 * Renders a compact session health status pill.
 */
export function renderSessionHealthPill(
  connected: number,
  total: number
): string {
  if (connected > 0) {
    return `🟢 ${connected}/${total} متصلة`;
  }
  return `🔴 0/${total} متصلة`;
}

/**
 * Per-admin recent recipients memory store (last 4 recipients per user)
 * for one-tap recipient selection in Message, Media, and Video Call workflows.
 */
const recentRecipientsByAdmin = new Map<number, string[]>();
const MAX_RECENT_RECIPIENTS = 4;

export function recordRecentRecipient(
  adminId: number,
  recipientDisplay: string
): void {
  const cleaned = recipientDisplay.trim();
  if (!cleaned) return;
  const existing = recentRecipientsByAdmin.get(adminId) || [];
  const filtered = existing.filter((item) => item !== cleaned);
  filtered.unshift(cleaned);
  recentRecipientsByAdmin.set(
    adminId,
    filtered.slice(0, MAX_RECENT_RECIPIENTS)
  );
}

export function getRecentRecipients(adminId: number): string[] {
  return [...(recentRecipientsByAdmin.get(adminId) || [])];
}

export function clearRecentRecipients(adminId?: number): void {
  if (typeof adminId === 'number') {
    recentRecipientsByAdmin.delete(adminId);
  } else {
    recentRecipientsByAdmin.clear();
  }
}

/**
 * Builds up to 2 rows of quick-select inline buttons for recent recipients.
 */
export function buildRecentRecipientsRows(
  adminId: number,
  callbackPrefix: 'wf_msg:recent:' | 'wf_media:recent:' | 'wf_vcall:recent:'
): InlineKeyboardRows {
  const recents = getRecentRecipients(adminId);
  if (recents.length === 0) {
    return [];
  }

  const rows: InlineKeyboardRows = [];
  for (let i = 0; i < recents.length; i += 2) {
    const pair = recents.slice(i, i + 2);
    const row: InlineButtonSpec[] = pair.map((target) => {
      const shortTarget = target.length > 22 ? target.slice(0, 22) : target;
      return {
        text: `🕘 ${shortTarget}`,
        callbackData: `${callbackPrefix}${target.slice(0, 44)}`,
      };
    });
    rows.push(row);
  }
  return rows;
}
