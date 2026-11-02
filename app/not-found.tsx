import React from 'react';
import Link from 'next/link';

export default function NotFoundPage() {
  return (
    <div
      dir="rtl"
      className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-6"
    >
      <div className="max-w-md w-full rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-4 text-right">
        <h2 className="text-lg font-bold text-sky-400">الصفحة غير موجودة</h2>
        <p className="text-sm text-slate-300 leading-relaxed">
          المسار المطلوب غير متوفر في لوحة التحكم.
        </p>
        <Link
          href="/"
          className="inline-block px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold text-sm transition-colors"
        >
          العودة إلى لوحة التحكم
        </Link>
      </div>
    </div>
  );
}
