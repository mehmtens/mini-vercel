/**
 * Cloudflare Workers Builds sets WORKERS_CI=1 and Cloudflare Pages sets CF_PAGES=1.
 * In those environments we emit a fully static build (apps/web/out) that is served
 * from Workers static assets. Everywhere else (local dev, Docker `next start`) the
 * default server build is kept, so the existing self-hosted stack is unaffected.
 */
const staticExport =
  process.env.NEXT_OUTPUT === 'export' ||
  process.env.WORKERS_CI === '1' ||
  process.env.CF_PAGES === '1';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(staticExport
    ? {
        output: 'export',
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
};

export default nextConfig;
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
