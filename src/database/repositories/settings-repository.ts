import { AppDatabase } from '../database';
import { RateLimitError, ValidationError } from '../../utils/errors';

export interface SettingRecord {
  key: string;
  value: string;
  updated_at: string;
}

export interface PremiumSubscriptionEntry {
  targetId: string;
  targetType: 'USER' | 'GROUP';
  expiresAtIso: string;
  durationDays: number;
  addedAtIso: string;
}

export interface ClaimGroupEntry {
  groupId: string;
  title: string;
  addedAtIso: string;
}

export interface TestFunctionConfig {
  /** Maximum socket sends per execution (0 = unlimited, 1..100000). Default: 500 */
  maxSends: number;
  /** Delay in milliseconds between loop iterations (0..60000). Default: 200 */
  delayMs: number;
  /** VM sandbox timeout in milliseconds (500..60000). Default: 5000 */
  vmTimeoutMs: number;
  /** Maximum sleep(ms) allowed inside sandbox per call (0..60000). Default: 10000 */
  maxSleepMs: number;
  /** Session execution scope: 'FIRST' (first connected), 'ALL' (all connected in parallel), or specific sessionId */
  sessionScope: 'FIRST' | 'ALL' | string;
  /** Whether to abort remaining iterations immediately on first error */
  stopOnError: boolean;
  /** Whether to capture console.log/warn/error output inside the VM sandbox */
  captureConsole: boolean;
}

export const DEFAULT_TEST_FUNCTION_CONFIG: TestFunctionConfig = {
  maxSends: 500,
  delayMs: 200,
  vmTimeoutMs: 5000,
  maxSleepMs: 10000,
  sessionScope: 'FIRST',
  stopOnError: false,
  captureConsole: true,
};

const PREMIUM_SUBSCRIPTIONS_KEY = 'nebula_premium_subscriptions_json';
const CLAIM_GROUPS_KEY = 'nebula_claim_groups_json';
const COMMAND_COOLDOWN_KEY = 'command_cooldown_seconds';
const TEST_FUNCTION_CONFIG_KEY = 'nebula_testfunction_config_json';

export class SettingsRepository {
  private readonly userCooldownTimestamps = new Map<number, number>();

  constructor(public readonly db: AppDatabase) {}

  public get(key: string, defaultValue?: string): string | undefined {
    const row = this.db.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row ? row.value : defaultValue;
  }

  public set(key: string, value: string): void {
    const now = new Date().toISOString();
    this.db.sqlite
      .prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(key, value, now);
  }

  public listAll(): SettingRecord[] {
    return this.db.sqlite
      .prepare('SELECT * FROM settings ORDER BY key ASC')
      .all() as unknown as SettingRecord[];
  }

  // =========================================================================
  // Dynamic /testfunction Execution Controls (Persistent SQLite Configuration)
  // =========================================================================

  public getTestFunctionConfig(): TestFunctionConfig {
    const raw = this.get(TEST_FUNCTION_CONFIG_KEY);
    if (!raw) {
      return { ...DEFAULT_TEST_FUNCTION_CONFIG };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<TestFunctionConfig>;
      return {
        maxSends:
          typeof parsed.maxSends === 'number' &&
          Number.isFinite(parsed.maxSends) &&
          parsed.maxSends >= 0
            ? Math.min(100000, Math.floor(parsed.maxSends))
            : DEFAULT_TEST_FUNCTION_CONFIG.maxSends,
        delayMs:
          typeof parsed.delayMs === 'number' &&
          Number.isFinite(parsed.delayMs) &&
          parsed.delayMs >= 0
            ? Math.min(60000, Math.floor(parsed.delayMs))
            : DEFAULT_TEST_FUNCTION_CONFIG.delayMs,
        vmTimeoutMs:
          typeof parsed.vmTimeoutMs === 'number' &&
          Number.isFinite(parsed.vmTimeoutMs) &&
          parsed.vmTimeoutMs >= 500
            ? Math.min(60000, Math.floor(parsed.vmTimeoutMs))
            : DEFAULT_TEST_FUNCTION_CONFIG.vmTimeoutMs,
        maxSleepMs:
          typeof parsed.maxSleepMs === 'number' &&
          Number.isFinite(parsed.maxSleepMs) &&
          parsed.maxSleepMs >= 0
            ? Math.min(60000, Math.floor(parsed.maxSleepMs))
            : DEFAULT_TEST_FUNCTION_CONFIG.maxSleepMs,
        sessionScope:
          typeof parsed.sessionScope === 'string' && parsed.sessionScope.trim()
            ? parsed.sessionScope.trim()
            : DEFAULT_TEST_FUNCTION_CONFIG.sessionScope,
        stopOnError:
          typeof parsed.stopOnError === 'boolean'
            ? parsed.stopOnError
            : DEFAULT_TEST_FUNCTION_CONFIG.stopOnError,
        captureConsole:
          typeof parsed.captureConsole === 'boolean'
            ? parsed.captureConsole
            : DEFAULT_TEST_FUNCTION_CONFIG.captureConsole,
      };
    } catch {
      return { ...DEFAULT_TEST_FUNCTION_CONFIG };
    }
  }

