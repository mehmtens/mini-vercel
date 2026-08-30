import { cleanupService } from '../apps/worker/src/lib/cleanup-service';

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  console.log(`[Mini-Vercel Cleanup] Starting resource garbage collection (DryRun: ${isDryRun})...`);

  const result = await cleanupService.runFullCleanup({
    previewTtlDays: 7,
    logRetentionDays: 30,
    containerMaxAgeMinutes: 30,
    dryRun: isDryRun,
  });

  console.log('[Mini-Vercel Cleanup] Results:');
  console.log(` - Stale Preview Deployments:       ${result.previewDeploymentsCleaned}`);
  console.log(` - Orphan Build Containers:        ${result.orphanContainersCleaned}`);
  console.log(` - Temporary Directories:           ${result.tempDirectoriesCleaned}`);
  console.log(` - Expired Log Records:             ${result.staleLogsCleaned}`);
  console.log(` - Stalled Multipart Uploads:       ${result.incompleteUploadsCleaned}`);
  console.log(` - Orphan S3 Artifact Directories:  ${result.orphanArtifactsCleaned}`);

  if (result.errors.length > 0) {
    console.error('[Mini-Vercel Cleanup] Errors encountered during cleanup:', result.errors);
    if (!isDryRun) {
      process.exit(1);
    }
  }

  console.log('[Mini-Vercel Cleanup] Finished successfully.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[Mini-Vercel Cleanup] Fatal error during cleanup:', err);
  process.exit(1);
});
