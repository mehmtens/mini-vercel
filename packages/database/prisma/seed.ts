import { PrismaClient, EnvTarget, DeploymentStatus, DeploymentTrigger, LogStream } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const env = process.env.NODE_ENV || 'development';

  if (env !== 'development' && env !== 'test') {
    console.log(`[Seed] Skipping seed execution: NODE_ENV=${env} (Seed only runs in development/test environment)`);
    return;
  }

  console.log(`[Seed] Running seed for development environment...`);

  // Clean existing data for a fresh seed state
  await prisma.deploymentLog.deleteMany({});
  await prisma.deploymentEvent.deleteMany({});
  await prisma.projectEnvVar.deleteMany({});
  // Disconnect current deployment to avoid FK cycles during cleanup
  await prisma.project.updateMany({ data: { currentDeploymentId: null } });
  await prisma.deployment.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.user.deleteMany({});

  // 1. Create Demo User
  const demoUser = await prisma.user.create({
    data: {
      githubId: 'gh_987654321',
      username: 'johndoe',
      email: 'john@example.com',
      avatarUrl: 'https://avatars.githubusercontent.com/u/987654321?v=4',
    },
  });
  console.log(`[Seed] Created User: ${demoUser.username} (${demoUser.id})`);

  // 2. Create Projects
  const nextApp = await prisma.project.create({
    data: {
      userId: demoUser.id,
      name: 'nextjs-saas-starter',
      slug: 'nextjs-saas-starter',
      repoName: 'johndoe/nextjs-saas-starter',
      repoUrl: 'https://github.com/johndoe/nextjs-saas-starter',
      branch: 'main',
      rootDirectory: '/',
      buildCommand: 'npm run build',
      outputDirectory: 'dist',
      installCommand: 'npm install',
      framework: 'nextjs',
    },
  });

  const docsApp = await prisma.project.create({
    data: {
      userId: demoUser.id,
      name: 'docs-portal',
      slug: 'docs-portal',
      repoName: 'johndoe/docs-portal',
      repoUrl: 'https://github.com/johndoe/docs-portal',
      branch: 'main',
      rootDirectory: '/',
      buildCommand: 'npm run build',
      outputDirectory: 'dist',
      installCommand: 'npm install',
      framework: 'astro',
    },
  });
  console.log(`[Seed] Created Projects: ${nextApp.name}, ${docsApp.name}`);

  // 3. Create Project Env Vars
  await prisma.projectEnvVar.createMany({
    data: [
      {
        projectId: nextApp.id,
        key: 'DATABASE_URL',
        encryptedValue: 'aes256gcm:dGhpc19pc19hX3NlY3JldF9kYXRhdXJs',
        iv: '1234567890abcdef1234567890abcdef',
        target: EnvTarget.PRODUCTION,
      },
      {
        projectId: nextApp.id,
        key: 'NEXT_PUBLIC_ANALYTICS_ID',
        encryptedValue: 'aes256gcm:R0EtOTk5ODg3Nw==',
        iv: 'abcdef1234567890abcdef1234567890',
        target: EnvTarget.ALL,
      },
      {
        projectId: docsApp.id,
        key: 'DOCS_TOKEN',
        encryptedValue: 'aes256gcm:c2VjcmV0X3Rva2Vu',
        iv: 'fedcba0987654321fedcba0987654321',
        target: EnvTarget.ALL,
      },
    ],
  });
  console.log(`[Seed] Created Env Vars for projects`);

  // 4. Create Deployments for Next.js Project
  const readyDeployment = await prisma.deployment.create({
    data: {
      projectId: nextApp.id,
      status: DeploymentStatus.READY,
      trigger: DeploymentTrigger.WEBHOOK_PUSH,
      commitHash: 'a1b2c3d',
      commitMessage: 'feat: add payment subscription flow',
      senderUsername: 'johndoe',
      branch: 'main',
      s3Prefix: `artifacts/${nextApp.id}/dpl_ready_01/`,
      previewUrl: 'https://nextjs-saas-starter-a1b2c3d.doplo.app',
      buildDurationMs: 4250,
      errorMessage: null,
    },
  });

  const queuedDeployment = await prisma.deployment.create({
    data: {
      projectId: nextApp.id,
      status: DeploymentStatus.QUEUED,
      trigger: DeploymentTrigger.MANUAL,
      commitHash: 'e5f6g7h',
      commitMessage: 'fix: optimize responsive hero section',
      senderUsername: 'johndoe',
      branch: 'feature/hero-fix',
      s3Prefix: null,
      previewUrl: null,
      buildDurationMs: null,
      errorMessage: null,
    },
  });

  // Link Current Deployment to Project
  await prisma.project.update({
    where: { id: nextApp.id },
    data: { currentDeploymentId: readyDeployment.id },
  });
  console.log(`[Seed] Created Deployments: ${readyDeployment.id} (READY), ${queuedDeployment.id} (QUEUED)`);

  // 5. Create Deployment Events
  await prisma.deploymentEvent.createMany({
    data: [
      {
        deploymentId: readyDeployment.id,
        fromStatus: null,
        toStatus: DeploymentStatus.QUEUED,
        eventMessage: 'Deployment job queued from GitHub webhook',
      },
      {
        deploymentId: readyDeployment.id,
        fromStatus: DeploymentStatus.QUEUED,
        toStatus: DeploymentStatus.INITIALIZING,
        eventMessage: 'Worker acquired deployment and allocated sandbox',
      },
      {
        deploymentId: readyDeployment.id,
        fromStatus: DeploymentStatus.INITIALIZING,
        toStatus: DeploymentStatus.CLONING,
        eventMessage: 'Cloning repository at commit a1b2c3d',
      },
      {
        deploymentId: readyDeployment.id,
        fromStatus: DeploymentStatus.CLONING,
        toStatus: DeploymentStatus.BUILDING,
        eventMessage: 'Compiling Next.js bundle & serverless edge functions',
      },
      {
        deploymentId: readyDeployment.id,
        fromStatus: DeploymentStatus.BUILDING,
        toStatus: DeploymentStatus.UPLOADING,
        eventMessage: 'Uploaded static assets to MinIO S3 bucket',
      },
      {
        deploymentId: readyDeployment.id,
        fromStatus: DeploymentStatus.UPLOADING,
        toStatus: DeploymentStatus.DEPLOYING,
        eventMessage: 'Configured Caddy edge proxy routing',
      },
      {
        deploymentId: readyDeployment.id,
        fromStatus: DeploymentStatus.DEPLOYING,
        toStatus: DeploymentStatus.READY,
        eventMessage: 'Deployment is live and ready',
      },
    ],
  });

  // 6. Create Deployment Logs
  await prisma.deploymentLog.createMany({
    data: [
      {
        deploymentId: readyDeployment.id,
        sequence: 1,
        stream: LogStream.STDOUT,
        logChunk: '[CLONE] Shallow cloning git repository https://github.com/johndoe/nextjs-saas-starter...',
      },
      {
        deploymentId: readyDeployment.id,
        sequence: 2,
        stream: LogStream.STDOUT,
        logChunk: '[DEPS] Running `npm install` (cached 482 packages)...',
      },
      {
        deploymentId: readyDeployment.id,
        sequence: 3,
        stream: LogStream.STDOUT,
        logChunk: '[BUILD] Running `npm run build` -> Next.js 14.2 compiled in 2.8s',
      },
      {
        deploymentId: readyDeployment.id,
        sequence: 4,
        stream: LogStream.STDOUT,
        logChunk: '[UPLOAD] Uploaded 28 static bundles to MinIO bucket doplo-builds',
      },
      {
        deploymentId: readyDeployment.id,
        sequence: 5,
        stream: LogStream.STDOUT,
        logChunk: '[SUCCESS] Edge deployment complete -> https://nextjs-saas-starter-a1b2c3d.doplo.app',
      },
    ],
  });
  console.log(`[Seed] Seed completed successfully!`);
}

main()
  .catch((e) => {
    console.error('[Seed Error]', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
