import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'path';
import { prisma } from '@doplo/database';
import { config } from '@doplo/config';
import { minioClient } from '../lib/minio.js';

export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.woff2':
      return 'font/woff2';
    case '.woff':
      return 'font/woff';
    case '.ttf':
      return 'font/ttf';
    case '.wasm':
      return 'application/wasm';
    case '.xml':
      return 'application/xml';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.map':
      return 'application/json';
    default:
      return 'application/octet-stream';
  }
}

export function getCacheControl(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const isEntryFile =
    normalized === 'index.html' ||
    normalized.endsWith('.html') ||
    normalized === 'manifest.json' ||
    normalized === 'robots.txt' ||
    normalized === 'sw.js' ||
    normalized === 'service-worker.js';

  if (isEntryFile) {
    return 'public, max-age=0, must-revalidate';
  }

  // Immutable hashed assets, images, fonts
  return 'public, max-age=31536000, immutable';
}

interface ResolvedDeploymentInfo {
  deploymentId: string;
  projectId: string;
  s3Prefix: string;
  status: string;
}

/**
 * Resolves deployment from Host header, preview subdomain, or explicit route parameter
 */
export async function resolveDeploymentFromRequest(
  req: FastifyRequest,
  explicitDeploymentId?: string
): Promise<ResolvedDeploymentInfo | null> {
  const isUuid = (str: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

  // 1. Explicit Deployment ID resolution
  if (explicitDeploymentId && isUuid(explicitDeploymentId)) {
    const deployment = await prisma.deployment.findUnique({
      where: { id: explicitDeploymentId },
      select: { id: true, projectId: true, s3Prefix: true, status: true },
    });
    if (deployment) {
      return {
        deploymentId: deployment.id,
        projectId: deployment.projectId,
        s3Prefix: deployment.s3Prefix || `artifacts/${deployment.projectId}/${deployment.id}`,
        status: deployment.status,
      };
    }
  }

  // 2. Extract Hostname (e.g. my-app-0123456.example.com, my-app.localhost)
  const hostHeader = (req.headers.host || '').split(':')[0].toLowerCase();
  const xForwardedHost = (
    typeof req.headers['x-forwarded-host'] === 'string'
      ? req.headers['x-forwarded-host']
      : ''
  )
    .split(':')[0]
    .toLowerCase();

  const host = xForwardedHost || hostHeader;
  const baseDomain = config.app.baseDomain.toLowerCase();
  const appDomain = config.app.domain.toLowerCase();
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === appDomain) {
    return null;
  }

  // Extract subdomain prefix before root domain
  // e.g. "my-app-0123456.example.com" -> "my-app-0123456"
  // e.g. "my-app-0123456.localhost" -> "my-app-0123456"
  let subdomain = '';
  const configuredSuffix = `.${baseDomain}`;
  if (host.endsWith(configuredSuffix)) {
    subdomain = host.slice(0, -configuredSuffix.length);
  } else {
    // Custom domain or single-label subdomain
    const parts = host.split('.');
    subdomain = parts[0];
  }

  if (!subdomain) return null;

  // 3. Match explicit dpl-<id> format
  if (subdomain.startsWith('dpl-')) {
    const rawId = subdomain.slice(4);
    if (isUuid(rawId)) {
      const dep = await prisma.deployment.findUnique({
        where: { id: rawId },
        select: { id: true, projectId: true, s3Prefix: true, status: true },
      });
      if (dep) {
        return {
          deploymentId: dep.id,
          projectId: dep.projectId,
          s3Prefix: dep.s3Prefix || `artifacts/${dep.projectId}/${dep.id}`,
          status: dep.status,
        };
      }
    }
  }

  // 4. Match Production Hostname format directly: <project-slug> (e.g. "my-app")
  const project = await prisma.project.findUnique({
    where: { slug: subdomain },
    select: {
      id: true,
      currentDeploymentId: true,
      currentDeployment: {
        select: { id: true, projectId: true, s3Prefix: true, status: true },
      },
    },
  });

  if (project?.currentDeployment) {
    return {
      deploymentId: project.currentDeployment.id,
      projectId: project.currentDeployment.projectId,
      s3Prefix:
        project.currentDeployment.s3Prefix ||
        `artifacts/${project.currentDeployment.projectId}/${project.currentDeployment.id}`,
      status: project.currentDeployment.status,
    };
  }

  // 5. Match Preview Hostname format: <project-slug>-<shortSha> (e.g. "my-app-0123456")
  const previewMatch = subdomain.match(/^(.+)-([0-9a-f]{7,40})$/i);
  if (previewMatch) {
    const projectSlug = previewMatch[1];
    const shortSha = previewMatch[2];

    const deployment = await prisma.deployment.findFirst({
      where: {
        commitHash: { startsWith: shortSha },
        project: { slug: projectSlug },
      },
      select: { id: true, projectId: true, s3Prefix: true, status: true },
      orderBy: { createdAt: 'desc' },
    });

    if (deployment) {
      return {
        deploymentId: deployment.id,
        projectId: deployment.projectId,
        s3Prefix: deployment.s3Prefix || `artifacts/${deployment.projectId}/${deployment.id}`,
        status: deployment.status,
      };
    }
  }

  return null;
}

