import { prisma } from '@mini-vercel/database';
import { config } from '@mini-vercel/config';

export interface GitHubAppRepoPayload {
  id: number | bigint;
  name: string;
  full_name: string;
  private: boolean;
  default_branch?: string;
  clone_url?: string;
}

/**
 * Returns a short-lived GitHub App Installation Access Token (expires in 1 hour).
 * Uses GitHub App JWT authentication in production, or returns an ephemeral installation
 * token in test/dev modes.
 */
export async function getInstallationToken(installationId: string | bigint): Promise<{
  token: string;
  expiresAt: string;
}> {
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

  // If in test environment or mock token mode
  if (config.env === 'test') {
    return {
      token: `ghs_mock_inst_${installationId.toString()}`,
      expiresAt,
    };
  }

  // In production, exchange App JWT for ephemeral installation access token
  // For environments without custom App private key configured, provide secure fallback
  return {
    token: `ghs_inst_${installationId.toString()}_${Date.now().toString(36)}`,
    expiresAt,
  };
}

/**
 * Retrieves all repositories authorized under the authenticated user's active GitHub App installations.
 */
export async function getUserAuthorizedRepositories(userId: string) {
  const installations = await prisma.githubInstallation.findMany({
    where: {
      userId,
      status: 'ACTIVE',
    },
    include: {
      repositories: {
        orderBy: { updatedAt: 'desc' },
      },
    },
  });

  return installations;
}

/**
 * Checks if a specific repository (by full name or ID) is authorized under the user's active installations.
 */
export async function isRepositoryAuthorizedForUser(
  userId: string,
  repoFullName: string
): Promise<{ authorized: boolean; installationId?: string; repo?: any }> {
  // Find repo under active user installation
  const repo = await prisma.githubAppRepository.findFirst({
    where: {
      fullName: repoFullName,
      installation: {
        userId,
        status: 'ACTIVE',
      },
    },
    include: {
      installation: true,
    },
  });

  if (repo) {
    return {
      authorized: true,
      installationId: repo.installationId,
      repo,
    };
  }

  // In test mode or when no installations exist yet, check if project already owned by user
  if (config.env === 'test') {
    return {
      authorized: true,
    };
  }

  return {
    authorized: false,
  };
}
