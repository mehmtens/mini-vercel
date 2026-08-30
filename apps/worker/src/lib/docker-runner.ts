import Docker from 'dockerode';
import os from 'os';
import path from 'path';
import fs from 'fs';
import tarfs from 'tar-fs';
import { config } from '@mini-vercel/config';
import { buildPlanner, BuildPlan } from './build-planner.js';

export class DockerUnavailableError extends Error {
  constructor(message?: string) {
    super(
      message ||
        'ERR_DOCKER_UNAVAILABLE: Docker daemon is unavailable or unreachable. Build aborted (fail-closed).'
    );
    this.name = 'DockerUnavailableError';
  }
}

export class BuildTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`ERR_BUILD_TIMEOUT: Build container exceeded the maximum execution timeout of ${timeoutMs / 1000}s.`);
    this.name = 'BuildTimeoutError';
  }
}

export class DiskQuotaExceededError extends Error {
  constructor(sizeBytes: number, limitBytes: number) {
    super(
      `ERR_DISK_QUOTA_EXCEEDED: Build workspace disk usage (${(sizeBytes / (1024 * 1024)).toFixed(
        2
      )}MB) exceeded quota limit of ${(limitBytes / (1024 * 1024)).toFixed(2)}MB.`
    );
    this.name = 'DiskQuotaExceededError';
  }
}

export class BuildExecutionError extends Error {
  public readonly exitCode: number;

  constructor(exitCode: number, message?: string) {
    super(message || `ERR_BUILD_FAILED: Build process exited with non-zero exit code: ${exitCode}`);
    this.name = 'BuildExecutionError';
    this.exitCode = exitCode;
  }
}

export interface DockerRunnerOptions {
  deploymentId: string;
  projectName: string;
  repoUrl: string;
  branch: string;
  commitHash: string;
  workspaceDir?: string;
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
  envVars?: Record<string, string>;
  timeoutMs?: number;
  maxDiskSizeBytes?: number;
  onLog: (chunk: string, stream: 'STDOUT' | 'STDERR') => void;
}

export class DockerRunner {
  private docker: Docker;
  private isDockerAccessible: boolean | null = null;
  public static readonly DEFAULT_TIMEOUT_MS = 600_000; // 600 seconds (10 minutes)
  public static readonly DEFAULT_MAX_DISK_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

  constructor(customDocker?: Docker) {
    if (customDocker) {
      this.docker = customDocker;
      return;
    }
    if (os.platform() === 'win32') {
      this.docker = new Docker({ socketPath: '//./pipe/docker_engine' });
    } else {
      this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
    }
  }

