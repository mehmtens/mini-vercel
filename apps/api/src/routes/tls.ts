import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '@doplo/database';
import { config } from '@doplo/config';

const DOMAIN_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const LOCAL_DOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.localhost$/i;
const PREVIEW_LABEL_REGEX = /^(.+)-([0-9a-f]{7,40})$/i;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function denyDomain(reply: FastifyReply, domain: string) {
  return reply.code(403).send({
    allowed: false,
    error: 'Forbidden',
    message: `Domain "${domain}" is not authorized for on-demand TLS certificate issuance`,
  });
}

export async function registerTlsRoutes(app: FastifyInstance) {
  /**
   * Caddy calls this endpoint before issuing or renewing an on-demand
   * certificate. Only hostnames backed by an active project/deployment are
   * accepted, preventing arbitrary wildcard requests from exhausting ACME
   * certificate limits.
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
    const baseDomain = config.app.baseDomain.trim().toLowerCase();
    const appDomain = config.app.domain.trim().toLowerCase();

    if (domain.length > 253 || domain.includes(':') || domain.includes('/')) {
      return denyDomain(reply, domain);
    }

    if (
      !config.isProduction &&
      (domain === 'localhost' ||
        domain === '127.0.0.1' ||
        domain === 'app.localhost' ||
        LOCAL_DOMAIN_REGEX.test(domain))
    ) {
      return reply.code(200).send({ allowed: true, domain });
    }

    if (domain === appDomain || domain === baseDomain) {
      return reply.code(200).send({ allowed: true, domain });
    }

    if (!DOMAIN_REGEX.test(domain)) {
      return denyDomain(reply, domain);
    }

    const suffix = `.${baseDomain}`;
    if (!domain.endsWith(suffix)) {
      // Custom domains require ownership verification and an explicit registry,
      // neither of which exists in the current schema. Fail closed until then.
      return denyDomain(reply, domain);
    }

    const label = domain.slice(0, -suffix.length);
    if (!label || label.includes('.')) {
      return denyDomain(reply, domain);
    }

    try {
      if (label.startsWith('dpl-')) {
        const deploymentId = label.slice(4);
        if (UUID_REGEX.test(deploymentId)) {
          const deployment = await prisma.deployment.findFirst({
            where: { id: deploymentId, status: 'READY' },
            select: { id: true, projectId: true },
          });
          if (deployment) {
            return reply.code(200).send({
              allowed: true,
              domain,
              projectId: deployment.projectId,
              deploymentId: deployment.id,
            });
          }
        }
      }

      const project = await prisma.project.findUnique({
        where: { slug: label },
        select: {
          id: true,
          slug: true,
          currentDeployment: { select: { id: true, status: true } },
        },
      });
      if (project?.currentDeployment?.status === 'READY') {
        return reply.code(200).send({
          allowed: true,
          domain,
          projectId: project.id,
          projectSlug: project.slug,
          deploymentId: project.currentDeployment.id,
        });
      }

      const previewMatch = label.match(PREVIEW_LABEL_REGEX);
      if (previewMatch) {
        const [, projectSlug, shortCommit] = previewMatch;
        const deployment = await prisma.deployment.findFirst({
          where: {
            status: 'READY',
            commitHash: { startsWith: shortCommit },
            project: { slug: projectSlug },
          },
          select: { id: true, projectId: true },
          orderBy: { createdAt: 'desc' },
        });
        if (deployment) {
          return reply.code(200).send({
            allowed: true,
            domain,
            projectId: deployment.projectId,
            deploymentId: deployment.id,
          });
        }
      }
    } catch (dbErr) {
      app.log.error({ dbErr, domain }, 'Error verifying on-demand TLS hostname');
      return reply.code(503).send({
        allowed: false,
        error: 'ServiceUnavailable',
        message: 'TLS authorization is temporarily unavailable',
      });
    }

    return denyDomain(reply, domain);
  };

  app.get('/api/tls/ask', tlsAskHandler);
  app.get('/api/v1/tls/ask', tlsAskHandler);
}
