/**
 * Cloudflare Worker in front of the statically exported Next.js dashboard
 * (apps/web/out, served through the ASSETS binding).
 *
 * The export emits a single shell per dynamic route (/projects/__id__/ and
 * /deployments/__id__/), so requests for a concrete id are rewritten to that
 * shell. The page reads the real id back from the URL on the client.
 */
const SHELL_ROUTES = ['projects', 'deployments'];
const SHELL_ID = '__id__';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);

    if (
      segments.length === 2 &&
      SHELL_ROUTES.includes(segments[0]) &&
      segments[1] !== SHELL_ID
    ) {
      const shellUrl = new URL(url);
      shellUrl.pathname = `/${segments[0]}/${SHELL_ID}/`;
      return env.ASSETS.fetch(new Request(shellUrl, request));
    }

    return env.ASSETS.fetch(request);
  },
};
