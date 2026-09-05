import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma, User } from '@doplo/database';
import { config } from '@doplo/config';
import { getSession } from './session';

export interface AuthenticatedUser {
  id: string;
  githubId: string | null;
  username: string;
  email: string;
}

/**
 * Authenticates the incoming request using Session Cookie, Bearer Token, or Dev Bypass headers.
 * If authentication fails or is missing, sends a 401 Unauthorized reply and returns null.
 */
export async function authenticateRequest(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthenticatedUser | null> {
  let user: User | null = null;

  // 1. Check Session Cookie (Signed or Unsigned)
  const sessionCookie = req.cookies?.mini_session;
  if (sessionCookie) {
    let sessionId = sessionCookie;
    if (typeof (req as any).unsignCookie === 'function') {
      const unsigned = (req as any).unsignCookie(sessionCookie);
      if (unsigned.valid && unsigned.value) {
        sessionId = unsigned.value;
      }
    }

    const session = await getSession(sessionId);
    if (session?.userId) {
      user = await prisma.user.findUnique({ where: { id: session.userId } });
    }
  }

  // 2. Check Authorization Bearer Header
  if (!user) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const bearerToken = authHeader.slice(7).trim();
      if (bearerToken) {
        // Check if bearerToken is a sessionId in Redis
        const session = await getSession(bearerToken);
        if (session?.userId) {
          user = await prisma.user.findUnique({ where: { id: session.userId } });
        }

        // Check if bearerToken is directly a UUID or identifier
        if (!user) {
          const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            bearerToken,
          );
          if (isUuid) {
            user = await prisma.user.findUnique({ where: { id: bearerToken } });
          }
          if (!user) {
            user = await prisma.user.findFirst({
              where: {
                OR: [{ githubId: bearerToken }, { username: bearerToken }, { email: bearerToken }],
              },
            });
          }
        }
      }
    }
  }

  // 3. Check Dev/Test Header or Query Bypass (Only allowed in non-production or test environment)
  const isDevOrTest = config.env === 'test' || (!config.isProduction && config.auth.devBypass);
  if (!user && isDevOrTest) {
    const devUserId = (req.headers['x-user-id'] ||
      req.headers['x-github-id'] ||
      req.headers['x-user'] ||
      (req.query as any)?.userId ||
      (req.query as any)?.user) as string | undefined;

    if (devUserId) {
      const token = devUserId.trim();
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);

      if (isUuid) {
        user = await prisma.user.findUnique({ where: { id: token } });
      }

      if (!user) {
        user = await prisma.user.findFirst({
          where: {
            OR: [{ githubId: token }, { username: token }, { email: token }],
          },
        });
      }

      // If token is a test username or mock ID not yet in DB, create it on demand in test/dev
      if (!user && token.length >= 3) {
        try {
          user = await prisma.user.create({
            data: {
              githubId: isUuid ? `gh_${token.slice(0, 8)}` : `gh_${token}`,
              username: isUuid ? `user_${token.slice(0, 8)}` : token,
              email: isUuid ? `${token.slice(0, 8)}@doplo.local` : `${token}@doplo.local`,
            },
          });
        } catch {
          user = await prisma.user.findFirst({
            where: {
              OR: [{ githubId: `gh_${token}` }, { username: token }],
            },
          });
        }
      }
    }
  }

  // 4. Check Query Parameter Token (Useful for EventSource / SSE in browsers)
  if (!user) {
    const queryToken =
      (req.query as any)?.token || (req.query as any)?.access_token || (req.query as any)?.auth;
    if (typeof queryToken === 'string' && queryToken.trim()) {
      const token = queryToken.trim();
      const session = await getSession(token);
      if (session?.userId) {
        user = await prisma.user.findUnique({ where: { id: session.userId } });
      }
      if (!user) {
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          token,
        );
        if (isUuid) {
          user = await prisma.user.findUnique({ where: { id: token } });
        }
      }
    }
  }

  if (!user) {
    reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Authentication required. Please log in or provide valid credentials.',
    });
    return null;
  }

  return {
    id: user.id,
    githubId: user.githubId,
    username: user.username,
    email: user.email,
  };
}
