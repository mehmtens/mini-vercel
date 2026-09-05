'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '../lib/api';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(pathname === '/login');

  useEffect(() => {
    if (pathname === '/login') {
      return;
    }

    let active = true;
    api
      .getCurrentUser()
      .then((user) => {
        if (!active) return;
        if (!user) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
        else setReady(true);
      })
      .catch(() => {
        if (active) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      });
    return () => {
      active = false;
    };
  }, [pathname, router]);

  if (pathname !== '/login' && !ready) {
    return (
      <div className="min-h-screen grid place-items-center bg-[#08090a] text-zinc-400">
        <div className="flex items-center gap-3 text-sm">
          <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
          Securing your workspace…
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
