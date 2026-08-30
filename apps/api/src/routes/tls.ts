import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '@mini-vercel/database';
import { config } from '@mini-vercel/config';

const DOMAIN_REGEX = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const LOCAL_DOMAIN_REGEX = /^[a-zA-Z0-9.-]+\.localhost$/;

export async function registerTlsRoutes(app: FastifyInstance) {
  /**
   * Caddy On-Demand TLS Validation Endpoint
   * Caddy will make an HTTP GET to this endpoint before issuing or renewing an SSL/TLS certificate.
   * Responding with HTTP 200 allows certificate generation.
   * Responding with HTTP 403 / 404 refuses certificate issuance (preventing DDoS / rate-limit exhaustion).
   */
  const tlsAskHandler = async (
    req: FastifyRequest<{ Querystring: { domain?: string } }>,
    reply: FastifyReply
  ) => {
    const rawDomain = req.query.domain;

    if (!rawDomain || typeof rawDomain !== 'string') {
      return reply.code(400).send({
        allowed: false,
        error: 'BadRequest',
        message: 'Query parameter "domain" is required',
      });
    }

    const domain = rawDomain.trim().toLowerCase();

    // 1. Allow local development domains
    if (
      domain === 'localhost' ||
      domain === '127.0.0.1' ||
      domain === 'app.localhost' ||
      LOCAL_DOMAIN_REGEX.test(domain)
    ) {
      return reply.code(200).send({ allowed: true, domain });
    }

    // 2. Allow configured system base domain and app management domain
    const baseDomain = config.app.baseDomain.toLowerCase();
    const appDomain = config.app.domain.toLowerCase();

    if (domain === baseDomain || domain === appDomain || domain.endsWith(`.${baseDomain}`)) {
      return reply.code(200).send({ allowed: true, domain });
    }

    // 3. Query PostgreSQL database for registered custom domains or project slugs
    try {
      const project = await prisma.project.findFirst({
        where: {
          OR: [
            { slug: domain },
            { name: domain },
            { slug: domain.replace(`.${baseDomain}`, '').replace('.localhost', '') },
          ],
        },
        select: { id: true, name: true, slug: true },
      });

      if (project) {
        return reply.code(200).send({
          allowed: true,
          domain,
          projectId: project.id,
          projectSlug: project.slug,
        });
      }
    } catch (dbErr) {
      app.log.error({ dbErr, domain }, 'Error querying database for custom domain verification');
    }

    // 4. Validate domain syntax for external domains
    if (!DOMAIN_REGEX.test(domain) && !domain.includes('.')) {
      return reply.code(403).send({
        allowed: false,
        error: 'Forbidden',
        message: `Domain "${domain}" is not authorized for on-demand TLS certificate issuance`,
      });
    }

    // 5. Unknown or unauthorized custom domain -> Refuse TLS certificate
    return reply.code(403).send({
      allowed: false,
      error: 'Forbidden',
      message: `Domain "${domain}" is not authorized for on-demand TLS certificate issuance`,
    });
  };

  app.get('/api/tls/ask', tlsAskHandler);
  app.get('/api/v1/tls/ask', tlsAskHandler);
}