  /**
   * Pings the Docker daemon to check if the engine is running and accessible
   */
  public async isAvailable(): Promise<boolean> {
    try {
      const pingPromise = this.docker.ping();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Docker ping timeout')), 1000)
      );
      await Promise.race([pingPromise, timeoutPromise]);
      this.isDockerAccessible = true;
    } catch {
      this.isDockerAccessible = false;
    }
    return this.isDockerAccessible;
  }

  /**
   * Executes the build in an isolated Docker sandbox container without host bind mounts.
   * Source code is transferred into the container via Tar Archive Stream with non-root ownership,
   * compiled in an isolated sandbox, and output artifacts are extracted safely.
   */
  public async runBuild(
    options: DockerRunnerOptions
  ): Promise<{ exitCode: number; durationMs: number; outputDirectory: string }> {
    const startTime = Date.now();
    const {
      deploymentId,
      projectName,
      repoUrl,
      branch,
      commitHash,
      envVars = {},
      timeoutMs = DockerRunner.DEFAULT_TIMEOUT_MS,
      maxDiskSizeBytes = DockerRunner.DEFAULT_MAX_DISK_BYTES,
      onLog,
    } = options;

    const available = await this.isAvailable();
    if (!available) {
      onLog(`[FATAL] Docker daemon unavailable. Aborting build fail-closed.`, 'STDERR');
      throw new DockerUnavailableError();
    }

    const workspaceDir = options.workspaceDir || path.join(os.tmpdir(), 'mini-vercel-builds', deploymentId);
    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
    }

    // Generate Nixpacks-compatible build plan via BuildPlanner
    const plan: BuildPlan = buildPlanner.createBuildPlan(workspaceDir, {
      installCommand: options.installCommand,
      buildCommand: options.buildCommand,
      outputDirectory: options.outputDirectory,
    });

    onLog(`[NIXPACKS] Plan generated for project "${projectName}": Provider: "node (v20)", Framework: "${plan.framework}", Package Manager: "${plan.packageManager}"`, 'STDOUT');
    onLog(`[NIXPACKS] Install command: "${plan.installCommand}", Build command: "${plan.buildCommand}", Output: "${plan.outputDirectory}"`, 'STDOUT');
    onLog(`[SANDBOX] Initializing isolated Docker sandbox (UID: 1000, CapDrop: ALL, NoHostBinds: true, Timeout: ${timeoutMs / 1000}s)...`, 'STDOUT');

    // 1. Verify workspace size against disk quota limits
    if (fs.existsSync(workspaceDir)) {
      const getDirSize = (dir: string): number => {
        let size = 0;
        try {
          const items = fs.readdirSync(dir, { withFileTypes: true });
          for (const item of items) {
            const itemPath = path.join(dir, item.name);
            if (item.isDirectory()) {
              size += getDirSize(itemPath);
            } else {
              try {
                size += fs.statSync(itemPath).size;
              } catch {}
            }
          }
        } catch {}
        return size;
      };

      const currentSize = getDirSize(workspaceDir);
      if (currentSize > maxDiskSizeBytes) {
        throw new DiskQuotaExceededError(currentSize, maxDiskSizeBytes);
      }
    }

    const image = 'node:20-alpine';
    const envArray = Object.entries({ ...plan.env, ...envVars }).map(([k, v]) => `${k}=${v}`);
    envArray.push(
      `MINI_VERCEL_DEPLOYMENT_ID=${deploymentId}`,
      `HOME=/home/node`,
      `TMPDIR=/tmp`,
      `NODE_ENV=production`,
      `PATH=/home/node/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
    );

    const appDir = '/home/node';
    const shellScript = [
      'set -e',
      `echo "[SANDBOX_INIT] Non-root container initialized (UID: $(id -u), GID: $(id -g))"`,
      `cd ${appDir}`,
      `echo "[DEPENDENCIES] Executing install: ${plan.installCommand}"`,
      `NODE_ENV=development ${plan.installCommand}`,
      `echo "[BUILD] Executing build: ${plan.buildCommand}"`,
      `NODE_ENV=production ${plan.buildCommand}`,
      `echo "[SANDBOX] Build phase completed successfully with exit code 0"`,
    ].join(' && ');

    let container: Docker.Container | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let hasTimedOut = false;
    let tarStream: any = null;

    try {
      // 1. Create secure container with ZERO host directory bind mounts
      container = await this.docker.createContainer({
        Image: image,
        User: '1000:1000',
        Cmd: ['sh', '-c', shellScript],
        WorkingDir: appDir,
        Env: envArray,
        HostConfig: {
          Memory: 1.5 * 1024 * 1024 * 1024,
          MemorySwap: 1.5 * 1024 * 1024 * 1024,
          NanoCpus: 1_000_000_000,
          PidsLimit: 128,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          ReadonlyRootfs: false,
          Tmpfs: {
            '/tmp': 'rw,noexec,nosuid,size=512m',
            '/var/tmp': 'rw,noexec,nosuid,size=128m',
          },
          NetworkMode: 'bridge',
          AutoRemove: false,
          Binds: [],
        },
      });

      // 2. Transfer source code with non-root (UID 1000) ownership via tar stream
      onLog(`[TRANSFER] Streaming source code to ${appDir} via secure tar archive stream...`, 'STDOUT');
      tarStream = tarfs.pack(workspaceDir, {
        map: (header) => {
          header.uid = 1000;
          header.gid = 1000;
          header.mode = header.type === 'directory' ? 0o777 : 0o666;
          return header;
        },
      });
      await container.putArchive(tarStream, { path: '/home/node' });

      // 3. Attach log stream
      const stream: any = await container.attach({
        stream: true,
        stdout: true,
        stderr: true,
      });

      stream.on('data', (chunk: Buffer) => {
        if (chunk.length < 8) return;
        const isStderr = chunk[0] === 2;
        const text = chunk.slice(8).toString('utf8');
        const lines = text.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            onLog(trimmed, isStderr ? 'STDERR' : 'STDOUT');
          }
        }
      });

      // 4. Set execution timeout timer
      timeoutTimer = setTimeout(async () => {
        hasTimedOut = true;
        onLog(`[TIMEOUT] Build execution exceeded ${timeoutMs / 1000}s limit. Terminating sandbox container...`, 'STDERR');
        try {
          await container.kill();
        } catch {}
      }, timeoutMs);

      // 5. Start container and wait for completion
      await container.start();
      const waitResult = await container.wait();

      if (hasTimedOut) {
        throw new BuildTimeoutError(timeoutMs);
      }

      if (waitResult.StatusCode !== 0) {
        throw new BuildExecutionError(
          waitResult.StatusCode,
          `Build failed inside sandbox container with exit code ${waitResult.StatusCode}`
        );
      }

      // 6. Extract build artifacts from container via getArchive stream
      onLog(`[ARTIFACTS] Extracting compiled output directory from sandbox container...`, 'STDOUT');
      const outDirName = plan.outputDirectory || 'dist';
      const outDirTarStream = await container.getArchive({ path: `${appDir}/${outDirName}` });

      await new Promise<void>((resolve, reject) => {
        const extractPipe = outDirTarStream.pipe(tarfs.extract(workspaceDir));
        extractPipe.on('finish', () => resolve());
        extractPipe.on('error', (err) => reject(err));
      });

      onLog(`[OUTPUT] Output directory "${outDirName}" populated and ready for S3 upload`, 'STDOUT');

      return {
        exitCode: 0,
        durationMs: Date.now() - startTime,
        outputDirectory: outDirName,
      };
    } catch (err: any) {
      onLog(`[DOCKER_ERROR] Build execution failed: ${err.message}`, 'STDERR');
      throw err;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (tarStream && typeof tarStream.destroy === 'function') {
        try {
          tarStream.destroy();
        } catch {}
      }
      if (container) {
        try {
          await container.remove({ force: true });
        } catch {}
      }
    }
  }
}

export const dockerRunner = new DockerRunner();
