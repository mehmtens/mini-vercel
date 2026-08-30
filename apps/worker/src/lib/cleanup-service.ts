import fs from 'fs';
import path from 'path';
import os from 'os';
import Docker from 'dockerode';
import * as Minio from 'minio';
import { prisma } from '@mini-vercel/database';
import { config } from '@mini-vercel/config';
import { workerCleanupErrorsCounter } from './metrics';

export interface CleanupResult {
  previewDeploymentsCleaned: number;
  orphanContainersCleaned: number;
  tempDirectoriesCleaned: number;
  staleLogsCleaned: number;
  incompleteUploadsCleaned: number;
  orphanArtifactsCleaned: number;
  dryRun: boolean;
  errors: string[];
}

export class CleanupService {
  private docker: Docker;
  private minioClient: Minio.Client;

  constructor() {
    this.docker = new Docker();
    this.minioClient = new Minio.Client({
      endPoint: config.minio.endpoint,
      port: config.minio.port,
      useSSL: config.minio.useSSL,
      accessKey: config.minio.accessKey,
      secretKey: config.minio.secretKey,
    });
  }

  /**
   * Cleans up expired preview deployments based on TTL
   * Strictly targets artifacts/{projectId}/{deploymentId}/ contract
   */
  async cleanupPreviewDeployments(ttlDays: number = 7, dryRun: boolean = false, errors: string[] = []): Promise<number> {
    const cutoffDate = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);

    // Find non-production (preview) deployments older than cutoffDate
    const stalePreviews = await prisma.deployment.findMany({
      where: {
        createdAt: { lt: cutoffDate },
        status: { in: ['READY', 'FAILED', 'CANCELLED'] },
        project: {
          currentDeploymentId: { not: undefined },
        },
      },
      select: {
        id: true,
        projectId: true,
        s3Prefix: true,
        project: { select: { id: true, currentDeploymentId: true } },
      },
      take: 100,
    });

    const eligible = stalePreviews.filter((d) => d.project?.currentDeploymentId !== d.id);

    if (dryRun) {
      return eligible.length;
    }

    let cleaned = 0;
    const bucket = config.minio.bucketBuilds;

    for (const d of eligible) {
      try {
        const prefix = d.s3Prefix ? (d.s3Prefix.endsWith('/') ? d.s3Prefix : `${d.s3Prefix}/`) : `artifacts/${d.projectId}/${d.id}/`;
        const objectsList: string[] = [];

        const stream = this.minioClient.listObjects(bucket, prefix, true);
        for await (const obj of stream) {
          if (obj.name) objectsList.push(obj.name);
        }

        if (objectsList.length > 0) {
          await this.minioClient.removeObjects(bucket, objectsList);
        }

        // Delete associated database records
        await prisma.deploymentLog.deleteMany({ where: { deploymentId: d.id } });
        await prisma.deploymentEvent.deleteMany({ where: { deploymentId: d.id } });
        await prisma.deployment.delete({ where: { id: d.id } });

        cleaned++;
      } catch (err: any) {
        const msg = `Failed to clean preview deployment ${d.id}: ${err?.message}`;
        errors.push(msg);
        workerCleanupErrorsCounter.inc({ component: 'preview_deployments' });
      }
    }

