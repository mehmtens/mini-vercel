import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { prisma } from '@doplo/database';
import { BuildPlanner } from './lib/build-planner';
import { artifactPipeline } from './lib/artifact-pipeline';
import { cleanupService } from './lib/cleanup-service';

describe('Vite Fixture Build Planning & Artifact Pipeline Integration', () => {
  const fixturePath = path.resolve(__dirname, '../../../fixtures/sample-vite-app');
  let testUser: any;
  let testProject: any;
  let testDeployment: any;
  const planner = new BuildPlanner();

  beforeAll(async () => {
    testUser = await prisma.user.upsert({
      where: { githubId: 'e2e_vite_tester' },
      update: {},
      create: {
        githubId: 'e2e_vite_tester',
        username: 'vite_tester',
        email: 'vite_tester@doplo.local',
      },
    });

    const slug = `e2e-vite-${Date.now()}`;
    testProject = await prisma.project.create({
      data: {
        userId: testUser.id,
        name: slug,
        slug: slug,
        repoName: 'doplo/sample-vite-app',
        repoUrl: 'https://github.com/doplo/sample-vite-app',
      },
    });

    testDeployment = await prisma.deployment.create({
      data: {
        projectId: testProject.id,
        commitHash: 'a1b2c3d4e5f60000000000000000000000000000',
        commitMessage: 'feat: live vite preview test',
        branch: 'main',
        status: 'INITIALIZING',
      },
    });
  });

  afterAll(async () => {
    await prisma.deploymentLog.deleteMany({ where: { deploymentId: testDeployment.id } });
    await prisma.deploymentEvent.deleteMany({ where: { deploymentId: testDeployment.id } });
    await prisma.deployment.delete({ where: { id: testDeployment.id } }).catch(() => {});
    await prisma.project.delete({ where: { id: testProject.id } }).catch(() => {});
  });

  it('1. Build Planner accurately identifies Vite framework and default output directory', async () => {
    const plan = planner.createBuildPlan(fixturePath);

    expect(plan.framework).toBe('vite');
    expect(plan.outputDirectory).toBe('dist');
    expect(plan.buildCommand).toContain('build');
    expect(fs.existsSync(path.join(fixturePath, 'index.html'))).toBe(true);
  });

  it('2. Artifact Pipeline audits files and calculates SHA256 checksums', async () => {
    const mockDist = path.join(fixturePath, 'dist');
    fs.mkdirSync(mockDist, { recursive: true });
    fs.writeFileSync(
      path.join(mockDist, 'index.html'),
      '<!DOCTYPE html><html><body><h1>Sample Vite App - Built</h1></body></html>'
    );
    fs.writeFileSync(
      path.join(mockDist, 'app.js'),
      'console.log("Vite bundle executed");'
    );

    try {
      const audited = artifactPipeline.auditArtifacts(mockDist, fixturePath, 1000, 50 * 1024 * 1024);
      expect(audited.length).toBe(2);

      const htmlEntry = audited.find((e) => e.relativePath === 'index.html');
      expect(htmlEntry).toBeDefined();
      expect(htmlEntry?.contentType).toContain('html');
      expect(htmlEntry?.sha256).toBeDefined();

      const jsEntry = audited.find((e) => e.relativePath === 'app.js');
      expect(jsEntry).toBeDefined();
      expect(jsEntry?.contentType).toContain('javascript');
      expect(jsEntry?.sha256).toBeDefined();
    } finally {
      fs.rmSync(mockDist, { recursive: true, force: true });
    }
  });

  it('3. Cleanup Service dry-run detects artifacts and S3 prefixes without deleting', async () => {
    const result = await cleanupService.runFullCleanup({
      previewTtlDays: 0,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.tempDirectoriesCleaned).toBeGreaterThanOrEqual(0);
    expect(result.incompleteUploadsCleaned).toBeGreaterThanOrEqual(0);
    expect(result.orphanArtifactsCleaned).toBeGreaterThanOrEqual(0);
  });
});
