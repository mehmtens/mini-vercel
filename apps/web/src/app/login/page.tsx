'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Github, LoaderCircle, Mail } from 'lucide-react';
import { api } from '../../lib/api';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081';

export default function LoginPage() {
  const router = useRouter();
  const [registering, setRegistering] = useState(false);
  const [providers, setProviders] = useState({ email: true, github: false, google: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .getCurrentUser()
      .then((user) => {
        if (user) router.replace('/');
      })
      .catch(() => undefined);
    api
      .getAuthProviders()
      .then(setProviders)
      .catch(() => undefined);
  }, [router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      if (registering) {
        await api.register({
          name: String(data.get('name') || ''),
          email: String(data.get('email') || ''),
          password: String(data.get('password') || ''),
        });
      } else {
        await api.login({
          email: String(data.get('email') || ''),
          password: String(data.get('password') || ''),
        });
      }
      const next = new URLSearchParams(window.location.search).get('next');
      router.replace(next?.startsWith('/') ? next : '/');
      router.refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : 'Sign-in failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function oauth(provider: 'google' | 'github') {
    router.push(`${API_BASE}/api/auth/${provider}/login`);
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#070809] px-5 py-12 text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_-10%,rgba(37,99,235,0.20),transparent_42%)]" />
      <div className="relative mx-auto flex min-h-[calc(100vh-6rem)] max-w-md items-center">
        <section className="w-full rounded-2xl border border-white/10 bg-[#0e1013]/90 p-6 shadow-2xl shadow-black/50 backdrop-blur sm:p-8">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-cyan-400 text-xl font-black shadow-lg shadow-blue-600/20">
              D
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {registering ? 'Create your Doplo account' : 'Welcome to Doplo'}
            </h1>
            <p className="mt-2 text-sm text-zinc-400">Push your code. Doplo handles the rest.</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              disabled={!providers.google}
              onClick={() => oauth('google')}
              className="flex h-11 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] text-sm font-medium transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
              title={!providers.google ? 'Google sign-in is not configured yet' : undefined}
            >
              <span className="text-base font-bold text-blue-400">G</span> Google
            </button>
            <button
              type="button"
              disabled={!providers.github}
              onClick={() => oauth('github')}
              className="flex h-11 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] text-sm font-medium transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
              title={!providers.github ? 'GitHub sign-in is not configured yet' : undefined}
            >
              <Github className="h-4 w-4" /> GitHub
            </button>
          </div>

          <div className="my-6 flex items-center gap-3 text-xs text-zinc-600">
            <span className="h-px flex-1 bg-white/10" />
            OR CONTINUE WITH EMAIL
            <span className="h-px flex-1 bg-white/10" />
          </div>

          <form onSubmit={submit} className="space-y-4">
            {registering && (
              <label className="block text-sm text-zinc-300">
                Name
                <input
                  name="name"
                  autoComplete="name"
                  maxLength={128}
                  className="mt-1.5 h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3 outline-none transition focus:border-blue-500"
                  placeholder="Your name"
                />
              </label>
            )}
            <label className="block text-sm text-zinc-300">
              Email
              <input
                name="email"
                type="email"
                required
                autoComplete="email"
                className="mt-1.5 h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3 outline-none transition focus:border-blue-500"
                placeholder="you@example.com"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Password
              <input
                name="password"
                type="password"
                required
                minLength={10}
                maxLength={128}
                autoComplete={registering ? 'new-password' : 'current-password'}
                className="mt-1.5 h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3 outline-none transition focus:border-blue-500"
                placeholder={registering ? 'At least 10 characters' : 'Your password'}
              />
            </label>
            {error && (
              <p
                role="alert"
                className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-300"
              >
                {error}
              </p>
            )}
            <button
              disabled={loading}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-white font-semibold text-black transition hover:bg-zinc-200 disabled:opacity-60"
            >
              {loading ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Mail className="h-4 w-4" />
              )}
              {registering ? 'Create account' : 'Sign in'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-zinc-400">
            {registering ? 'Already have an account?' : 'New to Doplo?'}{' '}
            <button
              type="button"
              onClick={() => {
                setRegistering(!registering);
                setError('');
              }}
              className="font-medium text-blue-400 hover:text-blue-300"
            >
              {registering ? 'Sign in' : 'Create an account'}
            </button>
          </p>
        </section>
      </div>
    </main>
  );
}
