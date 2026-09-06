/**
 * Placeholder id used by `generateStaticParams` so that a single HTML shell is
 * emitted per dynamic route in the static (Cloudflare Workers) build.
 */
export const STATIC_ROUTE_ID = '__id__';

/**
 * Resolve the real record id for a dynamic route.
 *
 * In the server build `useParams()` already returns the correct value. In the
 * static build every `/projects/:id` request is served from the single
 * `/projects/__id__/` shell, so the id has to come from the browser URL.
 */
export function resolveRouteId(paramId?: string | string[] | null): string {
  const raw = Array.isArray(paramId) ? paramId[0] : paramId;
  if (raw && raw !== STATIC_ROUTE_ID) return raw;
  if (typeof window === 'undefined') return '';
  const segments = window.location.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  return last && last !== STATIC_ROUTE_ID ? decodeURIComponent(last) : '';
}
