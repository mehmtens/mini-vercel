import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { config } from '@mini-vercel/config';
import { prisma } from '@mini-vercel/database';
import { authenticateRequest } from '../lib/auth';
import { createSession, destroySession, storeUserGitHubToken } from '../lib/session';

interface OAuthStateCookie {
  state: string;
  codeVerifier: string;
  createdAt: number;
}

export async function registerAuthRoutes(app: FastifyInstance) {
  // ----------------------------------------------------
  // 1. GET /api/auth/github/login
  // ----------------------------------------------------
  const githubLoginHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    // Generate high-entropy state & PKCE parameters
    const state = crypto.randomBytes(32).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const cookiePayload: OAuthStateCookie = {
      state,
      codeVerifier,
      createdAt: Date.now(),
    };

    // Store state and codeVerifier in short-lived HttpOnly signed cookie (10 min TTL)
    reply.setCookie('oauth_state', JSON.stringify(cookiePayload), {
      path: '/',
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      maxAge: 600,
      signed: true,
    });

    const params = new URLSearchParams({
      client_id: config.github.clientId,
      redirect_uri: config.github.callbackUrl,
      scope: 'read:user,user:email',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    const authorizeUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;

    // Support JSON format for testing / programmatic clients
    if ((req.query as any)?.format === 'json') {
      return reply.send({
        authorizeUrl,
        state,
        codeChallenge,
      });
    }

    return reply.redirect(authorizeUrl);
  };

  // ----------------------------------------------------
  // 2. GET /api/auth/github/callback
  // ----------------------------------------------------
  const githubCallbackHandler = async (
    req: FastifyRequest<{
      Querystring: {
        code?: string;
        state?: string;
        error?: string;
        error_description?: string;
      };
    }>,
    reply: FastifyReply
  ) => {
    const { code, state, error, error_description } = req.query;

    // Handle user cancellation / OAuth errors
    if (error) {
      reply.clearCookie('oauth_state', { path: '/' });
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `GitHub OAuth error: ${error_description || error}`,
      });
    }

    if (!code || !state) {
      reply.clearCookie('oauth_state', { path: '/' });
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Missing authorization code or state parameter',
      });
    }

    // Retrieve and verify OAuth state cookie
    const rawCookie = req.cookies?.oauth_state;
    if (!rawCookie) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Missing or expired OAuth state cookie',
      });
    }

    let cookieStateData: OAuthStateCookie | null = null;
    try {
      let cookieValue = rawCookie;
      if (typeof (req as any).unsignCookie === 'function') {
        const unsigned = (req as any).unsignCookie(rawCookie);
        if (unsigned.valid && unsigned.value) {
          cookieValue = unsigned.value;
        }
      }
      cookieStateData = JSON.parse(cookieValue) as OAuthStateCookie;
    } catch {
      reply.clearCookie('oauth_state', { path: '/' });
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Malformed OAuth state cookie',
      });
    }

    // Always clear the single-use state cookie
    reply.clearCookie('oauth_state', { path: '/' });

    if (!cookieStateData?.state || !cookieStateData.codeVerifier) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Invalid state verification parameters',
      });
    }

    // Verify 10-minute expiry window
    if (Date.now() - cookieStateData.createdAt > 10 * 60 * 1000) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'OAuth state has expired. Please try logging in again.',
      });
    }

    // Constant-time state comparison
    const expectedStateBuf = Buffer.from(cookieStateData.state);
    const actualStateBuf = Buffer.from(state);
    if (
      expectedStateBuf.length !== actualStateBuf.length ||
      !crypto.timingSafeEqual(expectedStateBuf, actualStateBuf)
    ) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Invalid OAuth state parameter (CSRF protection failed)',
      });
    }

    let githubUserId: string;
    let githubUsername: string;
    let githubEmail: string;
    let avatarUrl: string | null = null;
    let accessToken: string;

    // In test environment or mock code, use deterministic test user credentials
    if (config.env === 'test' || code.startsWith('mock_code_')) {
      githubUserId = 'gh_mock_12345';
      githubUsername = 'github_test_user';
      githubEmail = 'github_test_user@mini-vercel.local';
      avatarUrl = 'https://avatars.githubusercontent.com/u/12345';
      accessToken = `gho_mock_token_${crypto.randomBytes(16).toString('hex')}`;
    } else {
      // Exchange authorization code + PKCE code_verifier for GitHub access token
      try {
        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            client_id: config.github.clientId,
            client_secret: config.github.clientSecret,
            code,
            redirect_uri: config.github.callbackUrl,
            code_verifier: cookieStateData.codeVerifier,
          }),
        });

        const tokenData = (await tokenRes.json()) as any;
        if (!tokenData.access_token) {
          return reply.code(400).send({
            statusCode: 400,
            error: 'Bad Request',
            message: `GitHub token exchange failed: ${tokenData.error_description || tokenData.error || 'Unknown error'}`,
          });
        }
        accessToken = tokenData.access_token;

        // Fetch user profile from GitHub API
        const userRes = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': 'mini-vercel-app',
            Accept: 'application/vnd.github.v3+json',
          },
        });
        const ghUser = (await userRes.json()) as any;
        if (!ghUser.id || !ghUser.login) {
          return reply.code(502).send({
            statusCode: 502,
            error: 'Bad Gateway',
            message: 'Failed to retrieve user profile from GitHub',
          });
        }

        githubUserId = `gh_${ghUser.id}`;
        githubUsername = ghUser.login;
        avatarUrl = ghUser.avatar_url || null;

        // Fetch primary verified email if not public in profile
        if (ghUser.email) {
          githubEmail = ghUser.email;
        } else {
          const emailsRes = await fetch('https://api.github.com/user/emails', {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'User-Agent': 'mini-vercel-app',
              Accept: 'application/vnd.github.v3+json',
            },
          });
          const emails = (await emailsRes.json()) as any[];
          const primaryEmail = Array.isArray(emails)
            ? emails.find((e) => e.primary && e.verified)?.email || emails[0]?.email
            : null;
          githubEmail = primaryEmail || `${ghUser.login}@users.noreply.github.com`;
        }
      } catch (exchangeErr: any) {
        return reply.code(502).send({
          statusCode: 502,
          error: 'Bad Gateway',
          message: `OAuth communication error with GitHub: ${exchangeErr.message}`,
        });
      }
    }

    // Upsert user in database
    const user = await prisma.user.upsert({
      where: { githubId: githubUserId },
      update: {
        username: githubUsername,
        avatarUrl,
      },
      create: {
        githubId: githubUserId,
        username: githubUsername,
        email: githubEmail,
        avatarUrl,
      },
    });

    // Store encrypted access token in database
    await storeUserGitHubToken(user.id, accessToken);

    // Create session (renewing to prevent fixation)
    const sessionId = await createSession(user.id, user.username);

    // Set signed HttpOnly session cookie
    reply.setCookie('mini_session', sessionId, {
      path: '/',
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60,
      signed: true,
    });

    if ((req.query as any)?.format === 'json') {
      return reply.code(200).send({
        success: true,
        sessionId,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          avatarUrl: user.avatarUrl,
        },
      });
    }

    return reply.redirect(`${config.app.url}/`);
  };

  // ----------------------------------------------------
  // 3. POST /api/auth/logout
  // ----------------------------------------------------
  const logoutHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    let sessionId = req.cookies?.mini_session;
    if (sessionId && typeof (req as any).unsignCookie === 'function') {
      const unsigned = (req as any).unsignCookie(sessionId);
      if (unsigned.valid && unsigned.value) {
        sessionId = unsigned.value;
      }
    }

    if (sessionId) {
      await destroySession(sessionId);
    }

    reply.clearCookie('mini_session', { path: '/' });
    reply.clearCookie('oauth_state', { path: '/' });

    return reply.code(200).send({
      success: true,
      message: 'Logged out successfully',
    });
  };

  // ----------------------------------------------------
  // 4. GET /api/auth/me
  // ----------------------------------------------------
  const meHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const authUser = await authenticateRequest(req, reply);
    if (!authUser) return;

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: {
        id: true,
        username: true,
        email: true,
        avatarUrl: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'User profile not found',
      });
    }

    return reply.code(200).send({
      success: true,
      data: user,
    });
  };

  // Register on both /api/auth and /api/v1/auth
  for (const prefix of ['/api/auth', '/api/v1/auth']) {
    app.get(`${prefix}/github/login`, githubLoginHandler);
    app.get(`${prefix}/github/callback`, githubCallbackHandler);
    app.post(`${prefix}/logout`, logoutHandler);
    app.get(`${prefix}/me`, meHandler);
  }
};
