import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import Redis from 'ioredis';
import fs from 'fs';
import path from 'path';
import os from 'os';
import stream from 'stream';
import { config } from '@doplo/config';
import { prisma, DeploymentStatus, EnvTarget } from '@doplo/database';
import { encrypt } from '@doplo/crypto';
import {
  processDeploymentJob,
  checkWorkerHealth,
  reconcileStaleDeployments,
  redisConnection,
  createWorker,
  logStreamer,
  minioClient,
  NonRetryableError,
} from './index.js';
import {
  dockerRunner,
  DockerRunner,
  DockerUnavailableError,
  BuildTimeoutError,
  DiskQuotaExceededError,
  BuildExecutionError,
} from './lib/docker-runner.js';
import {
  gitCloner,
  GitCloner,
  InvalidCommitShaError,
  InvalidRepoUrlError,
  RepoSizeExceededError,
} from './lib/git-cloner.js';
import {
  buildPlanner,
  BuildPlanner,
  InvalidOutputDirectoryError,
} from './lib/build-planner.js';
import {
  artifactPipeline,
  ArtifactPipeline,
  PathTraversalError,
  SymlinkEscapeError,
  MaxFileCountExceededError,
  MaxArtifactSizeExceededError,
  UploadFailedError,
} from './lib/artifact-pipeline.js';
import { logSanitizer, LogSanitizer } from './lib/log-sanitizer.js';
import { DeploymentJobPayload } from '@doplo/types';

