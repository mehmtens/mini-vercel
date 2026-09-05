import crypto from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '@doplo/config';
import { prisma } from '@doplo/database';
import { issueSessionCookie, normalizeEmail, usernameFromIdentity } from '../lib/auth-utils';

interface GoogleStateCookie {
  state: string;
  codeVerifier: string;
  createdAt: number;
}

function googleEnabled() {
  return Boolean(config.google.clientId && config.google.clientSecret);
}

function readSignedState(req: FastifyRequest): GoogleStateCookie | null {
  const rawCookie = req.cookies?.google_oauth_state;
  if (!rawCookie) return null;
  try {
    let value = rawCookie;
    const unsigned = req.unsignCookie(rawCookie);
    if (!unsigned.valid || !unsigned.value) return null;
    value = unsigned.value;
    return JSON.parse(value) as GoogleStateCookie;
  } catch {
    return null;
  }
}

export async function registerGoogleAuthRoutes(app: FastifyInstance) {
  const loginHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!googleEnabled()) {
      return reply.code(503).send({ message: 'Google sign-in is not configured yet.' });
    }

    const state = crypto.randomBytes(32).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    reply.setCookie(
      'google_oauth_state',
      JSON.stringify({ state, codeVerifier, createdAt: Date.now() }),
      {
        path: '/',
        httpOnly: true,
        secure: config.isProduction,
        sameSite: 'lax',
        maxAge: 600,
        signed: true,
      },
    );

    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: config.google.callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'online',
      prompt: 'select_account',
    });
    const authorizeUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    if ((req.query as { format?: string }).format === 'json') {
      return reply.send({ authorizeUrl, state, codeChallenge });
    }
    return reply.redirect(authorizeUrl);
  };

  const callbackHandler = async (
    req: FastifyRequest<{
      Querystring: {
        code?: string;
        state?: string;
        error?: string;
      };
    }>,
    reply: FastifyReply,
  ) => {
    const { code, state, error } = req.query;
    const cookieState = readSignedState(req);
    reply.clearCookie('google_oauth_state', { path: '/' });

    if (error || !code || !state || !cookieState) {
      return reply.code(400).send({ message: 'Google sign-in was cancelled or expired.' });
    }
    if (Date.now() - cookieState.createdAt > 10 * 60 * 1000) {
      return reply.code(400).send({ message: 'Google sign-in has expired.' });
    }
    const expected = Buffer.from(cookieState.state);
    const actual = Buffer.from(state);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return reply.code(400).send({ message: 'Invalid Google OAuth state.' });
    }

    try {
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
          code,
          redirect_uri: config.google.callbackUrl,
          grant_type: 'authorization_code',
          code_verifier: cookieState.codeVerifier,
        }),
      });
      const tokenData = (await tokenResponse.json()) as { access_token?: string };
      if (!tokenData.access_token) {
        return reply.code(400).send({ message: 'Google token exchange failed.' });
      }

      const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const profile = (await profileResponse.json()) as {
        sub?: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
        picture?: string;
      };
      if (!profile.sub || !profile.email || !profile.email_verified) {
        return reply.code(400).send({ message: 'Google did not return a verified email.' });
      }

      const email = normalizeEmail(profile.email);
      const existing = await prisma.user.findFirst({
        where: { OR: [{ googleId: profile.sub }, { email }] },
      });
      const user = existing
        ? await prisma.user.update({
            where: { id: existing.id },
            data: {
              googleId: profile.sub,
              emailVerified: true,
              avatarUrl: existing.avatarUrl || profile.picture || null,
            },
          })
        : await prisma.user.create({
            data: {
              googleId: profile.sub,
              email,
              emailVerified: true,
              username: usernameFromIdentity(email, profile.name),
              avatarUrl: profile.picture || null,
            },
          });

      await issueSessionCookie(reply, user);
      return reply.redirect(`${config.app.url}/`);
    } catch (errorValue) {
      req.log.error({ err: errorValue }, 'Google OAuth communication failed');
      return reply.code(502).send({ message: 'Could not communicate with Google.' });
    }
  };

  for (const prefix of ['/api/auth', '/api/v1/auth']) {
    app.get(`${prefix}/google/login`, loginHandler);
    app.get(`${prefix}/google/callback`, callbackHandler);
  }
}
