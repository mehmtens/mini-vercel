import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as Minio from 'minio';

export class PathTraversalError extends Error {
  constructor(outputDir: string, workspaceDir: string) {
    super(`ERR_PATH_TRAVERSAL: Output directory "${outputDir}" resolves outside the isolated workspace root "${workspaceDir}".`);
    this.name = 'PathTraversalError';
  }
}

export class SymlinkEscapeError extends Error {
  constructor(symlinkPath: string, targetPath: string) {
    super(`ERR_SYMLINK_ESCAPE: Symbolic link "${symlinkPath}" points outside the workspace to "${targetPath}".`);
    this.name = 'SymlinkEscapeError';
  }
}

export class MaxFileCountExceededError extends Error {
  constructor(count: number, maxCount: number) {
    super(`ERR_MAX_FILE_COUNT_EXCEEDED: Artifact file count (${count}) exceeds maximum allowed limit of ${maxCount} files.`);
    this.name = 'MaxFileCountExceededError';
  }
}

export class MaxArtifactSizeExceededError extends Error {
  constructor(sizeBytes: number, maxBytes: number) {
    super(
      `ERR_MAX_ARTIFACT_SIZE_EXCEEDED: Total artifact size (${(sizeBytes / (1024 * 1024)).toFixed(
        2
      )}MB) exceeds maximum allowed limit of ${(maxBytes / (1024 * 1024)).toFixed(2)}MB.`
    );
    this.name = 'MaxArtifactSizeExceededError';
  }
}

export class UploadFailedError extends Error {
  constructor(message: string, cause?: Error) {
    super(`ERR_UPLOAD_FAILED: MinIO artifact upload failed: ${message}`);
    this.name = 'UploadFailedError';
    if (cause) this.cause = cause;
  }
}

export interface ArtifactFileEntry {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  contentType: string;
  sha256: string;
  cacheControl: string;
}

export interface ArtifactManifest {
  deploymentId: string;
  projectId: string;
  commitHash: string;
  branch: string;
  target: 'PRODUCTION' | 'PREVIEW';
  uploadedAt: string;
  totalSizeBytes: number;
  fileCount: number;
  files: Array<{
    path: string;
    size: number;
    contentType: string;
    sha256: string;
    cacheControl: string;
  }>;
}

export interface ProcessAndUploadOptions {
  minioClient: Minio.Client;
  bucket: string;
  projectId: string;
  deploymentId: string;
  commitHash: string;
  branch: string;
  target: 'PRODUCTION' | 'PREVIEW';
  workspaceDir: string;
  rootDirectory?: string;
  outputDirectory?: string;
  maxFiles?: number;
  maxSizeBytes?: number;
  onLog?: (chunk: string, stream: 'STDOUT' | 'STDERR') => void;
}

export class ArtifactPipeline {
  public static readonly DEFAULT_MAX_FILES = 5_000;
  public static readonly DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

  /**
   * Resolves outputDirectory safely and asserts that it does not escape the workspace
   */
  public static resolveOutputDirectory(
    workspaceDir: string,
    rootDirectory: string = '',
    outputDirectory: string = 'dist'
  ): string {
    const normWorkspace = path.resolve(workspaceDir);
    const cleanRoot = (rootDirectory || '').replace(/^[\\\/]+/, '');
    const cleanOutput = (outputDirectory || 'dist').replace(/^[\\\/]+/, '');
    const resolvedPath = path.resolve(normWorkspace, cleanRoot, cleanOutput);

    const relative = path.relative(normWorkspace, resolvedPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new PathTraversalError(outputDirectory, workspaceDir);
    }

    return resolvedPath;
  }

  /**
   * Determines MIME type based on file extension
   */
  public static getMimeType(filePath: string): string {
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

  /**
   * Determines Cache-Control header based on file nature (immutable vs mutable)
   */
  public static getCacheControl(relativePath: string): string {
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

    // Static assets, hashed bundles, images, fonts
    return 'public, max-age=31536000, immutable';
  }

  /**
   * Scans and verifies the output directory against symlinks, traversal, file count, and size limits
   */
  public auditArtifacts(
    resolvedOutputDir: string,
    workspaceDir: string,
    maxFiles: number = ArtifactPipeline.DEFAULT_MAX_FILES,
    maxSizeBytes: number = ArtifactPipeline.DEFAULT_MAX_SIZE_BYTES
  ): ArtifactFileEntry[] {
    const normWorkspace = path.resolve(workspaceDir);
    if (!fs.existsSync(resolvedOutputDir)) {
      throw new Error(`Output directory does not exist: "${resolvedOutputDir}"`);
    }

    const entries: ArtifactFileEntry[] = [];
    let totalSize = 0;

    const scanDirectory = (currentDir: string) => {
      const dirEntries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const item of dirEntries) {
        const fullPath = path.join(currentDir, item.name);
        const lstat = fs.lstatSync(fullPath);

        // 1. Symlink escape check
        if (lstat.isSymbolicLink()) {
          const realTarget = fs.realpathSync(fullPath);
          const relativeToWorkspace = path.relative(normWorkspace, realTarget);
          if (relativeToWorkspace.startsWith('..') || path.isAbsolute(relativeToWorkspace)) {
            throw new SymlinkEscapeError(fullPath, realTarget);
          }
        }

        if (lstat.isDirectory()) {
          scanDirectory(fullPath);
        } else if (lstat.isFile() || lstat.isSymbolicLink()) {
          const fileContent = fs.readFileSync(fullPath);
          const size = fileContent.length;
          totalSize += size;

          if (entries.length + 1 > maxFiles) {
            throw new MaxFileCountExceededError(entries.length + 1, maxFiles);
          }
          if (totalSize > maxSizeBytes) {
            throw new MaxArtifactSizeExceededError(totalSize, maxSizeBytes);
          }

          const relativePath = path.relative(resolvedOutputDir, fullPath).replace(/\\/g, '/');
          const sha256 = crypto.createHash('sha256').update(fileContent).digest('hex');
          const contentType = ArtifactPipeline.getMimeType(fullPath);
          const cacheControl = ArtifactPipeline.getCacheControl(relativePath);

          entries.push({
            relativePath,
            absolutePath: fullPath,
            sizeBytes: size,
            contentType,
            sha256,
            cacheControl,
          });
        }
      }
    };

    scanDirectory(resolvedOutputDir);

    if (entries.length === 0) {
      throw new Error(`Output directory "${resolvedOutputDir}" contains 0 files.`);
    }

    return entries;
  }

