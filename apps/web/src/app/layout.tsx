import type { Metadata } from 'next';
import './globals.css';
import { Navbar } from '../components/Navbar';

export const metadata: Metadata = {
  title: 'Mini Vercel | Cloud Deployment & Queue Platform',
  description: 'High-performance cloud platform powered by Next.js, Fastify, BullMQ, Docker, PostgreSQL, and Redis',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#08090a] text-[#ededed] antialiased selection:bg-blue-600 selection:text-white flex flex-col">
        <Navbar />
        <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {children}
        </main>
        <footer className="w-full border-t border-white/[0.06] py-6 text-center text-xs text-zinc-500">
          <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
            <span>Mini Vercel Platform • Fastify, BullMQ, Docker, MinIO, PostgreSQL</span>
            <span>Version 1.0.0-MVP</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
