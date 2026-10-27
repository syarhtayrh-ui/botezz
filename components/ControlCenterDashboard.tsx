'use client';

import React, { useState, useCallback } from 'react';
import {
  Send,
  ShieldAlert,
  ShieldCheck,
  RefreshCw,
  Terminal,
  Database,
  Server,
  Smartphone,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from 'lucide-react';

export interface InlineButtonSpec {
  text: string;
  callbackData: string;
}

export interface BotViewResponse {
  text: string;
  keyboard: InlineButtonSpec[][];
}

export interface SessionRecord {
  id: string;
  label: string;
  masked_phone: string | null;
  jid: string | null;
  status: string;
  auth_dir: string;
  reconnect_attempts: number;
  last_connected_at: string | null;
  last_status_at: string;
  last_error: string | null;
}

export interface TaskResultRecord {
  id: string;
  task_id: string;
  session_id: string;
  status: string;
  result_summary: string | null;
  error_message: string | null;
}

export interface TaskWithResults {
  id: string;
  operation_type: string;
  target_summary: string;
  selectedSessionIds: string[];
  status: string;
  created_at: string;
  completed_at: string | null;
  error_summary: string | null;
  results: TaskResultRecord[];
}

export interface AuditLogRecord {
  id: string;
  actor_telegram_id: number;
  action: string;
  target_id: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  metadata_json: string | null;
  created_at: string;
}

export interface HarnessStateResponse {
  ok: boolean;
  environmentMode: string;
  validationIssues: string[];
  configuredAdminId: number;
  maxConcurrentTasks: number;
  taskTimeoutMs: number;
  maxUploadSizeMb: number;
  botView: BotViewResponse;
  sessions: SessionRecord[];
  tasks: TaskWithResults[];
  auditLogs: AuditLogRecord[];
  health: {
    status: string;
    connectedSessions: number;
    totalSessions: number;
    runningTasks: number;
    pendingTasks: number;
    lastSuccessfulOperationAt: string | null;
  };
}

export default function ControlCenterDashboard({
  initialData,
}: {
  initialData: HarnessStateResponse;
}) {
  const [data, setData] = useState<HarnessStateResponse>(initialData);
  const [busyAction, setBusyAction] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<
    'simulator' | 'sessions_tasks' | 'security_audit' | 'aws_deployment'
  >('simulator');

  const [inputText, setInputText] = useState<string>('');
  const [simulatedUserId, setSimulatedUserId] = useState<number>(
    initialData.configuredAdminId
  );
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [sessionSearch, setSessionSearch] = useState<string>('');

  const fetchHarnessState = useCallback(async () => {
    try {
      const res = await fetch('/api/harness');
      const json = (await res.json()) as HarnessStateResponse;
      if (json.ok) {
        setData(json);
      }
    } catch {
      setErrorBanner('تعذر الاتصال بخادم التطبيق المحلي.');
    }
  }, []);

  const dispatchInteraction = async (
    type: 'callback' | 'text',
    payload: string
  ) => {
    if (!payload.trim()) return;
    setBusyAction(true);
    setErrorBanner(null);

    try {
      const res = await fetch('/api/harness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          actorUserId: simulatedUserId,
          payload,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setErrorBanner(json.error || 'تم رفض العملية.');
        if (json.auditLogs) {
          setData((prev) => ({ ...prev, auditLogs: json.auditLogs }));
        }
      } else {
        setData((prev) => ({
          ...prev,
          botView: json.botView,
          sessions: json.sessions,
          tasks: json.tasks,
          auditLogs: json.auditLogs,
          health: json.health,
        }));
      }
    } catch {
      setErrorBanner('حدث خطأ في الاتصال بالخادم أثناء تنفيذ الأمر.');
    } finally {
      setBusyAction(false);
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    const textToSend = inputText;
    setInputText('');
    await dispatchInteraction('text', textToSend);
  };

  const configuredAdminId = data.configuredAdminId;
  const isAuthorizedActor = simulatedUserId === configuredAdminId;

  const filteredSessions = data.sessions.filter(
    (s) =>
      s.id.toLowerCase().includes(sessionSearch.toLowerCase()) ||
      s.label.toLowerCase().includes(sessionSearch.toLowerCase()) ||
      (s.masked_phone || '').includes(sessionSearch)
  );

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 border-b border-slate-800 bg-slate-900/70">
        <a
          href="#top"
          className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          منظومة التحكم بجلسات واتساب عبر تيليجرام
        </a>

        <nav
          aria-label="التنقل الرئيسي"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-300"
        >
          <button
            type="button"
            onClick={() => setActiveTab('simulator')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'simulator'
                ? 'border-sky-400 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-100'
            }`}
          >
            محاكي بوت تيليجرام
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('sessions_tasks')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 tabular-nums ${
              activeTab === 'sessions_tasks'
                ? 'border-sky-400 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-100'
            }`}
          >
            الجلسات والمهام ({data.sessions.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('security_audit')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'security_audit'
                ? 'border-sky-400 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-100'
            }`}
          >
            سجل التدقيق الأمني
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('aws_deployment')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'aws_deployment'
                ? 'border-sky-400 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-100'
            }`}
          >
            دليل النشر AWS EC2
          </button>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => void dispatchInteraction('text', '/start')}
            className="px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 rounded-lg hover:bg-sky-300 transition-colors whitespace-nowrap shrink-0"
          >
            القائمة الرئيسية (/start)
          </button>
        </div>
      </header>

      {/* Mobile Tab Switcher */}
      <div className="flex md:hidden items-center gap-2 px-4 py-2 border-b border-slate-800 overflow-x-auto bg-slate-900">
        <button
          type="button"
          onClick={() => setActiveTab('simulator')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
            activeTab === 'simulator'
              ? 'bg-sky-500 text-slate-950'
              : 'text-slate-300'
          }`}
        >
          محاكي تيليجرام
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('sessions_tasks')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
            activeTab === 'sessions_tasks'
              ? 'bg-sky-500 text-slate-950'
              : 'text-slate-300'
          }`}
        >
          الجلسات والمهام
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('security_audit')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
            activeTab === 'security_audit'
              ? 'bg-sky-500 text-slate-950'
              : 'text-slate-300'
          }`}
        >
          سجل التدقيق
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('aws_deployment')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
            activeTab === 'aws_deployment'
              ? 'bg-sky-500 text-slate-950'
              : 'text-slate-300'
          }`}
        >
          النشر AWS EC2
        </button>
      </div>

      {/* Main Content Container */}
      <main className="flex-1 max-w-[1380px] w-full mx-auto px-6 py-6 space-y-6">
        {/* Transparent Environment & Architecture Notice (Section 21 Compliance) */}
        <section
          aria-label="حالة بيئة التشغيل"
          className="p-4 rounded-lg border border-slate-800 bg-slate-900/60 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4"
        >
          <div className="space-y-1">
            <h1 className="text-base font-bold text-white">
              بيئة الاختبار التفاعلية المدمجة + الخادم الخلفي الكامل (grammY + Baileys + SQLite)
            </h1>
            <p className="text-xs text-slate-300 leading-relaxed max-w-4xl">
              هذه الواجهة متصلة مباشرة بمحرك <span dir="ltr" className="text-sky-300 font-semibold">TelegramBotController</span> وقاعدة بيانات SQLite الحقيقية (<span dir="ltr" className="text-sky-300">./data/app.sqlite</span>) باستخدام مشغل محاكاة حتمي (<span dir="ltr" className="text-sky-300">MockWhatsAppSessionDriver</span>) لمعاينة جميع القوائم والعمليات المتزامنة محلياً. لتشغيل خدمة بوت تيليجرام الحية والاتصال الفعلي بخوادم واتساب على الخادم، شغّل الأمر <span dir="ltr" className="text-emerald-300 font-semibold">npm run bot:start</span> بعد ضبط ملف <span dir="ltr" className="text-sky-300">.env</span>.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-5 text-xs text-slate-300 shrink-0 tabular-nums">
            <div>
              <span className="text-slate-400">الجلسات المتصلة: </span>
              <strong className="text-emerald-400">
                {data.health.connectedSessions}/{data.health.totalSessions}
              </strong>
            </div>
            <span aria-hidden="true">·</span>
            <div>
              <span className="text-slate-400">التوازي الأقصى: </span>
              <strong className="text-white">{data.maxConcurrentTasks}</strong>
            </div>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => void fetchHarnessState()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-700 hover:bg-slate-800 text-slate-200 transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>تحديث البيانات</span>
            </button>
          </div>
        </section>

        {/* Error Alert Banner if Unauthorized or Invalid Input */}
        {errorBanner && (
          <div
            role="alert"
            className="p-4 rounded-lg border border-red-500/40 bg-red-950/40 text-red-200 flex items-center justify-between gap-4"
          >
            <div className="flex items-center gap-3 text-sm">
              <ShieldAlert className="w-5 h-5 text-red-400 shrink-0" />
              <span>{errorBanner}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="px-3 py-1 text-xs rounded bg-red-900/50 hover:bg-red-900 text-red-100 whitespace-nowrap shrink-0"
            >
              إغلاق التنبيه
            </button>
          </div>
        )}

        {/* TAB 1: Interactive Telegram Bot Simulator + Live State Split */}
        {activeTab === 'simulator' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
            {/* Interactive Telegram Bot Client (7 cols) */}
            <section
              aria-label="واجهة بوت تيليجرام التفاعلية"
              className="lg:col-span-7 flex flex-col rounded-lg border border-slate-800 bg-slate-900 overflow-hidden"
            >
              {/* Simulator Top Control Bar: Admin Allowlist Tester */}
              <div className="p-4 border-b border-slate-800 bg-slate-900/90 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <Terminal className="w-4 h-4 text-sky-400" />
                  <h2 className="text-sm font-bold text-white">
                    محاكي محادثة بوت تيليجرام (Inline Keyboard & Workflows)
                  </h2>
                </div>

                {/* Role / Authorization Switcher to verify Section 11 */}
                <div className="flex items-center gap-1 p-1 bg-slate-950 rounded-lg border border-slate-800 tabular-nums">
                  <button
                    type="button"
                    onClick={() => {
                      setSimulatedUserId(configuredAdminId);
                      setErrorBanner(null);
                    }}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      isAuthorizedActor
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    مسؤول مصرح ({configuredAdminId})
                  </button>
                  <button
                    type="button"
                    onClick={() => setSimulatedUserId(999888777)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      !isAuthorizedActor
                        ? 'bg-red-500/20 text-red-300 border border-red-500/30'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    مستخدم غير مصرح (999888777)
                  </button>
                </div>
              </div>

              {/* Bot Message Screen & Inline Keyboard Buttons */}
              <div className="p-6 flex-1 flex flex-col justify-between space-y-6 bg-slate-950/60">
                <div className="space-y-4">
                  {/* Message Bubble */}
                  <div className="p-5 rounded-lg border border-slate-800 bg-slate-900 text-sm leading-relaxed whitespace-pre-wrap text-slate-100 tabular-nums">
                    {data.botView.text}
                  </div>

                  {/* Inline Keyboard Grid */}
                  <div
                    aria-label="أزرار تيليجرام التفاعلية"
                    className="space-y-2"
                  >
                    {data.botView.keyboard.map((row, rowIdx) => (
                      <div
                        key={rowIdx}
                        className="grid gap-2"
                        style={{
                          gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))`,
                        }}
                      >
                        {row.map((btn) => (
                          <button
                            key={btn.callbackData + btn.text}
                            type="button"
                            disabled={busyAction}
                            onClick={() =>
                              void dispatchInteraction(
                                'callback',
                                btn.callbackData
                              )
                            }
                            className="px-3 py-2.5 text-xs font-semibold text-center rounded-lg border border-slate-700/80 bg-slate-800/90 hover:bg-slate-700/90 hover:border-sky-500/50 text-slate-100 transition-colors truncate disabled:opacity-50"
                          >
                            {btn.text}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Quick Input Helpers & Text Input Bar */}
                <div className="space-y-3 pt-4 border-t border-slate-800">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-slate-400">إدخال سريع للاختبار:</span>
                    <button
                      type="button"
                      onClick={() => setInputText('+966501234567')}
                      className="px-2.5 py-1 rounded border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300 tabular-nums whitespace-nowrap shrink-0"
                    >
                      <span dir="ltr">+966501234567</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setInputText('تنبيه إداري هام: تم تحديث جدول المناوبات اليومي.')
                      }
                      className="px-2.5 py-1 rounded border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300 whitespace-nowrap shrink-0"
                    >
                      نص رسالة تجريبية
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setInputText('https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrSt12')
                      }
                      className="px-2.5 py-1 rounded border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300 whitespace-nowrap shrink-0"
                    >
                      رابط دعوة مجموعة
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setInputText(
                          '/cekidch https://whatsapp.com/channel/0029VaChannelDemo123'
                        )
                      }
                      className="px-2.5 py-1 rounded border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300 whitespace-nowrap shrink-0"
                    >
                      فحص قناة (/cekidch)
                    </button>
                    <button
                      type="button"
                      onClick={() => setInputText('/cekall')}
                      className="px-2.5 py-1 rounded border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300 whitespace-nowrap shrink-0"
                    >
                      <span dir="ltr">/cekall</span>
                    </button>
                  </div>

                  <form onSubmit={handleFormSubmit} className="flex items-center gap-2">
                    <label htmlFor="telegram-chat-input" className="sr-only">
                      إرسال رسالة أو أمر إلى البوت
                    </label>
                    <input
                      id="telegram-chat-input"
                      type="text"
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      placeholder="أدخل رقم الهاتف الدولي (+966...)، نص الرسالة، رابط المجموعة، أو الأمر /start..."
                      className="flex-1 px-4 py-2.5 text-sm rounded-lg border border-slate-700 bg-slate-900 text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
                    />
                    <button
                      type="submit"
                      disabled={busyAction || !inputText.trim()}
                      className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-bold rounded-lg bg-sky-400 text-slate-950 hover:bg-sky-300 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                    >
                      <Send className="w-3.5 h-3.5" />
                      <span>إرسال للبوت</span>
                    </button>
                  </form>
                </div>
              </div>
            </section>

            {/* Secondary Column: Live Sessions & Concurrent Tasks Summary (5 cols) */}
            <section
              aria-label="ملخص الجلسات والمهام الفوري"
              className="lg:col-span-5 flex flex-col justify-between gap-6"
            >
              {/* Sessions Card */}
              <div className="p-5 rounded-lg border border-slate-800 bg-slate-900 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Smartphone className="w-4 h-4 text-sky-400" />
                    <h2 className="text-sm font-bold text-white">
                      الجلسات المعزولة المسجلة (SQLite)
                    </h2>
                  </div>
                  <span className="text-xs text-slate-400 tabular-nums">
                    {data.sessions.length} جلسات
                  </span>
                </div>

                <div className="divide-y divide-slate-800/80">
                  {data.sessions.slice(0, 5).map((sess) => (
                    <div
                      key={sess.id}
                      className="py-3 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="space-y-0.5 min-w-0">
                        <div className="font-semibold text-slate-100 truncate">
                          {sess.label}
                        </div>
                        <div className="text-slate-400 tabular-nums">
                          <span dir="ltr">{sess.id}</span> ·{' '}
                          <span dir="ltr">{sess.masked_phone || 'غير مقترن'}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          void dispatchInteraction('callback', `sess:view:${sess.id}`)
                        }
                        className="px-2.5 py-1 rounded border border-slate-700 hover:bg-slate-800 text-slate-200 whitespace-nowrap shrink-0"
                      >
                        {sess.status === 'CONNECTED' ? '🟢 متصل' : sess.status}
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Recent Concurrent Tasks Card */}
              <div className="p-5 rounded-lg border border-slate-800 bg-slate-900 space-y-4 flex-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Database className="w-4 h-4 text-sky-400" />
                    <h2 className="text-sm font-bold text-white">
                      آخر المهام المتزامنة (TaskManager)
                    </h2>
                  </div>
                  <span className="text-xs text-slate-400 tabular-nums">
                    {data.tasks.length} مهام
                  </span>
                </div>

                {data.tasks.length === 0 ? (
                  <p className="text-xs text-slate-400 py-6 text-center leading-relaxed">
                    لا توجد مهام منفذة بعد. استخدم زر &quot;✉️ إرسال رسالة نصية&quot; أو &quot;🔗 الانضمام إلى مجموعة&quot; من محاكي البوت لتشغيل مهمة متزامنة.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-800/80">
                    {data.tasks.slice(0, 4).map((task) => (
                      <div key={task.id} className="py-3 space-y-1 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-white">
                            {task.operation_type} — {task.target_summary}
                          </span>
                          <span className="text-sky-300 tabular-nums">
                            {task.status}
                          </span>
                        </div>
                        <div className="text-slate-400 tabular-nums">
                          المعرف: <span dir="ltr">{task.id}</span> · الجلسات:{' '}
                          {task.selectedSessionIds.length}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        {/* TAB 2: Full Sessions & Multi-Session Tasks Data Tables */}
        {activeTab === 'sessions_tasks' && (
          <div className="space-y-6">
            <section className="p-6 rounded-lg border border-slate-800 bg-slate-900 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-bold text-white">
                    جدول جلسات واتساب المعزولة (Sessions Repository)
                  </h2>
                  <p className="text-xs text-slate-400">
                    كل جلسة تمتلك معرفاً داخلياً فريداً ومجلد مصادقة معزول بصلاحيات 0700 خارج المسارات العامة.
                  </p>
                </div>
                <div className="w-full sm:w-64">
                  <label htmlFor="session-filter" className="sr-only">
                    بحث في الجلسات
                  </label>
                  <input
                    id="session-filter"
                    type="text"
                    value={sessionSearch}
                    onChange={(e) => setSessionSearch(e.target.value)}
                    placeholder="بحث بالمعرف أو الرقم المقنع..."
                    className="w-full px-3 py-1.5 text-xs rounded border border-slate-700 bg-slate-950 text-white"
                  />
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-right text-xs border-collapse tabular-nums">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400">
                      <th className="py-3 px-3 font-semibold">المعرف</th>
                      <th className="py-3 px-3 font-semibold">التسمية</th>
                      <th className="py-3 px-3 font-semibold">الرقم المقنع</th>
                      <th className="py-3 px-3 font-semibold">الحالة</th>
                      <th className="py-3 px-3 font-semibold">محاولات الاتصال</th>
                      <th className="py-3 px-3 font-semibold">آخر تحديث</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {filteredSessions.map((s) => (
                      <tr key={s.id} className="hover:bg-slate-800/40">
                        <td className="py-3 px-3 text-sky-300">
                          <span dir="ltr">{s.id}</span>
                        </td>
                        <td className="py-3 px-3 text-slate-100">{s.label}</td>
                        <td className="py-3 px-3 text-slate-300">
                          <span dir="ltr">{s.masked_phone || '—'}</span>
                        </td>
                        <td className="py-3 px-3 text-emerald-300">{s.status}</td>
                        <td className="py-3 px-3 text-slate-300">
                          {s.reconnect_attempts}
                        </td>
                        <td className="py-3 px-3 text-slate-400">
                          <span dir="ltr">
                            {s.last_status_at.slice(0, 19).replace('T', ' ')}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="p-6 rounded-lg border border-slate-800 bg-slate-900 space-y-4">
              <h2 className="text-base font-bold text-white">
                سجل المهام المتزامنة ونتائج كل جلسة (Tasks & Per-Session Results)
              </h2>
              {data.tasks.length === 0 ? (
                <p className="text-xs text-slate-400 py-6">
                  لم يتم تسجيل مهام بعد.
                </p>
              ) : (
                <div className="space-y-4">
                  {data.tasks.map((t) => (
                    <div
                      key={t.id}
                      className="p-4 rounded border border-slate-800 bg-slate-950/60 space-y-2 text-xs tabular-nums"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-bold text-white">
                          {t.operation_type} · الهدف: {t.target_summary}
                        </span>
                        <span className="text-sky-300">
                          <span dir="ltr">{t.id}</span> · الحالة: {t.status}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-2">
                        {t.results.map((r) => (
                          <div
                            key={r.id}
                            className="p-2.5 rounded border border-slate-800/80 bg-slate-900 flex items-center justify-between gap-2"
                          >
                            <span className="text-slate-300" dir="ltr">
                              {r.session_id}
                            </span>
                            <span className="text-slate-200 truncate">
                              {r.result_summary || r.error_message || r.status}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {/* TAB 3: Security & Audit Logs */}
        {activeTab === 'security_audit' && (
          <section className="p-6 rounded-lg border border-slate-800 bg-slate-900 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-white">
                  سجل التدقيق الأمني (Audit Logs — خالٍ من الأسرار ومحتوى الرسائل)
                </h2>
                <p className="text-xs text-slate-400">
                  يتم تسجيل جميع محاولات الوصول (المصرحة والمرفوضة)، عمليات ربط الجلسات، وإجراءات المجموعات الحساسة.
                </p>
              </div>
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs border-collapse tabular-nums">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-3 px-3 font-semibold">الوقت</th>
                    <th className="py-3 px-3 font-semibold">معرف تيليجرام</th>
                    <th className="py-3 px-3 font-semibold">الإجراء</th>
                    <th className="py-3 px-3 font-semibold">الهدف</th>
                    <th className="py-3 px-3 font-semibold">النتيجة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {data.auditLogs.map((entry) => (
                    <tr key={entry.id} className="hover:bg-slate-800/40">
                      <td className="py-2.5 px-3 text-slate-400">
                        <span dir="ltr">
                          {entry.created_at.slice(0, 19).replace('T', ' ')}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-slate-200">
                        <span dir="ltr">{entry.actor_telegram_id}</span>
                      </td>
                      <td className="py-2.5 px-3 text-sky-300">
                        <span dir="ltr">{entry.action}</span>
                      </td>
                      <td className="py-2.5 px-3 text-slate-300">
                        <span dir="ltr">{entry.target_id || '—'}</span>
                      </td>
                      <td className="py-2.5 px-3">
                        {entry.outcome === 'SUCCESS' && (
                          <span className="inline-flex items-center gap-1 text-emerald-400">
                            <CheckCircle2 className="w-3.5 h-3.5" /> SUCCESS
                          </span>
                        )}
                        {entry.outcome === 'DENIED' && (
                          <span className="inline-flex items-center gap-1 text-red-400">
                            <XCircle className="w-3.5 h-3.5" /> DENIED
                          </span>
                        )}
                        {entry.outcome === 'FAILURE' && (
                          <span className="inline-flex items-center gap-1 text-amber-400">
                            <AlertTriangle className="w-3.5 h-3.5" /> FAILURE
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* TAB 4: AWS EC2 Ubuntu 24.04 LTS Deployment & Architecture */}
        {activeTab === 'aws_deployment' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="p-6 rounded-lg border border-slate-800 bg-slate-900 space-y-4">
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4 text-sky-400" />
                <h2 className="text-base font-bold text-white">
                  خطوات التشغيل على خادم AWS EC2 (Ubuntu 24.04 LTS)
                </h2>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                تم إعداد ملفات النشر الكاملة في المشروع (<span dir="ltr" className="text-sky-300">scripts/setup.sh</span>، <span dir="ltr" className="text-sky-300">scripts/health-check.sh</span>، <span dir="ltr" className="text-sky-300">systemd/whatsapp-telegram-bot.service</span>، وملفات التوثيق في <span dir="ltr" className="text-sky-300">docs/</span>).
              </p>
              <pre
                dir="ltr"
                className="p-4 rounded bg-slate-950 border border-slate-800 text-xs text-slate-200 overflow-x-auto leading-relaxed"
              >{`# 1. Run setup script (permissions 0700 + dependencies + automated tests)
chmod +x scripts/setup.sh scripts/health-check.sh
./scripts/setup.sh

# 2. Configure secret environment variables safely (mode 0600)
nano .env
chmod 600 .env

# 3. Enable & start systemd service for automatic crash/reboot recovery
sudo cp systemd/whatsapp-telegram-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now whatsapp-telegram-bot.service

# 4. Inspect health and journald logs
./scripts/health-check.sh
sudo journalctl -u whatsapp-telegram-bot.service -f`}</pre>
            </section>

            <section className="p-6 rounded-lg border border-slate-800 bg-slate-900 space-y-4">
              <h2 className="text-base font-bold text-white">
                ضوابط الأمان ومحددات تكامل Baileys
              </h2>
              <ul className="space-y-2.5 text-xs text-slate-300 leading-relaxed list-disc list-inside">
                <li>
                  <strong>التحقق الصارم من المسؤول:</strong> يتم رفض أي مستخدم تيليجرام لا يطابق معرفه الرقمي <span dir="ltr" className="text-sky-300">TELEGRAM_ADMIN_ID</span> في جميع الأوامر والأزرار التفاعلية.
                </li>
                <li>
                  <strong>عزل ملفات المصادقة:</strong> يتم حفظ مفاتيح كل جلسة في مجلد مستقل بصلاحيات <span dir="ltr" className="text-sky-300">0700</span> ولا يتم إرسالها أو طباعتها في السجلات أبداً.
                </li>
                <li>
                  <strong>حجب البيانات الحساسة (Redaction):</strong> يقوم <span dir="ltr" className="text-sky-300">src/security/redaction.ts</span> بحجب توكن البوت، رموز الربط، والمفاتيح الخاصة، وتقنيع أرقام الهواتف تلقائياً.
                </li>
                <li>
                  <strong>تنبيه البروتوكول غير الرسمي:</strong> مكتبة <span dir="ltr" className="text-sky-300">athanasia-baileys (github:AthanasiaCMD/athanasia-baileys)</span> هي تكامل غير رسمي لبروتوكول واتساب ويب؛ يجب أن يظل خادم EC2 قيد التشغيل لاستمرار عمل البوت، وقد تتطلب الجلسات إعادة ربط في حال تغيير بروتوكول واتساب.
                </li>
              </ul>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
