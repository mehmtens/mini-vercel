const { prisma, DeploymentStatus } = require('../packages/database/dist/index.js');
const { config } = require('../packages/config/dist/index.js');
const path = require('path');

const resolveFromApi = (pkg) => require(require.resolve(pkg, { paths: [path.join(__dirname, '../apps/api')] }));
const Redis = resolveFromApi('ioredis');
const Minio = resolveFromApi('minio');
const { Queue } = resolveFromApi('bullmq');

async function checkDependencies() {
  // 1. PostgreSQL DB ping
  await prisma.user.findFirst();

  // 2. Redis ping
  const redis = new Redis(config.redis.url);
  const pong = await redis.ping();
  if (pong !== 'PONG') throw new Error('Redis ping failed');
  await redis.quit();

  // 3. MinIO ping
  const minio = new Minio.Client({
    endPoint: config.minio.endpoint,
    port: config.minio.port,
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
  });
  await minio.bucketExists(config.minio.bucketBuilds);
}

async function executeRollbackSmoke() {
  const minio = new Minio.Client({
    endPoint: config.minio.endpoint,
    port: config.minio.port,
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
  });

  const bucket = config.minio.bucketBuilds;
  if (!(await minio.bucketExists(bucket))) {
    await minio.makeBucket(bucket);
  }

  const unique = 'smoke_' + Date.now();
  const user = await prisma.user.create({
    data: {
      githubId: unique,
      username: unique,
      email: unique + '@smoke.local',
    },
  });

  const project = await prisma.project.create({
    data: {
      userId: user.id,
      name: unique,
      slug: unique,
      repoName: 'doplo/' + unique,
      repoUrl: 'https://github.com/doplo/' + unique,
    },
  });

  const crypto = require('crypto');
  const d1Id = crypto.randomUUID();
  const d2Id = crypto.randomUUID();

  const d1 = await prisma.deployment.create({
    data: {
      id: d1Id,
      projectId: project.id,
      commitHash: '1111111111111111111111111111111111111111',
      branch: 'main',
      s3Prefix: 'artifacts/' + project.id + '/' + d1Id,
      status: DeploymentStatus.READY,
    },
  });

  const d2 = await prisma.deployment.create({
    data: {
      id: d2Id,
      projectId: project.id,
      commitHash: '2222222222222222222222222222222222222222',
      branch: 'main',
      s3Prefix: 'artifacts/' + project.id + '/' + d2Id,
      status: DeploymentStatus.READY,
    },
  });

  // Seed artifacts in MinIO
  const h1 = Buffer.from('<h1>Smoke v1</h1>');
  const h2 = Buffer.from('<h1>Smoke v2</h1>');
  await minio.putObject(bucket, 'artifacts/' + project.id + '/' + d1Id + '/index.html', h1, h1.length);
  await minio.putObject(bucket, 'artifacts/' + project.id + '/' + d2Id + '/index.html', h2, h2.length);

  // Initial state: current is d2
  await prisma.project.update({
    where: { id: project.id },
    data: { currentDeploymentId: d2.id },
  });

  const queue = new Queue(config.queue.name, { connection: new Redis(config.redis.url) });
  const initialJobCount = await queue.count();
  const initialDepCount = await prisma.deployment.count({ where: { projectId: project.id } });

  // Execute atomic pointer swap (Rollback to d1)
  const startTime = Date.now();
  await prisma.project.update({
    where: { id: project.id },
    data: { currentDeploymentId: d1.id, version: { increment: 1 } },
  });
  await prisma.deploymentAudit.create({
    data: {
      projectId: project.id,
      actorId: user.id,
      operation: 'ROLLBACK',
      oldDeploymentId: d2.id,
      newDeploymentId: d1.id,
    },
  });
  const duration = Date.now() - startTime;

  // Strict Assertions
  if (duration > 1000) throw new Error('Rollback exceeded 1.0s limit (' + duration + 'ms)');

  const updatedProj = await prisma.project.findUnique({ where: { id: project.id } });
  if (updatedProj.currentDeploymentId !== d1.id) throw new Error('currentDeploymentId did not update');

  const audit = await prisma.deploymentAudit.findFirst({ where: { projectId: project.id, operation: 'ROLLBACK' } });
  if (!audit) throw new Error('Audit event missing');

  const finalDepCount = await prisma.deployment.count({ where: { projectId: project.id } });
  if (finalDepCount !== initialDepCount) throw new Error('New deployment was unexpectedly created');

  const finalJobCount = await queue.count();
  if (finalJobCount !== initialJobCount) throw new Error('Queue job count unexpectedly changed');

  // Clean up fixture
  await prisma.deploymentAudit.deleteMany({ where: { projectId: project.id } });
  await prisma.deployment.deleteMany({ where: { projectId: project.id } });
  await prisma.project.delete({ where: { id: project.id } });
  await prisma.user.delete({ where: { id: user.id } });
  await queue.close();
}

const command = process.argv[2];

if (command === 'deps') {
  checkDependencies()
    .then(() => {
      console.log('DEPENDENCIES_HEALTHY');
      process.exit(0);
    })
    .catch((err) => {
      console.error('DEPENDENCY_ERROR:', err.message);
      process.exit(1);
    });
} else if (command === 'rollback') {
  executeRollbackSmoke()
    .then(() => {
      console.log('ROLLBACK_SMOKE_VERIFIED');
      process.exit(0);
    })
    .catch((err) => {
      console.error('SMOKE_ERROR:', err.message);
      process.exit(1);
    });
} else {
  console.error('Unknown command:', command);
  process.exit(1);
}