    return cleaned;
  }

  /**
   * Discovers and removes stalled incomplete multipart uploads older than grace period
   * Protects active in-flight uploads with timestamp threshold
   */
  async cleanupIncompleteMultipartUploads(maxAgeHours: number = 24, dryRun: boolean = false, errors: string[] = []): Promise<number> {
    let count = 0;
    const bucket = config.minio.bucketBuilds;
    const cutoffTimestamp = Date.now() - maxAgeHours * 60 * 60 * 1000;

    try {
      const bucketExists = await this.minioClient.bucketExists(bucket);
      if (!bucketExists) return 0;

      const incompleteStream = this.minioClient.listIncompleteUploads(bucket, '', true);
      for await (const upload of incompleteStream) {
        const uploadTime = upload.initiated ? new Date(upload.initiated).getTime() : 0;
        // Active upload protection: only purge uploads initiated before cutoff
        if (uploadTime < cutoffTimestamp && upload.key) {
          count++;
          if (!dryRun) {
            try {
              await this.minioClient.removeIncompleteUpload(bucket, upload.key);
            } catch (err: any) {
              const msg = `Failed to remove incomplete upload for key ${upload.key}: ${err?.message}`;
              errors.push(msg);
              workerCleanupErrorsCounter.inc({ component: 'multipart_uploads' });
            }
          }
        }
      }
    } catch (err: any) {
      const msg = `MinIO incomplete multipart discovery error: ${err?.message}`;
      errors.push(msg);
      workerCleanupErrorsCounter.inc({ component: 'multipart_discovery' });
    }

    return count;
  }

  /**
   * Detects and prunes unlinked orphan S3 artifact directories that have no active deployment in PostgreSQL
   */
  async cleanupOrphanMinIOArtifacts(dryRun: boolean = false, errors: string[] = []): Promise<number> {
    let count = 0;
    const bucket = config.minio.bucketBuilds;

    try {
      const bucketExists = await this.minioClient.bucketExists(bucket);
      if (!bucketExists) return 0;

      // Group objects by artifacts/{projectId}/{deploymentId}/
      const deploymentPrefixes = new Set<string>();
      const stream = this.minioClient.listObjects(bucket, 'artifacts/', true);

      for await (const obj of stream) {
        if (obj.name) {
          const parts = obj.name.split('/');
          if (parts.length >= 3 && parts[0] === 'artifacts') {
            const depId = parts[2];
            deploymentPrefixes.add(depId);
          }
        }
      }

      for (const depId of deploymentPrefixes) {
        try {
          // Check if deployment exists in DB
          const exists = await prisma.deployment.findUnique({
            where: { id: depId },
            select: { id: true },
          });

          if (!exists) {
            count++;
            if (!dryRun) {
              const objectsToDelete: string[] = [];
              const depStream = this.minioClient.listObjects(bucket, `artifacts/`, true);
              for await (const obj of depStream) {
                if (obj.name && obj.name.includes(`/${depId}/`)) {
                  objectsToDelete.push(obj.name);
                }
              }
              if (objectsToDelete.length > 0) {
                await this.minioClient.removeObjects(bucket, objectsToDelete);
              }
            }
          }
        } catch (err: any) {
          const msg = `Error verifying/pruning orphan deployment ${depId}: ${err?.message}`;
          errors.push(msg);
          workerCleanupErrorsCounter.inc({ component: 'orphan_artifacts' });
        }
      }
    } catch (err: any) {
      const msg = `Error scanning MinIO artifacts bucket: ${err?.message}`;
      errors.push(msg);
      workerCleanupErrorsCounter.inc({ component: 'orphan_discovery' });
    }

    return count;
  }

  /**
   * Cleans up orphan / dangling build containers
   */
  async cleanupOrphanContainers(maxAgeMinutes: number = 30, dryRun: boolean = false, errors: string[] = []): Promise<number> {
    let count = 0;
    try {
      const containers = await this.docker.listContainers({ all: true });
      const now = Math.floor(Date.now() / 1000);

      for (const containerInfo of containers) {
        const isBuildContainer = containerInfo.Names.some((n) => n.includes('mini-vercel-build-'));
        const ageMinutes = (now - containerInfo.Created) / 60;

        if (isBuildContainer && ageMinutes > maxAgeMinutes) {
          count++;
          if (!dryRun) {
            try {
              const container = this.docker.getContainer(containerInfo.Id);
              await container.remove({ force: true });
            } catch (err: any) {
              const msg = `Failed to remove orphan container ${containerInfo.Id}: ${err?.message}`;
              errors.push(msg);
              workerCleanupErrorsCounter.inc({ component: 'docker_containers' });
            }
          }
        }
      }
    } catch (err: any) {
      const msg = `Docker container listing error: ${err?.message}`;
      errors.push(msg);
      workerCleanupErrorsCounter.inc({ component: 'docker_listing' });
    }
    return count;
  }

  /**
   * Cleans up orphaned build temp directories in os.tmpdir()
   */
  cleanupTempDirectories(dryRun: boolean = false, errors: string[] = []): number {
    const tmpDir = os.tmpdir();
    let count = 0;
    try {
      const entries = fs.readdirSync(tmpDir);
      for (const entry of entries) {
        if (entry.startsWith('mini-vercel-build-')) {
          const fullPath = path.join(tmpDir, entry);
          count++;
          if (!dryRun) {
            try {
              fs.rmSync(fullPath, { recursive: true, force: true });
            } catch (err: any) {
              const msg = `Failed to delete temp dir ${fullPath}: ${err?.message}`;
              errors.push(msg);
              workerCleanupErrorsCounter.inc({ component: 'temp_directories' });
            }
          }
        }
      }
    } catch (err: any) {
      const msg = `Error reading host temporary directory ${tmpDir}: ${err?.message}`;
      errors.push(msg);
      workerCleanupErrorsCounter.inc({ component: 'temp_listing' });
    }
    return count;
  }

  /**
   * Cleans up historical deployment logs older than retentionDays
   */
  async cleanupStaleLogs(retentionDays: number = 30, dryRun: boolean = false, errors: string[] = []): Promise<number> {
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    try {
      const count = await prisma.deploymentLog.count({
        where: { timestamp: { lt: cutoffDate } },
      });

      if (!dryRun && count > 0) {
        await prisma.deploymentLog.deleteMany({
          where: { timestamp: { lt: cutoffDate } },
        });
      }

      return count;
    } catch (err: any) {
      const msg = `Failed to cleanup stale deployment logs: ${err?.message}`;
      errors.push(msg);
      workerCleanupErrorsCounter.inc({ component: 'stale_logs' });
      return 0;
    }
  }

  /**
   * Run full garbage collection cycle
   */
  async runFullCleanup(options: {
    previewTtlDays?: number;
    logRetentionDays?: number;
    containerMaxAgeMinutes?: number;
    multipartMaxAgeHours?: number;
    dryRun?: boolean;
  } = {}): Promise<CleanupResult> {
    const dryRun = options.dryRun ?? false;
    const errors: string[] = [];

    const previewDeploymentsCleaned = await this.cleanupPreviewDeployments(
      options.previewTtlDays ?? 7,
      dryRun,
      errors
    );

    const orphanContainersCleaned = await this.cleanupOrphanContainers(
      options.containerMaxAgeMinutes ?? 30,
      dryRun,
      errors
    );

    const tempDirectoriesCleaned = this.cleanupTempDirectories(dryRun, errors);

    const staleLogsCleaned = await this.cleanupStaleLogs(
      options.logRetentionDays ?? 30,
      dryRun,
      errors
    );

    const incompleteUploadsCleaned = await this.cleanupIncompleteMultipartUploads(
      options.multipartMaxAgeHours ?? 24,
      dryRun,
      errors
    );

    const orphanArtifactsCleaned = await this.cleanupOrphanMinIOArtifacts(dryRun, errors);

    return {
      previewDeploymentsCleaned,
      orphanContainersCleaned,
      tempDirectoriesCleaned,
      staleLogsCleaned,
      incompleteUploadsCleaned,
      orphanArtifactsCleaned,
      dryRun,
      errors,
    };
  }
}

export const cleanupService = new CleanupService();