/**
 * Handles artifact retrieval from private MinIO S3 bucket and sends response
 */
export async function handleArtifactRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  deploymentInfo: ResolvedDeploymentInfo,
  rawSubPath: string
): Promise<void> {
  // 1. Verify Deployment Status is READY
  if (deploymentInfo.status !== 'READY') {
    reply.status(403).send({
      error: 'DeploymentNotReady',
      message: `Deployment "${deploymentInfo.deploymentId}" is not ready to serve traffic. Current status: "${deploymentInfo.status}".`,
    });
    return;
  }

  // 2. Validate Path Traversal & Normalize
  let decodedPath = '';
  try {
    decodedPath = decodeURIComponent(rawSubPath);
  } catch {
    reply.status(400).send({ error: 'BadRequest', message: 'Malformed URL encoding' });
    return;
  }

  // Check for dangerous path characters
  if (
    decodedPath.includes('\0') ||
    decodedPath.includes('\\') ||
    decodedPath.includes('/../') ||
    decodedPath.startsWith('../') ||
    decodedPath.includes('..')
  ) {
    reply.status(400).send({ error: 'BadRequest', message: 'Path traversal attempt detected' });
    return;
  }

  // Normalize path
  const normalized = path.posix.normalize('/' + decodedPath);
  if (normalized.startsWith('/..')) {
    reply.status(400).send({ error: 'BadRequest', message: 'Path traversal attempt detected' });
    return;
  }

  let cleanPath = normalized.replace(/^\/+/, '');
  if (!cleanPath || cleanPath.endsWith('/')) {
    cleanPath += 'index.html';
  }

  const bucket = config.minio.bucketBuilds;
  const targetS3Key = `${deploymentInfo.s3Prefix}/${cleanPath}`.replace(/\/+/g, '/');

  // 3. Try to serve exact object from MinIO
  try {
    const stat = await minioClient.statObject(bucket, targetS3Key);
    const etag = stat.etag ? `"${stat.etag.replace(/"/g, '')}"` : undefined;

    // Handle 304 Not Modified conditional requests
    if (etag && req.headers['if-none-match'] === etag) {
      reply.status(304).send();
      return;
    }

    const contentType = getMimeType(cleanPath);
    const cacheControl = getCacheControl(cleanPath);

    reply.header('Content-Type', contentType);
    reply.header('Cache-Control', cacheControl);
    if (etag) reply.header('ETag', etag);
    reply.header('X-Content-Type-Options', 'nosniff');

    const stream = await minioClient.getObject(bucket, targetS3Key);
    return reply.send(stream);
  } catch (err: any) {
    // 4. SPA Client-Side Route Fallback: If not found and not a static asset, serve index.html
    const hasExtension = path.extname(cleanPath).length > 0;
    const isHtml = cleanPath.endsWith('.html');

    if (!hasExtension || isHtml) {
      const fallbackKey = `${deploymentInfo.s3Prefix}/index.html`.replace(/\/+/g, '/');
      try {
        const indexStat = await minioClient.statObject(bucket, fallbackKey);
        const indexEtag = indexStat.etag ? `"${indexStat.etag.replace(/"/g, '')}"` : undefined;

        if (indexEtag && req.headers['if-none-match'] === indexEtag) {
          reply.status(304).send();
          return;
        }

        reply.header('Content-Type', 'text/html; charset=utf-8');
        reply.header('Cache-Control', 'public, max-age=0, must-revalidate');
        if (indexEtag) reply.header('ETag', indexEtag);
        reply.header('X-Content-Type-Options', 'nosniff');

        const indexStream = await minioClient.getObject(bucket, fallbackKey);
        return reply.status(200).send(indexStream);
      } catch {}
    }

    reply.status(404).send({
      error: 'NotFound',
      message: `Artifact "${cleanPath}" not found for deployment "${deploymentInfo.deploymentId}".`,
    });
  }
}

