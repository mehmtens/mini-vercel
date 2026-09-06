import type { PrismaClient, DeploymentStatus } from '@prisma/client';

export class InvalidStateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateTransitionError';
  }
}

export const ALLOWED_STATE_TRANSITIONS: Record<DeploymentStatus, DeploymentStatus[]> = {
  QUEUED: ['INITIALIZING', 'CANCELLED'],
  INITIALIZING: ['CLONING', 'FAILED', 'CANCELLED'],
  CLONING: ['BUILDING', 'FAILED', 'CANCELLED'],
  BUILDING: ['UPLOADING', 'FAILED', 'CANCELLED'],
  UPLOADING: ['DEPLOYING', 'FAILED', 'CANCELLED'],
  DEPLOYING: ['READY', 'FAILED', 'CANCELLED'],
  READY: [],
  FAILED: [],
  CANCELLED: [],
};

export function isValidTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  if (from === to) return true;
  const allowed = ALLOWED_STATE_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export function isTerminalStatus(status: DeploymentStatus): boolean {
  return ['READY', 'FAILED', 'CANCELLED'].includes(status);
}

export interface TransitionOptions {
  deploymentId: string;
  toStatus: DeploymentStatus;
  expectedStatus?: DeploymentStatus;
  eventMessage?: string;
  previewUrl?: string | null;
  buildDurationMs?: number | null;
  errorMessage?: string | null;
  s3Prefix?: string | null;
  logMessage?: string | null;
}

export async function transitionDeploymentState(
  prisma: PrismaClient,
  opts: TransitionOptions
): Promise<{
  success: boolean;
  fromStatus?: DeploymentStatus;
  toStatus?: DeploymentStatus;
  skippedDueToTerminal?: boolean;
  error?: string;
}> {
  return await (prisma as any).$transaction(async (tx: any) => {
    const deployment = await tx.deployment.findUnique({
      where: { id: opts.deploymentId },
      include: { project: true },
    });

    if (!deployment) {
      throw new Error(`Deployment ${opts.deploymentId} not found`);
    }

    const currentStatus = deployment.status as DeploymentStatus;

    if (isTerminalStatus(currentStatus)) {
      if (currentStatus === opts.toStatus) {
        return { success: true, fromStatus: currentStatus, toStatus: opts.toStatus, skippedDueToTerminal: true };
      }
      return {
        success: false,
        fromStatus: currentStatus,
        toStatus: opts.toStatus,
        skippedDueToTerminal: true,
        error: `Deployment is already in terminal state: ${currentStatus}`,
      };
    }

    if (opts.expectedStatus && currentStatus !== opts.expectedStatus) {
      return {
        success: false,
        fromStatus: currentStatus,
        toStatus: opts.toStatus,
        error: `Optimistic concurrency conflict: Expected ${opts.expectedStatus} but found ${currentStatus}`,
      };
    }

    if (!isValidTransition(currentStatus, opts.toStatus)) {
      throw new InvalidStateTransitionError(
        `Invalid deployment state transition from ${currentStatus} to ${opts.toStatus}`
      );
    }

    const updateData: any = {
      status: opts.toStatus,
      updatedAt: new Date(),
    };

    if (opts.previewUrl !== undefined) updateData.previewUrl = opts.previewUrl;
    if (opts.buildDurationMs !== undefined) updateData.buildDurationMs = opts.buildDurationMs;
    if (opts.errorMessage !== undefined) updateData.errorMessage = opts.errorMessage;
    if (opts.s3Prefix !== undefined) updateData.s3Prefix = opts.s3Prefix;

    await tx.deployment.update({
      where: { id: opts.deploymentId },
      data: updateData,
    });

    await tx.deploymentEvent.create({
      data: {
        deploymentId: opts.deploymentId,
        fromStatus: currentStatus,
        toStatus: opts.toStatus,
        eventMessage: opts.eventMessage || `Transitioned to ${opts.toStatus}`,
      },
    });

    if (opts.toStatus === 'READY') {
      await tx.project.update({
        where: { id: deployment.projectId },
        data: { currentDeploymentId: deployment.id },
      });
    }

    if (opts.logMessage) {
      const logCount = await tx.deploymentLog.count({
        where: { deploymentId: opts.deploymentId },
      });
      await tx.deploymentLog.create({
        data: {
          deploymentId: opts.deploymentId,
          logChunk: opts.logMessage,
          stream: 'STDOUT',
          sequence: logCount + 1,
        },
      });
    }

    return {
      success: true,
      fromStatus: currentStatus,
      toStatus: opts.toStatus,
    };
  });
}