  public updateTestFunctionConfig(
    partial: Partial<TestFunctionConfig>
  ): TestFunctionConfig {
    const current = this.getTestFunctionConfig();
    const next: TestFunctionConfig = {
      ...current,
      ...partial,
    };

    if (!Number.isFinite(next.maxSends) || next.maxSends < 0 || next.maxSends > 100000) {
      throw new ValidationError(
        'الحد الأقصى للإرسال (maxSends) يجب أن يكون رقماً بين 1 و 100000 (أو 0 لإلغاء الحد الأقصى).'
      );
    }
    next.maxSends = Math.floor(next.maxSends);

    if (!Number.isFinite(next.delayMs) || next.delayMs < 0 || next.delayMs > 60000) {
      throw new ValidationError(
        'مهلة التأخير بين التكرارات (delayMs) يجب أن تكون بين 0 و 60000 مللي ثانية.'
      );
    }
    next.delayMs = Math.floor(next.delayMs);

    if (
      !Number.isFinite(next.vmTimeoutMs) ||
      next.vmTimeoutMs < 500 ||
      next.vmTimeoutMs > 60000
    ) {
      throw new ValidationError(
        'مهلة تقييم الدالة (vmTimeoutMs) يجب أن تكون بين 500 و 60000 مللي ثانية.'
      );
    }
    next.vmTimeoutMs = Math.floor(next.vmTimeoutMs);

    this.set(TEST_FUNCTION_CONFIG_KEY, JSON.stringify(next));
    return next;
  }

  // =========================================================================
  // Command Cooldown Management (Adapted from Nebula loadCooldown/saveCooldown)
  // =========================================================================

  public getCooldownSeconds(): number {
    const raw = this.get(COMMAND_COOLDOWN_KEY, '0');
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
  }

