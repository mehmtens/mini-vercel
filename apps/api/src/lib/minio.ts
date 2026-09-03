import * as Minio from 'minio';
import { config } from '@doplo/config';

export const minioClient = new Minio.Client({
  endPoint: config.minio.endpoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

export async function ensureBucketExists(bucketName: string = config.minio.bucketBuilds): Promise<void> {
  try {
    const exists = await minioClient.bucketExists(bucketName);
    if (!exists) {
      await minioClient.makeBucket(bucketName, 'us-east-1');
    }
  } catch (err) {
    // MinIO might not be up yet during tests or initial start
    console.warn(`MinIO bucket check warning for ${bucketName}:`, (err as Error).message);
  }
}

export async function pingMinio(): Promise<{ latency: string; ok: boolean }> {
  const start = Date.now();
  try {
    await minioClient.listBuckets();
    return { latency: `${Date.now() - start}ms`, ok: true };
  } catch {
    return { latency: '0ms', ok: false };
  }
}
