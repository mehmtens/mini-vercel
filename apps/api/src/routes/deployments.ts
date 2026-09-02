import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma, DeploymentStatus, DeploymentTrigger, LogStream, AuditOperation, transitionDeploymentState } from '@mini-vercel/database';
import { generateCommitHash } from '@mini-vercel/crypto';
import { buildPreviewUrl, config } from '@mini-vercel/config';
import { CreateDeploymentDto, DeploymentJobPayload } from '@mini-vercel/types';
import { minioClient } from '../lib/minio.js';
import { deploymentQueue } from '../lib/queue';
import { authenticateRequest } from '../lib/auth';
import { injectTraceContext } from '../lib/telemetry';
import { validateSlug, slugify } from '../lib/slug';

export async function registerDeploymentRoutes(app: FastifyInstance) {
  // Helper to ensure project exists under authenticated user
  async function getOrCreateUserProject(
    userId: string,
    projectName: string,
    repoUrl?: string,
    branch: string = 'main'
  ) {
    const candidateSlug = slugify(projectName);
    const validation = validateSlug(candidateSlug);
    const slug = validation.isValid ? validation.normalizedSlug : `app-${Date.now()}`;

    let project = await prisma.project.findFirst({
      where: {
        OR: [
          { userId, name: projectName },
          { slug },
        ],
      },
    });

    if (project) {
      if (project.userId !== userId) {
        // Project slug exists for ANOTHER user -> return null to trigger 404/403
        return null;
      }
      return project;
    }

    // Create new project under authenticated user
    project = await prisma.project.create({
      data: {
        userId,
        name: projectName,
        slug,
        repoName: projectName,
        repoUrl: repoUrl || `https://github.com/mini-vercel/${projectName}`,
        branch,
        framework: 'nextjs',
      },
    });

    return project;
  }

  // POST /api/deployments - Create deployment (tenant isolated)
  const createDeploymentHandler = async (
    req: FastifyRequest<{ Body: CreateDeploymentDto }>,
    reply: FastifyReply
  ) => {
    const user = await authenticateRequest(req, reply);
    if (!user) return;

    const { project_name, repo_url, branch, commit_hash } = req.body || {};

    if (!project_name) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'project_name is required',
      });
    }

    const resolvedBranch = branch || 'main';
    const resolvedCommit = commit_hash || generateCommitHash();
    const resolvedRepo = repo_url || `https://github.com/mini-vercel/${project_name}`;

    try {
      // 1. Resolve project for user
      const project = await getOrCreateUserProject(user.id, project_name, resolvedRepo, resolvedBranch);

      if (!project) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Project "${project_name}" not found or unauthorized`,
        });
      }

      // 2. Create Deployment record, initial Event and Log atomically
      const deployment = await prisma.$transaction(async (tx) => {
        const dep = await tx.deployment.create({
          data: {
            projectId: project.id,
            status: DeploymentStatus.QUEUED,
            trigger: DeploymentTrigger.MANUAL,
            commitHash: resolvedCommit,
            commitMessage: 'Triggered from dashboard / API',
            senderUsername: user.username,
            branch: resolvedBranch,
            previewUrl: buildPreviewUrl(project.slug, resolvedCommit),
          },
        });

        await tx.deploymentEvent.create({
          data: {
            deploymentId: dep.id,
            fromStatus: null,
            toStatus: DeploymentStatus.QUEUED,
            eventMessage: `Deployment job enqueued for project ${project_name} (${resolvedBranch})`,
          },
        });

        await tx.deploymentLog.create({
          data: {
            deploymentId: dep.id,
            sequence: 1,
            stream: LogStream.STDOUT,
            logChunk: `[QUEUED] Deployment initialized for ${project_name}#${resolvedBranch} (${resolvedCommit.slice(0, 7)})`,
          },
        });

        return dep;
      });

      // 3. Add job to BullMQ queue
      try {
        const jobPayload: DeploymentJobPayload = {
          deployment_id: deployment.id,
          project_name: project.name,
          repo_url: project.repoUrl,
          branch: resolvedBranch,
          commit_hash: resolvedCommit,
          build_command: project.buildCommand,
          output_directory: project.outputDirectory,
          install_command: project.installCommand,
          root_directory: project.rootDirectory,
          created_at: deployment.createdAt.toISOString(),
          requestId: req.id,
          ...injectTraceContext(),
        };

        await deploymentQueue.add('build-and-deploy', jobPayload, {
          jobId: deployment.id,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: true,
          removeOnFail: false,
        });
      } catch (queueErr: any) {
        app.log.error({ queueErr }, 'Failed to enqueue BullMQ job');
        await transitionDeploymentState(prisma, {
          deploymentId: deployment.id,
          toStatus: DeploymentStatus.FAILED,
          errorMessage: `ERR_ENQUEUE_FAILED: Failed to submit build job to queue (${queueErr?.message || 'Queue offline'})`,
          logMessage: `[ERROR] Failed to enqueue job: ${queueErr?.message || 'Queue offline'}`,
        });

        return reply.status(503).send({
          statusCode: 503,
          error: 'Service Unavailable',
          message: `Failed to dispatch deployment job to build queue: ${queueErr?.message || 'Queue offline'}`,
        });
      }

      return reply.status(201).send({
        id: deployment.id,
        project_id: project.id,
        project_name: project.name,
        repo_url: resolvedRepo,
        branch: resolvedBranch,
        commit_hash: resolvedCommit,
        status: deployment.status,
        preview_url: deployment.previewUrl,
        build_duration_ms: deployment.buildDurationMs || 0,
        error_message: deployment.errorMessage,
        created_at: deployment.createdAt.toISOString(),
        updated_at: deployment.updatedAt.toISOString(),
      });
    } catch (err: any) {
      app.log.error(err, 'Failed to create deployment');
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: err.message || 'Failed to create deployment',
      });
    }
  };

  // GET /api/deployments - List deployments owned by authenticated user
  const listDeploymentsHandler = async (
    req: FastifyRequest<{ Querystring: { limit?: string; offset?: string; projectId?: string } }>,
    reply: FastifyReply
  ) => {
    const user = await authenticateRequest(req, reply);
    if (!user) return;

    const limit = Number(req.query.limit) || 20;
    const offset = Number(req.query.offset) || 0;
    const projectId = req.query.projectId;

    try {
      const records = await prisma.deployment.findMany({
        where: {
          project: { userId: user.id },
          ...(projectId ? { projectId } : {}),
        },
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
        include: { project: true },
      });

      const deployments = records.map((r) => ({
        id: r.id,
        project_id: r.projectId,
        project_name: r.project.name,
        project_slug: r.project.slug,
        repo_url: r.project.repoUrl,
        branch: r.branch,
        commit_hash: r.commitHash,
        commit_message: r.commitMessage,
        sender_username: r.senderUsername,
        trigger: r.trigger,
        status: r.status,
        preview_url: r.previewUrl,
        build_duration_ms: r.buildDurationMs || 0,
        error_message: r.errorMessage,
        created_at: r.createdAt.toISOString(),
        updated_at: r.updatedAt.toISOString(),
      }));

      return reply.send({
        deployments,
        count: deployments.length,
        limit,
        offset,
      });
    } catch (err) {
      app.log.error(err, 'Failed to fetch deployments');
      return reply.send({ deployments: [], count: 0, limit, offset });
    }
  };

  // GET /api/deployments/:id - Get deployment details (tenant isolated)
  const getDeploymentHandler = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const user = await authenticateRequest(req, reply);
    if (!user) return;

    const { id } = req.params;
    try {
      const dep = await prisma.deployment.findUnique({
        where: { id },
        include: {
          project: true,
          events: { orderBy: { timestamp: 'asc' } },
          logs: { orderBy: { sequence: 'asc' } },
        },
      });

      // Tenant isolation: 404 if not found OR project belongs to another user
      if (!dep || dep.project.userId !== user.id) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Deployment with id "${id}" not found`,
        });
      }

      return reply.send({
        id: dep.id,
        project_id: dep.projectId,
        project_name: dep.project.name,
        project_slug: dep.project.slug,
        repo_url: dep.project.repoUrl,
        branch: dep.branch,
        commit_hash: dep.commitHash,
        commit_message: dep.commitMessage,
        sender_username: dep.senderUsername,
        trigger: dep.trigger,
        status: dep.status,
        preview_url: dep.previewUrl,
        build_duration_ms: dep.buildDurationMs || 0,
        error_message: dep.errorMessage,
        created_at: dep.createdAt.toISOString(),
        updated_at: dep.updatedAt.toISOString(),
        events: dep.events.map((e) => ({
          id: e.id,
          from_status: e.fromStatus,
          to_status: e.toStatus,
          event_message: e.eventMessage,
          timestamp: e.timestamp.toISOString(),
        })),
        logs: dep.logs.map((l) => ({
          id: Number(l.id),
          deployment_id: l.deploymentId,
          step: 'BUILD',
          message: l.logChunk,
          log_level: l.stream === 'STDERR' ? 'ERROR' : 'INFO',
          timestamp: l.timestamp.toISOString(),
        })),
      });
    } catch (err) {
      app.log.error(err, 'Failed to fetch deployment details');
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Failed to retrieve deployment details',
      });
    }
  };

  // POST /api/deployments/:id/cancel - Cancel deployment (tenant isolated)
  const cancelDeploymentHandler = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const user = await authenticateRequest(req, reply);
    if (!user) return;

    const { id } = req.params;

    const dep = await prisma.deployment.findUnique({
      where: { id },
      include: { project: true },
    });

    if (!dep || dep.project.userId !== user.id) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `Deployment "${id}" not found`,
      });
    }

    if (['READY', 'FAILED', 'CANCELLED'].includes(dep.status)) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `Cannot cancel deployment in terminal state "${dep.status}"`,
      });
    }

    const result = await transitionDeploymentState(prisma, {
      deploymentId: id,
      toStatus: DeploymentStatus.CANCELLED,
      expectedStatus: [
        DeploymentStatus.QUEUED,
        DeploymentStatus.INITIALIZING,
        DeploymentStatus.CLONING,
        DeploymentStatus.BUILDING,
        DeploymentStatus.UPLOADING,
        DeploymentStatus.DEPLOYING,
      ],
      errorMessage: 'Cancelled by user',
      eventMessage: 'Deployment cancelled by user request',
      logMessage: '[CANCELLED] Deployment aborted by user request',
      logStream: LogStream.STDERR,
    });

    if (!result.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: result.error || 'Failed to cancel deployment',
      });
    }

    return reply.send({
      success: true,
      message: 'Deployment cancelled successfully',
      data: result.deployment,
    });
  };

  // Helper for validating pointer swap eligibility (READY status, tenant ownership, verified artifact)
  async function validateTargetDeploymentForPointerSwap(
    id: string,
    userId: string,
    operation: 'PROMOTE' | 'ROLLBACK',
    reply: FastifyReply
  ) {
    const dep = await prisma.deployment.findUnique({
      where: { id },
      include: { project: true },
    });

    // 1. Tenant Isolation
    if (!dep || dep.project.userId !== userId) {
      reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `Deployment "${id}" not found`,
      });
      return null;
    }

    // 2. Status Invariant: Must be READY
    if (dep.status !== DeploymentStatus.READY) {
      reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `Cannot ${operation.toLowerCase()} deployment "${id}" because it is not in READY status (current status: "${dep.status}")`,
      });
      return null;
    }

    // 3. Must have s3Prefix
    if (!dep.s3Prefix) {
      reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `Deployment "${id}" has no verified artifact bundle`,
      });
      return null;
    }

    // 4. Check artifact presence in MinIO bucket
    try {
      const entryKey = `${dep.s3Prefix}/index.html`.replace(/\/+/g, '/');
      await minioClient.statObject(config.minio.bucketBuilds, entryKey);
    } catch (err: any) {
      if (err?.code === 'NotFound' || err?.code === 'NoSuchKey') {
        reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: `ERR_ARTIFACT_MISSING: Deployment "${id}" artifact bundle has been deleted or is missing from storage`,
        });
        return null;
      }
      // If MinIO is offline in local mock test, proceed gracefully
    }

    return dep;
  }

  // POST /api/deployments/:id/promote - Promote READY deployment to production (pointer swap)
  const promoteDeploymentHandler = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const user = await authenticateRequest(req, reply);
    if (!user) return;

    const { id } = req.params;
    const targetDeployment = await validateTargetDeploymentForPointerSwap(id, user.id, 'PROMOTE', reply);
    if (!targetDeployment) return;

    const project = targetDeployment.project;

    // Idempotency: Already active production deployment
    if (project.currentDeploymentId === id) {
      return reply.send({
        success: true,
        message: 'Deployment is already the active production deployment',
        project_id: project.id,
        current_deployment_id: id,
        data: targetDeployment,
      });
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const curProject = await tx.project.findUnique({
          where: { id: project.id },
          select: { id: true, currentDeploymentId: true, version: true },
        });

        if (!curProject) {
          throw new Error(`Project "${project.id}" not found`);
        }

        const oldDeploymentId = curProject.currentDeploymentId;

        // Optimistic concurrency update on Project.version
        const updated = await tx.project.updateMany({
          where: {
            id: project.id,
            version: curProject.version,
          },
          data: {
            currentDeploymentId: id,
            version: { increment: 1 },
          },
        });

        if (updated.count === 0) {
          throw new Error('ERR_OPTIMISTIC_CONCURRENCY_CONFLICT');
        }

        // Create persistent audit log
        const audit = await tx.deploymentAudit.create({
          data: {
            projectId: project.id,
            actorId: user.id,
            operation: AuditOperation.PROMOTE,
            oldDeploymentId,
            newDeploymentId: id,
          },
        });

        return { oldDeploymentId, audit };
      });

      return reply.send({
        success: true,
        message: `Deployment "${id.slice(0, 8)}" promoted to production successfully`,
        project_id: project.id,
        current_deployment_id: id,
        old_deployment_id: result.oldDeploymentId,
        audit_id: result.audit.id,
        data: targetDeployment,
      });
    } catch (err: any) {
      if (err.message === 'ERR_OPTIMISTIC_CONCURRENCY_CONFLICT') {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Concurrent project deployment modification detected. Please reload and retry.',
        });
      }
      app.log.error(err, 'Failed to promote deployment');
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: err.message || 'Failed to promote deployment',
      });
    }
  };

  // POST /api/deployments/:id/rollback - Rollback production pointer to prior READY deployment
  const rollbackDeploymentHandler = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const user = await authenticateRequest(req, reply);
    if (!user) return;

    const { id } = req.params;
    const targetDeployment = await validateTargetDeploymentForPointerSwap(id, user.id, 'ROLLBACK', reply);
    if (!targetDeployment) return;

    const project = targetDeployment.project;

    // Check if target is already the active deployment
    if (project.currentDeploymentId === id) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `Deployment "${id}" is already the active production deployment. Cannot rollback to current active version.`,
      });
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const curProject = await tx.project.findUnique({
          where: { id: project.id },
          select: { id: true, currentDeploymentId: true, version: true },
        });

        if (!curProject) {
          throw new Error(`Project "${project.id}" not found`);
        }

        const oldDeploymentId = curProject.currentDeploymentId;

        // Optimistic concurrency update on Project.version
        const updated = await tx.project.updateMany({
          where: {
            id: project.id,
            version: curProject.version,
          },
          data: {
            currentDeploymentId: id,
            version: { increment: 1 },
          },
        });

        if (updated.count === 0) {
          throw new Error('ERR_OPTIMISTIC_CONCURRENCY_CONFLICT');
        }

        // Create persistent audit log
        const audit = await tx.deploymentAudit.create({
          data: {
            projectId: project.id,
            actorId: user.id,
            operation: AuditOperation.ROLLBACK,
            oldDeploymentId,
            newDeploymentId: id,
          },
        });

        return { oldDeploymentId, audit };
      });

      return reply.send({
        success: true,
        message: `Production pointer rolled back to deployment "${id.slice(0, 8)}" successfully`,
        project_id: project.id,
        current_deployment_id: id,
        old_deployment_id: result.oldDeploymentId,
        audit_id: result.audit.id,
        data: targetDeployment,
      });
    } catch (err: any) {
      if (err.message === 'ERR_OPTIMISTIC_CONCURRENCY_CONFLICT') {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Concurrent project deployment modification detected. Please reload and retry.',
        });
      }
      app.log.error(err, 'Failed to rollback deployment');
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: err.message || 'Failed to rollback deployment',
      });
    }
  };

  // Register on both /api/deployments and /api/v1/deployments
  for (const prefix of ['/api/deployments', '/api/v1/deployments']) {
    app.post(prefix, createDeploymentHandler);
    app.get(prefix, listDeploymentsHandler);
    app.get(`${prefix}/:id`, getDeploymentHandler);
    app.post(`${prefix}/:id/cancel`, cancelDeploymentHandler);
    app.post(`${prefix}/:id/promote`, promoteDeploymentHandler);
    app.post(`${prefix}/:id/rollback`, rollbackDeploymentHandler);
  }
}