  public setCooldownSeconds(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) {
      throw new ValidationError(
        'قيمة التهدئة (Cooldown) يجب أن تكون رقماً بين 0 و 3600 ثانية (مثال: /setcooldown 5).'
      );
    }
    const clean = Math.floor(seconds);
    this.set(COMMAND_COOLDOWN_KEY, String(clean));
    return clean;
  }

  public checkUserCooldown(userId: number): void {
    const now = Date.now();
    const cooldownSec = this.getCooldownSeconds();
    if (cooldownSec <= 0) {
      this.userCooldownTimestamps.set(userId, now);
      return;
    }

    const lastUsed = this.userCooldownTimestamps.get(userId);
    if (lastUsed !== undefined) {
      const elapsedSec = (now - lastUsed) / 1000;
      if (elapsedSec < cooldownSec) {
        const remaining = Math.ceil(cooldownSec - elapsedSec);
        throw new RateLimitError(
          `⏳ الرجاء الانتظار ${remaining} ثانية قبل إرسال أمر جديد (نظام التهدئة Cooldown مفعل).`
        );
      }
    }
    this.userCooldownTimestamps.set(userId, now);
  }

  // =========================================================================
  // Premium Users & Groups Management (Adapted from Nebula premium.json)
  // =========================================================================

  private loadSubscriptionsMap(): Record<string, PremiumSubscriptionEntry> {
    const raw = this.get(PREMIUM_SUBSCRIPTIONS_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, PremiumSubscriptionEntry>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private saveSubscriptionsMap(map: Record<string, PremiumSubscriptionEntry>): void {
    this.set(PREMIUM_SUBSCRIPTIONS_KEY, JSON.stringify(map));
  }

  public addPremiumSubscription(
    targetId: string,
    durationDays: number,
    targetType: 'USER' | 'GROUP' = 'USER'
  ): PremiumSubscriptionEntry {
    const cleanedId = String(targetId || '').trim();
    if (!cleanedId || !/^-?\d{4,20}$/.test(cleanedId)) {
      throw new ValidationError(
        'معرف المستخدم أو المجموعة غير صالح. يجب أن يكون معرفاً رقمياً (مثال: 123456789 أو -100123456789).'
      );
    }
    if (!Number.isFinite(durationDays) || durationDays <= 0 || durationDays > 3650) {
      throw new ValidationError('مدة الصلاحية يجب أن تكون رقماً بالأيام بين 1 و 3650 يوماً.');
    }

    const map = this.loadSubscriptionsMap();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + Math.floor(durationDays) * 24 * 60 * 60 * 1000
    );

    const entry: PremiumSubscriptionEntry = {
      targetId: cleanedId,
      targetType,
      expiresAtIso: expiresAt.toISOString(),
      durationDays: Math.floor(durationDays),
      addedAtIso: now.toISOString(),
    };
    map[cleanedId] = entry;
    this.saveSubscriptionsMap(map);
    return entry;
  }

  public removePremiumSubscription(targetId: string): boolean {
    const cleanedId = String(targetId || '').trim();
    const map = this.loadSubscriptionsMap();
    if (!map[cleanedId]) {
      return false;
    }
    delete map[cleanedId];
    this.saveSubscriptionsMap(map);
    return true;
  }

  public getPremiumStatus(targetId: string | number): {
    isPremium: boolean;
    entry?: PremiumSubscriptionEntry;
    remainingDays: number;
    formattedExpiry: string;
  } {
    const key = String(targetId).trim();
    const map = this.loadSubscriptionsMap();
    const entry = map[key];
    if (!entry) {
      return {
        isPremium: false,
        remainingDays: 0,
        formattedExpiry: '—',
      };
    }

    const nowMs = Date.now();
    const expiryMs = new Date(entry.expiresAtIso).getTime();
    if (Number.isNaN(expiryMs) || nowMs >= expiryMs) {
      delete map[key];
      this.saveSubscriptionsMap(map);
      return {
        isPremium: false,
        remainingDays: 0,
        formattedExpiry: 'منتهي الصلاحية',
      };
    }

    const remainingDays = Math.ceil((expiryMs - nowMs) / (24 * 60 * 60 * 1000));
    return {
      isPremium: true,
      entry,
      remainingDays,
      formattedExpiry: entry.expiresAtIso.slice(0, 10),
    };
  }

  public listPremiumSubscriptions(): PremiumSubscriptionEntry[] {
    const map = this.loadSubscriptionsMap();
    const nowMs = Date.now();
    let mutated = false;
    const active: PremiumSubscriptionEntry[] = [];

    for (const [key, entry] of Object.entries(map)) {
      const expiryMs = new Date(entry.expiresAtIso).getTime();
      if (Number.isNaN(expiryMs) || nowMs >= expiryMs) {
        delete map[key];
        mutated = true;
      } else {
        active.push(entry);
      }
    }

    if (mutated) {
      this.saveSubscriptionsMap(map);
    }
    return active;
  }

  // =========================================================================
  // Claim Groups Management (Adapted from Nebula claimGroups.json /addgb /delgb /listgb /claim)
  // =========================================================================

  public listClaimGroups(): ClaimGroupEntry[] {
    const raw = this.get(CLAIM_GROUPS_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as ClaimGroupEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private saveClaimGroups(groups: ClaimGroupEntry[]): void {
    this.set(CLAIM_GROUPS_KEY, JSON.stringify(groups));
  }

  public addClaimGroup(groupId: string, title?: string): ClaimGroupEntry {
    const cleaned = String(groupId || '').trim();
    if (!cleaned || !/^-?\d{4,20}$/.test(cleaned)) {
      throw new ValidationError(
        'معرف مجموعة تيليجرام غير صالح. مثال: /addgb -1001234567890'
      );
    }

    const groups = this.listClaimGroups();
    if (groups.some((g) => g.groupId === cleaned)) {
      throw new ValidationError('هذه المجموعة مسجلة بالفعل في قائمة مجموعات التفعيل.');
    }

    const entry: ClaimGroupEntry = {
      groupId: cleaned,
      title: title?.trim() || `مجموعة ${cleaned}`,
      addedAtIso: new Date().toISOString(),
    };
    groups.push(entry);
    this.saveClaimGroups(groups);
    return entry;
  }

  public removeClaimGroup(groupId: string): boolean {
    const cleaned = String(groupId || '').trim();
    const groups = this.listClaimGroups();
    const filtered = groups.filter((g) => g.groupId !== cleaned);
    if (filtered.length === groups.length) {
      return false;
    }
    this.saveClaimGroups(filtered);
    return true;
  }
}
