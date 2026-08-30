import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma, EnvTarget } from '@mini-vercel/database';
import { encrypt, decrypt } from '@mini-vercel/crypto';
import { config } from '@mini-vercel/config';
import { validateSlug, slugify } from '../lib/slug';
import { authenticateRequest } from '../lib/auth';

interface CreateProjectBody {
  name: string;
  slug?: string;
  repoName?: string;
  repoUrl: string;
  branch?: string;
  rootDirectory?: string;
  buildCommand?: string;
  outputDirectory?: string;
  installCommand?: string;
  framework?: string;
  userId?: string;
}

interface UpdateProjectBody extends Partial<CreateProjectBody> {}

interface CreateEnvVarBody {
  key: string;
  value: string;
  target?: 'PRODUCTION' | 'PREVIEW' | 'ALL';
}

export async function registerProjectRoutes(app: FastifyInstance) {
  // GET /api/projects - List projects owned by the authenticated user
  const listProjects = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticateRequest(req, reply);
    if (!user) return;

    const projects = await prisma.project.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
      include: {
        currentDeployment: {
          select: {
            id: true,
            status: true,
            commitHash: true,
            previewUrl: true,
            createdAt: true,
          },
        },
        _count: {
          select: {
            deployments: true,
            envVars: true,
          },
        },
      },
    });

    return reply.code(200).send({
      success: true,
      data: projects,
      total: projects.length,
    });
  };

  // POST /api/projects - Create project with centralized slug validation
  const createProject = async (
    req: FastifyRequest<{ Body: CreateProjectBody }>,
    reply: FastifyReply
  ) => {
    const user = await authenticateRequest(req, reply);
    if (!user) return;

    const {
      name,
      slug: customSlug,
      repoName,
      repoUrl,
      branch = 'main',
      rootDirectory = '/',
      buildCommand = 'npm run build',
      outputDirectory = 'dist',
      installCommand = 'npm install',
      framework = 'auto',
    } = req.body || {};

    if (!name || !repoUrl) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Name and repoUrl are required fields',
      });
    }

    const candidateSlug = customSlug || slugify(name);
    const validation = validateSlug(candidateSlug);

    if (!validation.isValid) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: validation.error,
      });
    }

    const slug = validation.normalizedSlug;

    // Verify slug uniqueness in database
    const existingSlug = await prisma.project.findUnique({ where: { slug } });
    if (existingSlug) {
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: `Project with slug "${slug}" already exists`,
      });
    }

    // Verify name uniqueness for user
    const existingName = await prisma.project.findUnique({
      where: {
        userId_name: {
          userId: user.id,
          name,
        },
      },
    });
    if (existingName) {
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: `Project with name "${name}" already exists for this user`,
      });
    }

    // Verify GitHub App repository authorization if user has active installations
    const userInstallationsCount = await prisma.githubInstallation.count({
      where: { userId: user.id, status: 'ACTIVE' },
    });

    let matchedInstallationId: string | undefined = undefined;
    let matchedRepoId: bigint | undefined = undefined;

    if (userInstallationsCount > 0) {
      const targetRepoIdentifier = (repoName || name).trim();
      const authorizedRepo = await prisma.githubAppRepository.findFirst({
        where: {
          installation: {
            userId: user.id,
            status: 'ACTIVE',
          },
          OR: [
            { fullName: targetRepoIdentifier },
            { name: targetRepoIdentifier },
            { cloneUrl: repoUrl },
          ],
        },
      });

      if (!authorizedRepo) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Repository "${targetRepoIdentifier}" is not authorized under any of your active GitHub App installations. Please grant access in GitHub App settings.`,
        });
      }

      matchedInstallationId = authorizedRepo.installationId;
      matchedRepoId = authorizedRepo.githubRepoId;
    }

    try {
      const project = await prisma.project.create({
        data: {
          userId: user.id,
          installationId: matchedInstallationId,
          githubRepoId: matchedRepoId,
          name,
          slug,
          repoName: repoName || name,
          repoUrl,
          branch,
          rootDirectory,
          buildCommand,
          outputDirectory,
          installCommand,
          framework,
        },
        include: {
          user: {
            select: { id: true, username: true, email: true },
          },
        },
      });

      return reply.code(201).send({
        success: true,
        message: 'Project created successfully',
        data: project,
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Project name or slug already exists',
        });
      }
      throw err;
    }
  };

  // GET /api/projects/:id - Get project by ID or slug (tenant isolated)
  const getProject = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const user = await authenticateRequest(req, reply);
    if (!user) return;

    const { id } = req.params;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

    const project = await prisma.project.findFirst({
      where: isUuid ? { id } : { slug: id },
      include: {
        user: { select: { id: true, username: true, email: true, avatarUrl: true } },
        currentDeployment: true,
        deployments: {
          take: 5,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            trigger: true,
            commitHash: true,
            commitMessage: true,
            senderUsername: true,
            previewUrl: true,
            buildDurationMs: true,
            createdAt: true,
          },
        },
        envVars: {
          select: {
            id: true,
            key: true,
            target: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    // Tenant isolation: return 404 if project does not exist OR belongs to another user
    if (!project || project.userId !== user.id) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `Project "${id}" not found`,
      });
    }

    return reply.code(200).send({
      success: true,
      data: project,
    });
  };

  // PUT /api/projects/:id & PATCH /api/projects/:id - Update project (tenant isolated)
  const updateProject = async (
    req: FastifyRequest<{ Params: { id: string }; Body: UpdateProjectBody }>,
    reply: FastifyReply
  ) => {
    const user = await authenticateRequest(req, reply);
    if (!user) return;

    const { id } = req.params;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

    const existing = await prisma.project.findFirst({
      where: isUuid ? { id } : { slug: id },
    });

    if (!existing || existing.userId !== user.id) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `Project "${id}" not found`,
      });
    }

    const {
      name,
      slug: newSlugCandidate,
      repoUrl,
      branch,
      rootDirectory,
      buildCommand,
      outputDirectory,
      installCommand,
      framework,
    } = req.body || {};

    let targetSlug = existing.slug;
    if (newSlugCandidate !== undefined) {
      const validation = validateSlug(newSlugCandidate);
      if (!validation.isValid) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: validation.error,
        });
      }

      if (validation.normalizedSlug !== existing.slug) {
        const conflict = await prisma.project.findUnique({
          where: { slug: validation.normalizedSlug },
        });
        if (conflict && conflict.id !== existing.id) {
          return reply.code(409).send({
            statusCode: 409,
            error: 'Conflict',
            message: `Project with slug "${validation.normalizedSlug}" already exists`,
          });
        }
        targetSlug = validation.normalizedSlug;
      }
    }

    try {
      const updated = await prisma.project.update({
        where: { id: existing.id },
        data: {
          name: name || undefined,
          slug: targetSlug,
          repoUrl: repoUrl || undefined,
          branch: branch || undefined,
          rootDirectory: rootDirectory || undefined,
          buildCommand: buildCommand || undefined,
          outputDirectory: outputDirectory || undefined,
          installCommand: installCommand || undefined,
          framework: framework || undefined,
        },
      });

      return reply.code(200).send({
        success: true,
        message: 'Project updated successfully',
        data: updated,
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Project name or slug already exists',
        });
      }
      throw err;
    }
  };

  // DELETE /api/projects/:id - Delete project (tenant isolated)
  const deleteProject = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const user = await authenticateRequest(req, reply);
    if (!user) return;

    const { id } = req.params;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

    const existing = await prisma.project.findFirst({
      where: isUuid ? { id } : { slug: id },
    });

    if (!existing || existing.userId !== user.id) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `Project "${id}" not found`,
      });
    }

    await prisma.project.delete({ where: { id: existing.id } });

    return reply.code(200).send({
      success: true,
      message: `Project "${existing.name}" deleted successfully`,
    });
  };

  // GET /api/projects/:id/env - List environment variables (tenant isolated)
  const getProjectEnvVars = async (
    req: FastifyRequest<{ Params: { id: string }; Querystring: { reveal?: string } }>,
    reply: FastifyReply
  ) => {
    const user = await authenticateRequest(req, reply);
    if (!user) return;

    const { id } = req.params;
    const reveal = req.query.reveal === 'true';

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

    const project = await prisma.project.findFirst({
      where: isUuid ? { id } : { slug: id },
    });

    if (!project || project.userId !== user.id) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `Project "${id}" not found`,
      });
    }

    const envVars = await prisma.projectEnvVar.findMany({
      where: { projectId: project.id },
      orderBy: { key: 'asc' },
    });

    const formatted = envVars.map((env) => {
      let value = '••••••••';
      if (reveal) {
        try {
          value = decrypt(env.encryptedValue, env.iv, config.crypto.masterKey);
        } catch {
          value = '[Decryption Failed]';
        }
      }
      return {
        id: env.id,
        projectId: env.projectId,
        key: env.key,
        value,
        target: env.target,
        createdAt: env.createdAt,
        updatedAt: env.updatedAt,
      };
    });

    return reply.code(200).send({
      success: true,
      data: formatted,
      total: formatted.length,
    });
  };

  // POST /api/projects/:id/env - Add / Upsert environment variable (tenant isolated)
  const addProjectEnvVar = async (
    req: FastifyRequest<{ Params: { id: string }; Body: CreateEnvVarBody }>,
    reply: FastifyReply
  ) => {
    const user = await authenticateRequest(req, reply);
    if (!user) return;

    const { id } = req.params;
    const { key, value, target = 'ALL' } = req.body || {};

    if (!key || value === undefined) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'key and value are required fields',
      });
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const project = await prisma.project.findFirst({
      where: isUuid ? { id } : { slug: id },
    });

    if (!project || project.userId !== user.id) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `Project "${id}" not found`,
      });
    }

    // Encrypt secret value with AES-256-GCM
    const { encryptedValue, iv } = encrypt(value, config.crypto.masterKey);
    const validTarget = (target.toUpperCase() as EnvTarget) || EnvTarget.ALL;

    const envVar = await prisma.projectEnvVar.upsert({
      where: {
        projectId_key_target: {
          projectId: project.id,
          key: key.trim().toUpperCase(),
          target: validTarget,
        },
      },
      update: {
        encryptedValue,
        iv,
      },
      create: {
        projectId: project.id,
        key: key.trim().toUpperCase(),
        encryptedValue,
        iv,
        target: validTarget,
      },
    });

    return reply.code(201).send({
      success: true,
      message: `Environment variable "${envVar.key}" saved successfully`,
      data: {
        id: envVar.id,
        key: envVar.key,
        target: envVar.target,
        createdAt: envVar.createdAt,
        updatedAt: envVar.updatedAt,
      },
    });
  };

  // DELETE /api/projects/:id/env/:varId - Delete environment variable (tenant isolated)
  const deleteProjectEnvVar = async (
    req: FastifyRequest<{ Params: { id: string; varId: string } }>,
    reply: FastifyReply
  ) => {
    const user = await authenticateRequest(req, reply);
    if (!user) return;

    const { id, varId } = req.params;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const project = await prisma.project.findFirst({
      where: isUuid ? { id } : { slug: id },
    });

    if (!project || project.userId !== user.id) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `Project "${id}" not found`,
      });
    }

    const envVar = await prisma.projectEnvVar.findFirst({
      where: { id: varId, projectId: project.id },
    });

    if (!envVar) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `Environment variable "${varId}" not found for this project`,
      });
    }

    await prisma.projectEnvVar.delete({ where: { id: envVar.id } });

    return reply.code(200).send({
      success: true,
      message: `Environment variable "${envVar.key}" deleted successfully`,
    });
  };

  // Register routes on /api/projects and /api/v1/projects
  for (const prefix of ['/api/projects', '/api/v1/projects']) {
    app.get(prefix, listProjects);
    app.post(prefix, createProject);
    app.get(`${prefix}/:id`, getProject);
    app.put(`${prefix}/:id`, updateProject);
    app.patch(`${prefix}/:id`, updateProject);
    app.delete(`${prefix}/:id`, deleteProject);
    app.get(`${prefix}/:id/env`, getProjectEnvVars);
    app.post(`${prefix}/:id/env`, addProjectEnvVar);
    app.delete(`${prefix}/:id/env/:varId`, deleteProjectEnvVar);
  }
}