  /**
   * Idempotently deletes all objects under a given S3 prefix on upload failure or cancellation
   */
  public async cleanupPartialUploads(
    minioClient: Minio.Client,
    bucket: string,
    s3Prefix: string
  ): Promise<void> {
    try {
      const stream = minioClient.listObjects(bucket, s3Prefix, true);
      const objectsList: string[] = [];

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (obj) => {
          if (obj.name) objectsList.push(obj.name);
        });
        stream.on('error', reject);
        stream.on('end', resolve);
      });

      if (objectsList.length > 0) {
        await minioClient.removeObjects(bucket, objectsList);
      }
    } catch (err: any) {
      console.warn(`[ArtifactPipeline] Notice during cleanup of partial uploads at "${s3Prefix}":`, err?.message);
    }
  }

  /**
   * Processes genuine build artifacts and uploads them with MIME types, Cache-Control, and manifest.json
   */
  public async processAndUpload(
    options: ProcessAndUploadOptions
  ): Promise<{ s3Prefix: string; totalFiles: number; totalSizeBytes: number; manifest: ArtifactManifest }> {
    const {
      minioClient,
      bucket,
      projectId,
      deploymentId,
      commitHash,
      branch,
      target,
      workspaceDir,
      rootDirectory = '',
      outputDirectory = 'dist',
      maxFiles = ArtifactPipeline.DEFAULT_MAX_FILES,
      maxSizeBytes = ArtifactPipeline.DEFAULT_MAX_SIZE_BYTES,
      onLog = () => {},
    } = options;

    const s3Prefix = `artifacts/${projectId}/${deploymentId}`;

    // 1. Resolve output directory safely
    const resolvedOutputDir = ArtifactPipeline.resolveOutputDirectory(
      workspaceDir,
      rootDirectory,
      outputDirectory
    );

    // 2. Audit artifacts for security, size, symlinks, and file count
    onLog(`[ARTIFACTS] Auditing output directory: ${outputDirectory}...`, 'STDOUT');
    const artifactFiles = this.auditArtifacts(resolvedOutputDir, workspaceDir, maxFiles, maxSizeBytes);

    const totalSizeBytes = artifactFiles.reduce((sum, f) => sum + f.sizeBytes, 0);
    onLog(
      `[ARTIFACTS] Verified ${artifactFiles.length} files (${(totalSizeBytes / 1024).toFixed(
        1
      )} KB). Preparing S3 upload to "${bucket}/${s3Prefix}"...`,
      'STDOUT'
    );

    // 3. Ensure target bucket exists
    try {
      const bucketExists = await minioClient.bucketExists(bucket);
      if (!bucketExists) {
        await minioClient.makeBucket(bucket, 'us-east-1');
      }
    } catch (bucketErr: any) {
      throw new UploadFailedError(`Failed to connect or ensure MinIO bucket "${bucket}": ${bucketErr.message}`, bucketErr);
    }

    // 4. Upload files with MIME types and Cache-Control headers
    try {
      for (const entry of artifactFiles) {
        const s3Key = `${s3Prefix}/${entry.relativePath}`;
        const fileBuffer = fs.readFileSync(entry.absolutePath);

        await minioClient.putObject(bucket, s3Key, fileBuffer, fileBuffer.length, {
          'Content-Type': entry.contentType,
          'Cache-Control': entry.cacheControl,
          'X-Amz-Meta-Sha256': entry.sha256,
        });
      }

      // 5. Generate and upload manifest.json
      const manifest: ArtifactManifest = {
        deploymentId,
        projectId,
        commitHash,
        branch,
        target,
        uploadedAt: new Date().toISOString(),
        totalSizeBytes,
        fileCount: artifactFiles.length,
        files: artifactFiles.map((f) => ({
          path: f.relativePath,
          size: f.sizeBytes,
          contentType: f.contentType,
          sha256: f.sha256,
          cacheControl: f.cacheControl,
        })),
      };

      const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
      await minioClient.putObject(bucket, `${s3Prefix}/manifest.json`, manifestBuffer, manifestBuffer.length, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=0, must-revalidate',
      });

      onLog(`[UPLOAD] Uploaded ${artifactFiles.length} files and manifest.json successfully to MinIO`, 'STDOUT');
      return { s3Prefix, totalFiles: artifactFiles.length, totalSizeBytes, manifest };
    } catch (uploadErr: any) {
      onLog(`[UPLOAD_ERROR] Upload failed: ${uploadErr.message}. Executing idempotent rollback cleanup...`, 'STDERR');
      await this.cleanupPartialUploads(minioClient, bucket, s3Prefix);
      throw new UploadFailedError(uploadErr.message, uploadErr);
    }
  }
}

export const artifactPipeline = new ArtifactPipeline();
