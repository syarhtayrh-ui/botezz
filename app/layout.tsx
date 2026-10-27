import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'WhatsApp Multi-Session Telegram Control System',
  description:
    'Production-grade WhatsApp Multi-Session Management System controlled through an Arabic Telegram Bot using Baileys, grammY, SQLite, and bounded concurrent task execution.',
  openGraph: {
    title: 'WhatsApp Multi-Session Telegram Control System',
    description:
      'Production-grade WhatsApp Multi-Session Management System controlled through an Arabic Telegram Bot using Baileys, grammY, SQLite, and bounded concurrent task execution.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'WhatsApp Multi-Session Telegram Control System',
    description:
      'Production-grade WhatsApp Multi-Session Management System controlled through an Arabic Telegram Bot using Baileys, grammY, SQLite, and bounded concurrent task execution.',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ar" dir="rtl">
      <body
        suppressHydrationWarning
        className="min-h-screen bg-slate-950 text-slate-100 antialiased selection:bg-sky-500/30 selection:text-sky-200"
        style={{
          fontFamily: '"Cairo", "Segoe UI", Tahoma, Geneva, Verdana, sans-serif',
        }}
      >
        {children}
      </body>
    </html>
  );
}