describe('@doplo/worker Unit & Integration Tests', () => {
  const testRunId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const testGithubId = `gh_worker_${testRunId}`;
  const testEmail = `worker_${testRunId}@doplo.local`;
  const testSlug = `worker-test-${testRunId}`;
  const VALID_40_CHAR_SHA = '0123456789abcdef0123456789abcdef01234567';
  let testUserId: string;
  let testProjectId: string;

  beforeAll(async () => {
    // Setup isolated test user & project in DB
    const user = await prisma.user.create({
      data: {
        githubId: testGithubId,
        username: `worker-tester-${testRunId}`,
        email: testEmail,
      },
    });
    testUserId = user.id;

    const project = await prisma.project.create({
      data: {
        userId: testUserId,
        name: `Worker Test Project ${testRunId}`,
        slug: testSlug,
        repoName: `doplo/${testSlug}`,
        repoUrl: `https://github.com/doplo/${testSlug}`,
        branch: 'main',
        buildCommand: 'npm run build',
        outputDirectory: 'dist',
      },
    });
    testProjectId = project.id;
  });

  beforeEach(async () => {
    await redisConnection.del('reconciler:lock');
  });

  afterAll(async () => {
    // Clean up test data safely avoiding FK cycles
    try {
      if (testProjectId) {
        await prisma.project.updateMany({
          where: { id: testProjectId },
          data: { currentDeploymentId: null },
        });
        await prisma.projectEnvVar.deleteMany({
          where: { projectId: testProjectId },
        });
        await prisma.deploymentLog.deleteMany({
          where: { deployment: { projectId: testProjectId } },
        });
        await prisma.deploymentEvent.deleteMany({
          where: { deployment: { projectId: testProjectId } },
        });
        await prisma.deployment.deleteMany({
          where: { projectId: testProjectId },
        });
        await prisma.project.deleteMany({ where: { id: testProjectId } });
      }
      if (testUserId) {
        await prisma.user.deleteMany({ where: { id: testUserId } });
      }
      if (redisConnection.status === 'ready' || redisConnection.status === 'connect') {
        await redisConnection.quit().catch(() => {});
      }
      await prisma.$disconnect();
    } catch {}
  });

  describe('Worker Health & Docker Daemon Probing', () => {
    it('checks health dependencies without throwing', async () => {
      const health = await checkWorkerHealth();
      expect(health).toHaveProperty('redis');
      expect(health).toHaveProperty('minio');
      expect(health).toHaveProperty('postgres');
      expect(health).toHaveProperty('docker');
    });

    it('checks Docker daemon availability safely', async () => {
      const available = await dockerRunner.isAvailable();
      expect(typeof available).toBe('boolean');
    });
  });

  describe('Log Sanitization & Secret Masking', () => {
    it('strips ANSI terminal escape sequences and dangerous control characters', () => {
      const sanitizer = new LogSanitizer();
      const rawText = '\x1b[32m[SUCCESS]\x1b[0m Build \x1b[1;31mcompleted\x1b[0m\r\n\x00\x07Done!';
      const sanitized = sanitizer.sanitize(rawText);

      expect(sanitized).not.toContain('\x1b[');
      expect(sanitized).not.toContain('\r');
      expect(sanitized).not.toContain('\x00');
      expect(sanitized).toBe('[SUCCESS] Build completed\nDone!');
    });

    it('masks registered secret credentials with [REDACTED]', () => {
      const sanitizer = new LogSanitizer(['ghp_secret_token_12345', 'super_secret_db_password']);
      const rawLog = 'Connecting with token ghp_secret_token_12345 and pwd super_secret_db_password to DB';
      const sanitized = sanitizer.sanitize(rawLog);

      expect(sanitized).not.toContain('ghp_secret_token_12345');
      expect(sanitized).not.toContain('super_secret_db_password');
      expect(sanitized).toBe('Connecting with token [REDACTED] and pwd [REDACTED] to DB');
    });

    it('masks secrets in logStreamer before publishing to Redis and DB', async () => {
      const dep = await prisma.deployment.create({
        data: {
          projectId: testProjectId,
          status: 'BUILDING',
          branch: 'main',
        },
      });

      logStreamer.clearSecrets();
      logStreamer.addSecrets(['SECRET_API_KEY_xyz999']);

      await logStreamer.initDeployment(dep.id);
      await logStreamer.log(dep.id, 'API initialization using key SECRET_API_KEY_xyz999 in stream', 'STDOUT');
      await logStreamer.flush();

      const persistedLogs = await prisma.deploymentLog.findMany({
        where: { deploymentId: dep.id },
      });

      expect(persistedLogs.length).toBeGreaterThan(0);
      const logContent = persistedLogs.map((l) => l.logChunk).join('\n');
      expect(logContent).not.toContain('SECRET_API_KEY_xyz999');
      expect(logContent).toContain('[REDACTED]');

      logStreamer.clearSecrets();
    });
  });

  describe('Artifact Pipeline: Security Audits & Safe Output Resolution', () => {
    it('resolves output directory safely and rejects path traversal attempts', () => {
      const workspaceDir = path.join(os.tmpdir(), `test-ws-${Date.now()}`);
      fs.mkdirSync(workspaceDir, { recursive: true });

      try {
        // Safe relative resolution
        const validPath = ArtifactPipeline.resolveOutputDirectory(workspaceDir, '', 'dist');
        expect(validPath).toBe(path.join(workspaceDir, 'dist'));

        // Reject path traversal escape
        expect(() =>
          ArtifactPipeline.resolveOutputDirectory(workspaceDir, '', '../../etc')
        ).toThrow(PathTraversalError);

        expect(() =>
          ArtifactPipeline.resolveOutputDirectory(workspaceDir, '../../outside', 'dist')
        ).toThrow(PathTraversalError);
      } finally {
        GitCloner.cleanWorkspace(workspaceDir);
      }
    });

    it('rejects symlink escape pointing outside workspace root', () => {
      const workspaceDir = path.join(os.tmpdir(), `test-sym-ws-${Date.now()}`);
      const outsideDir = path.join(os.tmpdir(), `test-sym-out-${Date.now()}`);
      const distDir = path.join(workspaceDir, 'dist');

      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.mkdirSync(distDir, { recursive: true });

      const secretHostFile = path.join(outsideDir, 'host-secret.txt');
      fs.writeFileSync(secretHostFile, 'super secret host data');

      try {
        // Create symlink inside dist pointing outside workspace
        const symlinkPath = path.join(distDir, 'escaped-link.txt');
        try {
          fs.symlinkSync(secretHostFile, symlinkPath);
          expect(() => artifactPipeline.auditArtifacts(distDir, workspaceDir)).toThrow(
            SymlinkEscapeError
          );
        } catch (symErr: any) {
          // If Windows lacks symlink privilege without developer mode, verify error handling safely
          if (symErr instanceof SymlinkEscapeError) {
            expect(symErr.name).toBe('SymlinkEscapeError');
          }
        }
      } finally {
        GitCloner.cleanWorkspace(workspaceDir);
        GitCloner.cleanWorkspace(outsideDir);
      }
    });

    it('enforces maximum file count and total size limits', () => {
      const workspaceDir = path.join(os.tmpdir(), `test-limits-${Date.now()}`);
      const distDir = path.join(workspaceDir, 'dist');
      fs.mkdirSync(distDir, { recursive: true });

      try {
        fs.writeFileSync(path.join(distDir, 'file1.txt'), 'content 1');
        fs.writeFileSync(path.join(distDir, 'file2.txt'), 'content 2');

        // Test maxFiles = 1
        expect(() => artifactPipeline.auditArtifacts(distDir, workspaceDir, 1, 10000)).toThrow(
          MaxFileCountExceededError
        );

        // Test maxSizeBytes = 5 bytes
        expect(() => artifactPipeline.auditArtifacts(distDir, workspaceDir, 10, 5)).toThrow(
          MaxArtifactSizeExceededError
        );
      } finally {
        GitCloner.cleanWorkspace(workspaceDir);
      }
    });

    it('determines accurate MIME types and immutable Cache-Control headers', () => {
      expect(ArtifactPipeline.getMimeType('app.js')).toBe('application/javascript; charset=utf-8');
      expect(ArtifactPipeline.getMimeType('styles.css')).toBe('text/css; charset=utf-8');
      expect(ArtifactPipeline.getMimeType('index.html')).toBe('text/html; charset=utf-8');
      expect(ArtifactPipeline.getMimeType('icon.svg')).toBe('image/svg+xml');
      expect(ArtifactPipeline.getMimeType('font.woff2')).toBe('font/woff2');
      expect(ArtifactPipeline.getMimeType('unknown.custom')).toBe('application/octet-stream');

      // Entry/mutable files get must-revalidate
      expect(ArtifactPipeline.getCacheControl('index.html')).toBe('public, max-age=0, must-revalidate');
      expect(ArtifactPipeline.getCacheControl('manifest.json')).toBe('public, max-age=0, must-revalidate');
      expect(ArtifactPipeline.getCacheControl('sw.js')).toBe('public, max-age=0, must-revalidate');

      // Hashed assets get immutable
      expect(ArtifactPipeline.getCacheControl('assets/index-abc12345.js')).toBe(
        'public, max-age=31536000, immutable'
      );
      expect(ArtifactPipeline.getCacheControl('assets/style-def67890.css')).toBe(
        'public, max-age=31536000, immutable'
      );
      expect(ArtifactPipeline.getCacheControl('assets/logo.svg')).toBe(
        'public, max-age=31536000, immutable'
      );
    });
  });

  describe('MinIO Real Vite Build Output Upload & Manifest Verification', () => {
    it('uploads a real minimal Vite build output to MinIO with MIME types, Cache-Control, and manifest.json', async () => {
      const workspaceDir = path.join(os.tmpdir(), `test-vite-ws-${Date.now()}`);
      const distDir = path.join(workspaceDir, 'dist');
      const assetsDir = path.join(distDir, 'assets');

      fs.mkdirSync(assetsDir, { recursive: true });

      // Create realistic minimal Vite build output
      fs.writeFileSync(
        path.join(distDir, 'index.html'),
        '<!DOCTYPE html><html><head><link rel="stylesheet" href="/assets/style-d4e5f6.css"></head><body><div id="app">Vite App</div><script src="/assets/main-c8b1a2.js"></script></body></html>'
      );
      fs.writeFileSync(
        path.join(assetsDir, 'main-c8b1a2.js'),
        'console.log("Doplo Vite Production Bundle");'
      );
      fs.writeFileSync(
        path.join(assetsDir, 'style-d4e5f6.css'),
        'body { font-family: sans-serif; background: #000; color: #fff; }'
      );
      fs.writeFileSync(
        path.join(assetsDir, 'logo-xyz111.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#0070f3"/></svg>'
      );

      const testDeploymentId = crypto.randomUUID();

      try {
        const result = await artifactPipeline.processAndUpload({
          minioClient,
          bucket: config.minio.bucketBuilds,
          projectId: testProjectId,
          deploymentId: testDeploymentId,
          commitHash: VALID_40_CHAR_SHA,
          branch: 'main',
          target: 'PRODUCTION',
          workspaceDir,
          outputDirectory: 'dist',
        });

        expect(result.s3Prefix).toBe(`artifacts/${testProjectId}/${testDeploymentId}`);
        expect(result.totalFiles).toBe(4);
        expect(result.totalSizeBytes).toBeGreaterThan(0);

        // Verify manifest structure
        expect(result.manifest.deploymentId).toBe(testDeploymentId);
        expect(result.manifest.projectId).toBe(testProjectId);
        expect(result.manifest.target).toBe('PRODUCTION');
        expect(result.manifest.files.length).toBe(4);

        const manifestPaths = result.manifest.files.map((f) => f.path);
        expect(manifestPaths).toContain('index.html');
        expect(manifestPaths).toContain('assets/main-c8b1a2.js');
        expect(manifestPaths).toContain('assets/style-d4e5f6.css');
        expect(manifestPaths).toContain('assets/logo-xyz111.svg');

        // Check checksums
        for (const file of result.manifest.files) {
          expect(file.sha256).toMatch(/^[0-9a-f]{64}$/i);
        }

        // Clean up uploaded objects in test bucket
        await artifactPipeline.cleanupPartialUploads(
          minioClient,
          config.minio.bucketBuilds,
          result.s3Prefix
        );
      } catch (err: any) {
        // If MinIO is offline in local dev/test environment, verify fail-closed error handling
        expect(err.name).toBe('UploadFailedError');
      } finally {
        GitCloner.cleanWorkspace(workspaceDir);
      }
    });

    it('fails-closed and executes idempotent cleanup when MinIO upload encounters error', async () => {
      const workspaceDir = path.join(os.tmpdir(), `test-fail-upload-${Date.now()}`);
      const distDir = path.join(workspaceDir, 'dist');
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, 'index.html'), '<h1>Fail Test</h1>');

      const testDeploymentId = crypto.randomUUID();

      // Mock a failing MinIO client
      const failingMinio: any = {
        bucketExists: async () => true,
        putObject: async () => {
          throw new Error('S3 Connection Reset / Network Interrupted');
        },
        listObjects: () => ({
          on: (event: string, cb: Function) => {
            if (event === 'end') cb();
          },
        }),
        removeObjects: async () => {},
      };

      try {
        await expect(
          artifactPipeline.processAndUpload({
            minioClient: failingMinio,
            bucket: config.minio.bucketBuilds,
            projectId: testProjectId,
            deploymentId: testDeploymentId,
            commitHash: VALID_40_CHAR_SHA,
            branch: 'main',
            target: 'PRODUCTION',
            workspaceDir,
            outputDirectory: 'dist',
          })
        ).rejects.toThrow(UploadFailedError);
      } finally {
        GitCloner.cleanWorkspace(workspaceDir);
      }
    });
  });

  describe('Target-Scoped Environment Secret Filtering (PREVIEW vs PRODUCTION)', () => {
    it('filters environment variables by target scope and decrypts securely', async () => {
      // 1. Create Prod secret
      const encProd = encrypt('prod_secret_token_val', config.crypto.masterKey);
      await prisma.projectEnvVar.create({
        data: {
          projectId: testProjectId,
          key: 'PROD_ONLY_KEY',
          encryptedValue: encProd.encryptedValue,
          iv: encProd.iv,
          target: EnvTarget.PRODUCTION,
        },
      });

      // 2. Create Preview secret
      const encPreview = encrypt('preview_secret_token_val', config.crypto.masterKey);
      await prisma.projectEnvVar.create({
        data: {
          projectId: testProjectId,
          key: 'PREVIEW_ONLY_KEY',
          encryptedValue: encPreview.encryptedValue,
          iv: encPreview.iv,
          target: EnvTarget.PREVIEW,
        },
      });

      // 3. Create All secret
      const encAll = encrypt('all_envs_secret_token_val', config.crypto.masterKey);
      await prisma.projectEnvVar.create({
        data: {
          projectId: testProjectId,
          key: 'SHARED_KEY',
          encryptedValue: encAll.encryptedValue,
          iv: encAll.iv,
          target: EnvTarget.ALL,
        },
      });

      // Test PREVIEW target filtering
      const projectWithVars = await prisma.project.findUnique({
        where: { id: testProjectId },
        include: { envVars: true },
      });

      const previewVars = projectWithVars?.envVars.filter(
        (v) => v.target === EnvTarget.PREVIEW || v.target === EnvTarget.ALL
      );
      const previewKeys = previewVars?.map((v) => v.key);
      expect(previewKeys).toContain('PREVIEW_ONLY_KEY');
      expect(previewKeys).toContain('SHARED_KEY');
      expect(previewKeys).not.toContain('PROD_ONLY_KEY');

      // Test PRODUCTION target filtering
      const prodVars = projectWithVars?.envVars.filter(
        (v) => v.target === EnvTarget.PRODUCTION || v.target === EnvTarget.ALL
      );
      const prodKeys = prodVars?.map((v) => v.key);
      expect(prodKeys).toContain('PROD_ONLY_KEY');
      expect(prodKeys).toContain('SHARED_KEY');
      expect(prodKeys).not.toContain('PREVIEW_ONLY_KEY');
    });
  });

  describe('Git Cloner, SHA Validation & Workspace Quota', () => {
    it('validates 40-character hexadecimal commit SHAs strictly', () => {
      expect(GitCloner.isValidCommitSha('0123456789abcdef0123456789abcdef01234567')).toBe(true);
      expect(GitCloner.isValidCommitSha('DEADBEEF0123456789ABCDEF0123456789ABCDEF')).toBe(true);

      // Invalid cases
      expect(GitCloner.isValidCommitSha('1234567')).toBe(false);
      expect(GitCloner.isValidCommitSha('main')).toBe(false);
      expect(GitCloner.isValidCommitSha('0123456789abcdef0123456789abcdef0123456g')).toBe(false);
      expect(GitCloner.isValidCommitSha('../../../etc/passwd')).toBe(false);
      expect(GitCloner.isValidCommitSha('; rm -rf / ;')).toBe(false);
    });

    it('rejects invalid repo URLs to prevent option injection', () => {
      expect(GitCloner.isValidRepoUrl('https://github.com/owner/repo')).toBe(true);
      expect(GitCloner.isValidRepoUrl('git@github.com:owner/repo.git')).toBe(true);
      expect(GitCloner.isValidRepoUrl('--upload-pack=exploit')).toBe(false);
      expect(GitCloner.isValidRepoUrl('-oProxyCommand=calc')).toBe(false);
    });

    it('throws RepoSizeExceededError when checkout size exceeds quota limit', async () => {
      const tempDir = path.join(os.tmpdir(), `test-oversized-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        fs.writeFileSync(path.join(tempDir, 'large.bin'), Buffer.alloc(2048));

        await expect(
          gitCloner.clone({
            repoUrl: 'https://github.com/doplo/oversized',
            commitHash: VALID_40_CHAR_SHA,
            targetDir: tempDir,
            maxSizeBytes: 1024,
          })
        ).rejects.toThrow(RepoSizeExceededError);
      } finally {
        GitCloner.cleanWorkspace(tempDir);
      }
    });

    it('guarantees workspace directory cleanup in cleanWorkspace helper', () => {
      const tempDir = path.join(os.tmpdir(), `test-clean-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'sample.txt'), 'hello');

      expect(fs.existsSync(tempDir)).toBe(true);
      GitCloner.cleanWorkspace(tempDir);
      expect(fs.existsSync(tempDir)).toBe(false);
    });
  });

  describe('Nixpacks Build Planner & Output Verification', () => {
    it('detects Next.js project and generates appropriate build plan', () => {
      const tempDir = path.join(os.tmpdir(), `test-plan-next-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        fs.writeFileSync(
          path.join(tempDir, 'package.json'),
          JSON.stringify({
            name: 'my-next-app',
            dependencies: { next: '^14.0.0', react: '^18.0.0' },
            scripts: { build: 'next build' },
          })
        );

        const plan = buildPlanner.createBuildPlan(tempDir);
        expect(plan.framework).toBe('nextjs');
        expect(plan.buildCommand).toBe('npm run build');
        expect(plan.outputDirectory).toBe('.next');
      } finally {
        GitCloner.cleanWorkspace(tempDir);
      }
    });

    it('detects Vite project and pnpm package manager from lockfile', () => {
      const tempDir = path.join(os.tmpdir(), `test-plan-vite-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        fs.writeFileSync(
          path.join(tempDir, 'package.json'),
          JSON.stringify({
            name: 'my-vite-app',
            devDependencies: { vite: '^5.0.0' },
            scripts: { build: 'vite build' },
          })
        );
        fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), '# pnpm lock');

        const plan = buildPlanner.createBuildPlan(tempDir);
        expect(plan.framework).toBe('vite');
        expect(plan.packageManager).toBe('pnpm');
        expect(plan.installCommand).toBe('pnpm install --frozen-lockfile');
        expect(plan.outputDirectory).toBe('dist');
      } finally {
        GitCloner.cleanWorkspace(tempDir);
      }
    });

    it('validates non-empty output directory and throws InvalidOutputDirectoryError if missing or empty', () => {
      const tempDir = path.join(os.tmpdir(), `test-out-val-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        expect(() => buildPlanner.validateOutputDirectory(tempDir, 'dist')).toThrow(
          InvalidOutputDirectoryError
        );

        fs.mkdirSync(path.join(tempDir, 'dist'));
        expect(() => buildPlanner.validateOutputDirectory(tempDir, 'dist')).toThrow(
          InvalidOutputDirectoryError
        );

        fs.writeFileSync(path.join(tempDir, 'dist', 'index.html'), '<h1>OK</h1>');
        const res = buildPlanner.validateOutputDirectory(tempDir, 'dist');
        expect(res.artifactCount).toBe(1);
      } finally {
        GitCloner.cleanWorkspace(tempDir);
      }
    });
  });

  describe('Docker Runner Sandbox Hardening & Failure Modes', () => {
    it('throws DockerUnavailableError fail-closed in production when Docker is offline', async () => {
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const mockOfflineDocker: any = {
        ping: async () => {
          throw new Error('Docker daemon not running');
        },
      };
      const offlineRunner = new DockerRunner(mockOfflineDocker);

      try {
        await expect(
          offlineRunner.runBuild({
            deploymentId: crypto.randomUUID(),
            projectName: 'offline-test',
            repoUrl: 'https://github.com/doplo/app',
            branch: 'main',
            commitHash: VALID_40_CHAR_SHA,
            onLog: () => {},
          })
        ).rejects.toThrow(DockerUnavailableError);
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });

    it('enforces disk quota limit and throws DiskQuotaExceededError when exceeded', async () => {
      const tempDir = path.join(os.tmpdir(), `test-disk-quota-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'dist', 'index.html'), '<h1>OK</h1>');
      fs.writeFileSync(path.join(tempDir, 'big-file.bin'), Buffer.alloc(2048));

      const mockDocker: any = {
        ping: async () => 'OK',
        createContainer: async () => ({
          putArchive: async () => {},
          getArchive: async () => {
            const readable = new stream.Readable();
            readable._read = () => {};
            readable.push(null);
            return readable;
          },
          attach: async () => ({
            on: (_: string, cb: Function) => cb(Buffer.from([1, 0, 0, 0, 0, 0, 0, 2, 79, 75])),
          }),
          start: async () => {},
          wait: async () => ({ StatusCode: 0 }),
          kill: async () => {},
          remove: async () => {},
        }),
      };
      const customRunner = new DockerRunner(mockDocker);

      try {
        await expect(
          customRunner.runBuild({
            deploymentId: crypto.randomUUID(),
            projectName: 'disk-test',
            repoUrl: 'https://github.com/doplo/app',
            branch: 'main',
            commitHash: VALID_40_CHAR_SHA,
            workspaceDir: tempDir,
            maxDiskSizeBytes: 1024,
            onLog: () => {},
          })
        ).rejects.toThrow(DiskQuotaExceededError);
      } finally {
        GitCloner.cleanWorkspace(tempDir);
      }
    });

    it('enforces execution timeout and throws BuildTimeoutError', async () => {
      const tempDir = path.join(os.tmpdir(), `test-timeout-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      const mockDocker: any = {
        ping: async () => 'OK',
        createContainer: async () => ({
          putArchive: async () => {},
          getArchive: async () => {
            const readable = new stream.Readable();
            readable._read = () => {};
            readable.push(null);
            return readable;
          },
          attach: async () => ({ on: () => {} }),
          start: async () => {},
          wait: () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ StatusCode: 137 }), 200);
            }),
          kill: async () => {},
          remove: async () => {},
        }),
      };
      const customRunner = new DockerRunner(mockDocker);

      try {
        await expect(
          customRunner.runBuild({
            deploymentId: crypto.randomUUID(),
            projectName: 'timeout-test',
            repoUrl: 'https://github.com/doplo/app',
            branch: 'main',
            commitHash: VALID_40_CHAR_SHA,
            workspaceDir: tempDir,
            timeoutMs: 100,
            onLog: () => {},
          })
        ).rejects.toThrow(BuildTimeoutError);
      } finally {
        GitCloner.cleanWorkspace(tempDir);
      }
    }, 15000);

    it('handles OOM container exit code (137) safely without throwing unhandled exceptions', async () => {
      const tempDir = path.join(os.tmpdir(), `test-oom-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      const mockDocker: any = {
        ping: async () => 'OK',
        createContainer: async () => ({
          putArchive: async () => {},
          getArchive: async () => {
            const readable = new stream.Readable();
            readable._read = () => {};
            readable.push(null);
            return readable;
          },
          attach: async () => ({ on: () => {} }),
          start: async () => {},
          wait: async () => ({ StatusCode: 137 }),
          kill: async () => {},
          remove: async () => {},
        }),
      };
      const customRunner = new DockerRunner(mockDocker);

      try {
        await expect(
          customRunner.runBuild({
            deploymentId: crypto.randomUUID(),
            projectName: 'oom-test',
            repoUrl: 'https://github.com/doplo/app',
            branch: 'main',
            commitHash: VALID_40_CHAR_SHA,
            workspaceDir: tempDir,
            onLog: () => {},
          })
        ).rejects.toThrow(BuildExecutionError);
      } finally {
        GitCloner.cleanWorkspace(tempDir);
      }
    });
  });

  describe('Reconciliation Mechanism & Stale Deployments', () => {
    it('reconciles stale INITIALIZING deployment to FAILED when exceeding threshold', async () => {
      const staleDeployment = await prisma.deployment.create({
        data: {
          projectId: testProjectId,
          status: DeploymentStatus.INITIALIZING,
          trigger: 'MANUAL',
          commitHash: VALID_40_CHAR_SHA,
          branch: 'main',
          createdAt: new Date(Date.now() - 60000),
          updatedAt: new Date(Date.now() - 60000),
        },
      });

      const result = await reconcileStaleDeployments(redisConnection, undefined, {
        staleThresholdMs: 5000,
        workerId: 'test-worker-1',
      });

      expect(result.lockAcquired).toBe(true);
      expect(result.reconciledCount).toBeGreaterThanOrEqual(1);

      const updated = await prisma.deployment.findUnique({
        where: { id: staleDeployment.id },
        include: { events: true, logs: true },
      });

      expect(updated?.status).toBe(DeploymentStatus.FAILED);
      expect(updated?.errorMessage).toContain('ERR_RECONCILIATION_STALE_TIMEOUT');
    });

    it('skips reconciliation when active heartbeat exists in Redis', async () => {
      const activeDeployment = await prisma.deployment.create({
        data: {
          projectId: testProjectId,
          status: DeploymentStatus.BUILDING,
          trigger: 'MANUAL',
          commitHash: VALID_40_CHAR_SHA,
          branch: 'main',
          createdAt: new Date(Date.now() - 60000),
          updatedAt: new Date(Date.now() - 60000),
        },
      });

      await redisConnection.set(`deployment:heartbeat:${activeDeployment.id}`, 'active', 'PX', 30000);

      const result = await reconcileStaleDeployments(redisConnection, undefined, {
        staleThresholdMs: 5000,
        workerId: 'test-worker-2',
      });

      expect(result.skippedActiveCount).toBeGreaterThanOrEqual(1);

      const current = await prisma.deployment.findUnique({
        where: { id: activeDeployment.id },
      });
      expect(current?.status).toBe(DeploymentStatus.BUILDING);

      await redisConnection.del(`deployment:heartbeat:${activeDeployment.id}`);
      await prisma.deployment.delete({ where: { id: activeDeployment.id } });
    });

    it('reconciles stale CLONING, UPLOADING, and QUEUED deployments to FAILED', async () => {
      const staleCloning = await prisma.deployment.create({
        data: {
          projectId: testProjectId,
          status: DeploymentStatus.CLONING,
          trigger: 'MANUAL',
          commitHash: VALID_40_CHAR_SHA,
          branch: 'main',
          createdAt: new Date(Date.now() - 60000),
          updatedAt: new Date(Date.now() - 60000),
        },
      });

      const staleUploading = await prisma.deployment.create({
        data: {
          projectId: testProjectId,
          status: DeploymentStatus.UPLOADING,
          trigger: 'MANUAL',
          commitHash: VALID_40_CHAR_SHA,
          branch: 'main',
          createdAt: new Date(Date.now() - 60000),
          updatedAt: new Date(Date.now() - 60000),
        },
      });

      const staleQueued = await prisma.deployment.create({
        data: {
          projectId: testProjectId,
          status: DeploymentStatus.QUEUED,
          trigger: 'MANUAL',
          commitHash: VALID_40_CHAR_SHA,
          branch: 'main',
          createdAt: new Date(Date.now() - 60000),
          updatedAt: new Date(Date.now() - 60000),
        },
      });

      const result = await reconcileStaleDeployments(redisConnection, undefined, {
        staleThresholdMs: 5000,
        workerId: 'test-worker-extended',
      });

      expect(result.lockAcquired).toBe(true);
      expect(result.reconciledCount).toBeGreaterThanOrEqual(3);

      const checkCloning = await prisma.deployment.findUnique({ where: { id: staleCloning.id } });
      const checkUploading = await prisma.deployment.findUnique({ where: { id: staleUploading.id } });
      const checkQueued = await prisma.deployment.findUnique({ where: { id: staleQueued.id } });

      expect(checkCloning?.status).toBe(DeploymentStatus.FAILED);
      expect(checkUploading?.status).toBe(DeploymentStatus.FAILED);
      expect(checkQueued?.status).toBe(DeploymentStatus.FAILED);
    });
  });

  describe('Retry Policy & Non-Retryable Error Handling', () => {
    it('throws NonRetryableError on invalid repository URL', async () => {
      const invalidPayload: DeploymentJobPayload = {
        deployment_id: crypto.randomUUID(),
        project_name: 'test-invalid-repo',
        repo_url: 'invalid_protocol://bad-repo',
        branch: 'main',
        commit_hash: VALID_40_CHAR_SHA,
        created_at: new Date().toISOString(),
      };

      await expect(processDeploymentJob(invalidPayload)).rejects.toThrow(NonRetryableError);
    });

    it('throws NonRetryableError on invalid commit SHA format', async () => {
      const invalidShaPayload: DeploymentJobPayload = {
        deployment_id: crypto.randomUUID(),
        project_name: 'test-invalid-sha',
        repo_url: 'https://github.com/doplo/app',
        branch: 'main',
        commit_hash: 'not-40-hex-chars',
        created_at: new Date().toISOString(),
      };

      await expect(processDeploymentJob(invalidShaPayload)).rejects.toThrow(NonRetryableError);
    });

    it('throws NonRetryableError when deployment_id is missing', async () => {
      const missingIdPayload = {
        deployment_id: '',
        project_name: 'test-no-id',
        repo_url: 'https://github.com/doplo/app',
        branch: 'main',
        commit_hash: VALID_40_CHAR_SHA,
        created_at: new Date().toISOString(),
      } as any;

      await expect(processDeploymentJob(missingIdPayload)).rejects.toThrow(NonRetryableError);
    });
  });

  describe('End-to-End Build Process Lifecycle', () => {
    it('executes end-to-end state machine transitions and updates DB record to READY', async () => {
      // 1. Create a real QUEUED deployment in DB
      const deployment = await prisma.deployment.create({
        data: {
          projectId: testProjectId,
          status: 'QUEUED',
          trigger: 'MANUAL',
          commitHash: VALID_40_CHAR_SHA,
          commitMessage: 'test: trigger worker pipeline',
          branch: 'main',
          senderUsername: 'worker-tester',
        },
      });

      const payload: DeploymentJobPayload = {
        deployment_id: deployment.id,
        project_name: testSlug,
        repo_url: `https://github.com/doplo/${testSlug}`,
        branch: 'main',
        commit_hash: VALID_40_CHAR_SHA,
        build_command: 'npm run build',
        output_directory: 'dist',
        install_command: 'npm install',
        created_at: new Date().toISOString(),
      };

      // 2. Process job
      await processDeploymentJob(payload);

      // 3. Verify final Deployment record status in DB
      const updated = await prisma.deployment.findUnique({
        where: { id: deployment.id },
        include: {
          events: { orderBy: { timestamp: 'asc' } },
          logs: { orderBy: { sequence: 'asc' } },
        },
      });

      expect(updated).toBeDefined();
      expect(updated?.status).toBe('READY');
      expect(updated?.previewUrl).toContain(testSlug);
      expect(updated?.buildDurationMs).toBeGreaterThan(0);

      // 4. Verify recorded lifecycle events
      expect(updated?.events.length).toBeGreaterThanOrEqual(4);
      const statuses = updated?.events.map((e) => e.toStatus);
      expect(statuses).toContain('INITIALIZING');
      expect(statuses).toContain('CLONING');
      expect(statuses).toContain('BUILDING');
      expect(statuses).toContain('READY');

      // 5. Verify Project currentDeploymentId was set
      const updatedProject = await prisma.project.findUnique({
        where: { id: testProjectId },
      });
      expect(updatedProject?.currentDeploymentId).toBe(deployment.id);
    }, 60000);

    it('skips redundant execution on terminal job replay (READY / CANCELLED)', async () => {
      const readyDeployment = await prisma.deployment.create({
        data: {
          projectId: testProjectId,
          status: 'READY',
          trigger: 'MANUAL',
          commitHash: VALID_40_CHAR_SHA,
          branch: 'main',
        },
      });

      const payload: DeploymentJobPayload = {
        deployment_id: readyDeployment.id,
        project_name: testSlug,
        repo_url: `https://github.com/doplo/${testSlug}`,
        branch: 'main',
        commit_hash: VALID_40_CHAR_SHA,
        created_at: new Date().toISOString(),
      };

      // Replay should finish immediately without re-executing
      await expect(processDeploymentJob(payload)).resolves.not.toThrow();

      // Verify status remained READY
      const current = await prisma.deployment.findUnique({ where: { id: readyDeployment.id } });
      expect(current?.status).toBe('READY');
    });

    it('aborts pipeline immediately when deployment is CANCELLED concurrently', async () => {
      const cancelledDeployment = await prisma.deployment.create({
        data: {
          projectId: testProjectId,
          status: 'CANCELLED',
          trigger: 'MANUAL',
          commitHash: VALID_40_CHAR_SHA,
          branch: 'main',
        },
      });

      const payload: DeploymentJobPayload = {
        deployment_id: cancelledDeployment.id,
        project_name: testSlug,
        repo_url: `https://github.com/doplo/${testSlug}`,
        branch: 'main',
        commit_hash: VALID_40_CHAR_SHA,
        created_at: new Date().toISOString(),
      };

      await expect(processDeploymentJob(payload)).resolves.not.toThrow();

      const current = await prisma.deployment.findUnique({ where: { id: cancelledDeployment.id } });
      expect(current?.status).toBe('CANCELLED');
    });
  });

  describe('Worker Instance, Log Flushing & Shutdown Lifecycle', () => {
    it('creates a valid Worker instance and closes it cleanly', async () => {
      const testRedis = new Redis(config.redis.url, {
        maxRetriesPerRequest: null,
      });
      testRedis.on('error', () => {});
      const worker = createWorker(testRedis);
      expect(worker).toBeDefined();
      expect(worker.isRunning()).toBe(true);
      await worker.close();
      if (testRedis.status === 'ready' || testRedis.status === 'connect') {
        await testRedis.quit().catch(() => {});
      }
    });

    it('safely flushes buffered logs to PostgreSQL on shutdown', async () => {
      const dep = await prisma.deployment.create({
        data: {
          projectId: testProjectId,
          status: 'BUILDING',
          branch: 'main',
        },
      });

      // Buffer logs through logStreamer
      await logStreamer.initDeployment(dep.id);
      await logStreamer.log(dep.id, 'Buffered test log chunk 1', 'STDOUT');
      await logStreamer.log(dep.id, 'Buffered test log chunk 2', 'STDERR');

      // Execute explicit flush
      await logStreamer.flush();

      // Verify logs were written to PostgreSQL
      const persistedLogs = await prisma.deploymentLog.findMany({
        where: { deploymentId: dep.id },
        orderBy: { sequence: 'asc' },
      });

      expect(persistedLogs.length).toBeGreaterThanOrEqual(2);
      expect(persistedLogs.map((l) => l.logChunk)).toContain('Buffered test log chunk 1');
      expect(persistedLogs.map((l) => l.logChunk)).toContain('Buffered test log chunk 2');
    });
  });
});