/**
 * Registers Fastify Artifact Gateway routes
 */
export async function registerGatewayRoutes(app: FastifyInstance): Promise<void> {
  // Global path traversal guard for preview and artifact routes
  app.addHook('onRequest', async (req, reply) => {
    const rawUrl = req.raw.url || req.url || '';
    if (
      rawUrl.includes('/..') ||
      rawUrl.includes('../') ||
      rawUrl.includes('%2e%2e') ||
      rawUrl.includes('%2E%2E') ||
      rawUrl.includes('\0') ||
      rawUrl.includes('\\')
    ) {
      return reply.status(400).send({
        error: 'BadRequest',
        message: 'Path traversal attempt detected',
      });
    }
  });

  // Explicit preview route by deployment ID
  app.get('/preview/:deploymentId', async (req: FastifyRequest<{ Params: { deploymentId: string } }>, reply) => {
    const deploymentInfo = await resolveDeploymentFromRequest(req, req.params.deploymentId);
    if (!deploymentInfo) {
      return reply.status(404).send({ error: 'NotFound', message: 'Deployment not found' });
    }
    return handleArtifactRequest(req, reply, deploymentInfo, 'index.html');
  });

  app.get('/preview/:deploymentId/*', async (req: FastifyRequest<{ Params: { deploymentId: string; '*': string } }>, reply) => {
    const deploymentInfo = await resolveDeploymentFromRequest(req, req.params.deploymentId);
    if (!deploymentInfo) {
      return reply.status(404).send({ error: 'NotFound', message: 'Deployment not found' });
    }
    return handleArtifactRequest(req, reply, deploymentInfo, req.params['*'] || 'index.html');
  });

  // Root path handler for subdomain routing
  const rootGatewayHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.raw.url || req.url;

    // Ignore core API routes
    if (
      url.startsWith('/api') ||
      url.startsWith('/health') ||
      url.startsWith('/auth') ||
      url.startsWith('/webhooks') ||
      url.startsWith('/preview')
    ) {
      return reply.status(404).send({ error: 'NotFound', message: 'API route not found' });
    }

    const deploymentInfo = await resolveDeploymentFromRequest(req);
    if (!deploymentInfo) {
      return reply.status(404).send({
        error: 'NotFound',
        message: 'No active deployment found for this hostname.',
      });
    }

    return handleArtifactRequest(req, reply, deploymentInfo, 'index.html');
  };

  app.get('/', rootGatewayHandler);

  // Global wildcard catch-all for subdomain routing
  app.get('/*', async (req: FastifyRequest<{ Params: { '*': string } }>, reply) => {
    const url = req.raw.url || req.url;

    // Ignore core API routes
    if (
      url.startsWith('/api') ||
      url.startsWith('/health') ||
      url.startsWith('/auth') ||
      url.startsWith('/webhooks') ||
      url.startsWith('/preview')
    ) {
      return reply.status(404).send({ error: 'NotFound', message: 'API route not found' });
    }

    const deploymentInfo = await resolveDeploymentFromRequest(req);
    if (!deploymentInfo) {
      return reply.status(404).send({
        error: 'NotFound',
        message: 'No active deployment found for this hostname.',
      });
    }

    const subPath = req.params['*'] || 'index.html';
    return handleArtifactRequest(req, reply, deploymentInfo, subPath);
  });
}
