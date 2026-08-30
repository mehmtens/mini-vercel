import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  prisma,
  transitionDeploymentState,
  InvalidStateTransitionError,
  isValidTransition,
  isTerminalStatus,
  ALLOWED_STATE_TRANSITIONS,
} from './index';

describe('Deployment State Machine & Atomic Transitions', () => {
  const testRunId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  let testUserId: string;
  let testProjectId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        githubId: `gh_sm_${testRunId}`,
        username: `sm_tester_${testRunId}`,
        email: `sm_${testRunId}@example.com`,
      },
    });
    testUserId = user.id;

    const project = await prisma.project.create({
      data: {
        userId: testUserId,
        name: `SM Project ${testRunId}`,
        slug: `sm-project-${testRunId}`,
        repoName: `test/sm-project-${testRunId}`,
        repoUrl: `https://github.com/test/sm-project-${testRunId}`,
        branch: 'main',
      },
    });
    testProjectId = project.id;
  });

  afterAll(async () => {
    try {
      if (testProjectId) {
        await prisma.project.updateMany({
          where: { id: testProjectId },
          data: { currentDeploymentId: null },
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
      await prisma.$disconnect();
    } catch {}
  });

  describe('Pure State Machine Rules (Unit)', () => {
    it('verifies all expected valid transitions', () => {
      expect(isValidTransition('QUEUED', 'INITIALIZING')).toBe(true);
      expect(isValidTransition('INITIALIZING', 'CLONING')).toBe(true);
      expect(isValidTransition('CLONING', 'BUILDING')).toBe(true);
      expect(isValidTransition('BUILDING', 'UPLOADING')).toBe(true);
      expect(isValidTransition('UPLOADING', 'DEPLOYING')).toBe(true);
      expect(isValidTransition('DEPLOYING', 'READY')).toBe(true);

      expect(isValidTransition('QUEUED', 'CANCELLED')).toBe(true);
      expect(isValidTransition('BUILDING', 'CANCELLED')).toBe(true);
      expect(isValidTransition('CLONING', 'FAILED')).toBe(true);
      expect(isValidTransition('DEPLOYING', 'FAILED')).toBe(true);
    });

    it('rejects illegal transitions and jumps', () => {
      expect(isValidTransition('QUEUED', 'BUILDING')).toBe(false);
      expect(isValidTransition('QUEUED', 'READY')).toBe(false);
      expect(isValidTransition('INITIALIZING', 'READY')).toBe(false);
      expect(isValidTransition('CLONING', 'DEPLOYING')).toBe(false);
      expect(isValidTransition('READY', 'QUEUED')).toBe(false);
      expect(isValidTransition('READY', 'BUILDING')).toBe(false);
      expect(isValidTransition('FAILED', 'READY')).toBe(false);
      expect(isValidTransition('CANCELLED', 'READY')).toBe(false);
    });

    it('correctly identifies terminal statuses', () => {
      expect(isTerminalStatus('READY')).toBe(true);
      expect(isTerminalStatus('FAILED')).toBe(true);
      expect(isTerminalStatus('CANCELLED')).toBe(true);
      expect(isTerminalStatus('QUEUED')).toBe(false);
      expect(isTerminalStatus('BUILDING')).toBe(false);
    });
  });

  describe('Atomic Database State Transitions (Integration)', () => {
    it('executes full sequential lifecycle: QUEUED -> INITIALIZING -> CLONING -> BUILDING -> UPLOADING -> DEPLOYING -> READY', async () => {
      const dep = await prisma.deployment.create({
        data: {
          projectId: testProjectId,
          status: 'QUEUED',
          branch: 'main',
        },
      });

      // 1. QUEUED -> INITIALIZING
      const res1 = await transitionDeploymentState(prisma, {
        deploymentId: dep.id,
        toStatus: 'INITIALIZING',
        eventMessage: 'Initializing build worker',
      });
      expect(res1.success).toBe(true);
      expect(res1.fromStatus).toBe('QUEUED');
      expect(res1.toStatus).toBe('INITIALIZING');

      // 2. INITIALIZING -> CLONING
      const res2 = await transitionDeploymentState(prisma, {
        deploymentId: dep.id,
        toStatus: 'CLONING',
      });
      expect(res2.success).toBe(true);
      expect(res2.toStatus).toBe('CLONING');

      // 3. CLONING -> BUILDING
      const res3 = await transitionDeploymentState(prisma, {
        deploymentId: dep.id,
        toStatus: 'BUILDING',
      });
      expect(res3.success).toBe(true);
      expect(res3.toStatus).toBe('BUILDING');

      // 4. BUILDING -> UPLOADING
      const res4 = await transitionDeploymentState(prisma, {
        deploymentId: dep.id,
        toStatus: 'UPLOADING',
        s3Prefix: `artifacts/${testProjectId}/${dep.id}`,
      });
      expect(res4.success).toBe(true);
      expect(res4.toStatus).toBe('UPLOADING');

      // 5. UPLOADING -> DEPLOYING
      const res5 = await transitionDeploymentState(prisma, {
        deploymentId: dep.id,
        toStatus: 'DEPLOYING',
        previewUrl: `https://${testProjectId}.mini-vercel.app`,
      });
      expect(res5.success).toBe(true);
      expect(res5.toStatus).toBe('DEPLOYING');

      // 6. DEPLOYING -> READY
      const res6 = await transitionDeploymentState(prisma, {
        deploymentId: dep.id,
        toStatus: 'READY',
        buildDurationMs: 3400,
        logMessage: '[SUCCESS] Live at edge CDN',
      });
      expect(res6.success).toBe(true);
      expect(res6.toStatus).toBe('READY');

      // Verify all lifecycle events were recorded in order
      const events = await prisma.deploymentEvent.findMany({
        where: { deploymentId: dep.id },
        orderBy: { timestamp: 'asc' },
      });
      expect(events.length).toBe(6);
      expect(events.map((e) => e.toStatus)).toEqual([
        'INITIALIZING',
        'CLONING',
        'BUILDING',
        'UPLOADING',
        'DEPLOYING',
        'READY',
      ]);

      // Verify Project currentDeploymentId was updated on READY
      const updatedProj = await prisma.project.findUnique({
        where: { id: testProjectId },
      });
      expect(updatedProj?.currentDeploymentId).toBe(dep.id);
    });

    it('rejects invalid jump transitions with InvalidStateTransitionError', async () => {
      const dep = await prisma.deployment.create({
        data: {
          projectId: testProjectId,
          status: 'QUEUED',
          branch: 'main',
        },
      });

      // Attempt illegal jump: QUEUED -> READY
      await expect(
        transitionDeploymentState(prisma, {
          deploymentId: dep.id,
          toStatus: 'READY',
        })
      ).rejects.toThrow(InvalidStateTransitionError);

      // Verify deployment remains in QUEUED status
      const current = await prisma.deployment.findUnique({ where: { id: dep.id } });
      expect(current?.status).toBe('QUEUED');
    });

    it('enforces optimistic concurrency when expectedStatus does not match', async () => {
      const dep = await prisma.deployment.create({
        data: {
          projectId: testProjectId,
          status: 'BUILDING',
          branch: 'main',
        },
      });

      // Expect QUEUED but record is already BUILDING
      const result = await transitionDeploymentState(prisma, {
        deploymentId: dep.id,
        expectedStatus: 'QUEUED',
        toStatus: 'INITIALIZING',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Optimistic concurrency conflict');

      // Verify deployment status is unchanged
      const current = await prisma.deployment.findUnique({ where: { id: dep.id } });
      expect(current?.status).toBe('BUILDING');
    });

    it('handles terminal state idempotency without throwing', async () => {
      const dep = await prisma.deployment.create({
        data: {
          projectId: testProjectId,
          status: 'READY',
          branch: 'main',
        },
      });

      // Re-transition to READY (idempotent duplicate event)
      const result = await transitionDeploymentState(prisma, {
        deploymentId: dep.id,
        toStatus: 'READY',
      });

      expect(result.success).toBe(true);
      expect(result.skippedDueToTerminal).toBe(true);

      // Attempt to modify terminal READY -> FAILED
      const failResult = await transitionDeploymentState(prisma, {
        deploymentId: dep.id,
        toStatus: 'FAILED',
      });

      expect(failResult.success).toBe(false);
      expect(failResult.skippedDueToTerminal).toBe(true);
      expect(failResult.error).toContain('already in terminal state');
    });
  });
});
