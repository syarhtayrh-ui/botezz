'use client';

import React from 'react';

export default function GlobalErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ar" dir="rtl">
      <body className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-6">
        <div className="max-w-md w-full rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-4 text-right">
          <h2 className="text-lg font-bold text-rose-400">
            خطأ عام في تشغيل الواجهة
          </h2>
          <p className="text-sm text-slate-300 leading-relaxed">
            {error?.message || 'حدث خطأ غير متوقع. يرجى تحديث الصفحة.'}
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold text-sm transition-colors"
          >
            تحديث الواجهة
          </button>
        </div>
      </body>
    </html>
  );
}
