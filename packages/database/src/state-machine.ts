import { PrismaClient, DeploymentStatus, Deployment, LogStream } from '@prisma/client';
import {
  ALLOWED_STATE_TRANSITIONS,
  InvalidStateTransitionError,
  isValidTransition,
  isTerminalStatus,
} from '@doplo/types';

export {
  ALLOWED_STATE_TRANSITIONS,
  InvalidStateTransitionError,
  isValidTransition,
  isTerminalStatus,
};

export interface TransitionStateOptions {
  deploymentId: string;
  toStatus: DeploymentStatus;
  expectedStatus?: DeploymentStatus | DeploymentStatus[];
  eventMessage?: string;
  previewUrl?: string | null;
  s3Prefix?: string | null;
  buildDurationMs?: number | null;
  errorMessage?: string | null;
  logMessage?: string;
  logStream?: LogStream;
}

export interface TransitionStateResult {
  success: boolean;
  deployment?: Deployment;
  fromStatus?: DeploymentStatus;
  toStatus: DeploymentStatus;
  skippedDueToTerminal?: boolean;
  error?: string;
}

const isUuid = (str: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

/**
 * Atomically transitions a deployment status and creates a lifecycle event
 * in a single Prisma database transaction with optimistic concurrency.
 */
export async function transitionDeploymentState(
  prisma: PrismaClient,
  options: TransitionStateOptions
): Promise<TransitionStateResult> {
  const { deploymentId, toStatus, expectedStatus } = options;

  if (!isUuid(deploymentId)) {
    return {
      success: false,
      toStatus,
      error: `Invalid deployment ID format (UUID expected): "${deploymentId}"`,
    };
  }

  return await prisma.$transaction(async (tx) => {
    // 1. Fetch current deployment state
    const current = await tx.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        status: true,
        projectId: true,
      },
    });

    if (!current) {
      return {
        success: false,
        toStatus,
        error: `Deployment not found: "${deploymentId}"`,
      };
    }

    const currentStatus = current.status;

    // 2. Handle Terminal State Idempotency
    if (isTerminalStatus(currentStatus)) {
      if (currentStatus === toStatus) {
        return {
          success: true,
          fromStatus: currentStatus,
          toStatus,
          skippedDueToTerminal: true,
        };
      }
      return {
        success: false,
        fromStatus: currentStatus,
        toStatus,
        skippedDueToTerminal: true,
        error: `Deployment "${deploymentId}" is already in terminal state "${currentStatus}". Cannot transition to "${toStatus}".`,
      };
    }

    // 3. Optimistic Concurrency Check (if expectedStatus was specified)
    if (expectedStatus) {
      const allowedExpected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
      if (!allowedExpected.includes(currentStatus)) {
        return {
          success: false,
          fromStatus: currentStatus,
          toStatus,
          error: `Optimistic concurrency conflict: expected status [${allowedExpected.join(
            ', '
          )}] but current status is "${currentStatus}".`,
        };
      }
    }

    // 4. Validate state transition according to state machine rules
    if (!isValidTransition(currentStatus, toStatus)) {
      throw new InvalidStateTransitionError(deploymentId, currentStatus, toStatus);
    }

    // 5. Execute atomic update
    const updated = await tx.deployment.update({
      where: { id: deploymentId },
      data: {
        status: toStatus,
        previewUrl: options.previewUrl !== undefined ? options.previewUrl : undefined,
        s3Prefix: options.s3Prefix !== undefined ? options.s3Prefix : undefined,
        buildDurationMs: options.buildDurationMs !== undefined ? options.buildDurationMs : undefined,
        errorMessage: options.errorMessage !== undefined ? options.errorMessage : undefined,
      },
    });

    // 6. Record lifecycle event in the same transaction
    await tx.deploymentEvent.create({
      data: {
        deploymentId,
        fromStatus: currentStatus,
        toStatus,
        eventMessage:
          options.eventMessage ||
          options.errorMessage ||
          `Status transitioned from ${currentStatus} to ${toStatus}`,
      },
    });

    // 7. If optional log message provided, write to deployment logs
    if (options.logMessage) {
      const logCount = await tx.deploymentLog.count({ where: { deploymentId } });
      await tx.deploymentLog.create({
        data: {
          deploymentId,
          sequence: logCount + 1,
          stream: options.logStream || (toStatus === 'FAILED' ? LogStream.STDERR : LogStream.STDOUT),
          logChunk: options.logMessage,
        },
      });
    }

    // 8. If READY, update currentDeploymentId on the associated project
    if (toStatus === 'READY' && current.projectId) {
      await tx.project.update({
        where: { id: current.projectId },
        data: { currentDeploymentId: deploymentId },
      });
    }

    return {
      success: true,
      deployment: updated,
      fromStatus: currentStatus,
      toStatus,
    };
  });
}
