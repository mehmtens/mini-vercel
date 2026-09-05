import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '@doplo/config';
import { prisma } from '@doplo/database';
import {
  hashPassword,
  isValidEmail,
  issueSessionCookie,
  normalizeEmail,
  usernameFromIdentity,
  verifyPassword,
} from '../lib/auth-utils';

interface CredentialsBody {
  email?: string;
  password?: string;
  name?: string;
}

const authRateLimit = {
  config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
};

function publicUser(user: {
  id: string;
  username: string;
  email: string;
  avatarUrl: string | null;
}) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatarUrl: user.avatarUrl,
  };
}

export async function registerPasswordAuthRoutes(app: FastifyInstance) {
  const registerHandler = async (
    req: FastifyRequest<{ Body: CredentialsBody }>,
    reply: FastifyReply,
  ) => {
    const email = normalizeEmail(req.body?.email || '');
    const password = req.body?.password || '';
    const name = (req.body?.name || '').trim();

    if (!isValidEmail(email)) {
      return reply.code(400).send({ message: 'Enter a valid email address.' });
    }
    if (password.length < 10 || password.length > 128) {
      return reply.code(400).send({ message: 'Password must be between 10 and 128 characters.' });
    }
    if (name.length > 128) {
      return reply.code(400).send({ message: 'Name must be 128 characters or fewer.' });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return reply.code(409).send({
        message: 'An account already exists for this email. Sign in with its original method.',
      });
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        email,
        username: usernameFromIdentity(email, name),
        passwordHash,
        emailVerified: false,
      },
    });

    await issueSessionCookie(reply, user);
    return reply.code(201).send({ success: true, user: publicUser(user) });
  };

  const loginHandler = async (
    req: FastifyRequest<{ Body: CredentialsBody }>,
    reply: FastifyReply,
  ) => {
    const email = normalizeEmail(req.body?.email || '');
    const password = req.body?.password || '';
    const user = isValidEmail(email) ? await prisma.user.findUnique({ where: { email } }) : null;
    const valid = user?.passwordHash ? await verifyPassword(password, user.passwordHash) : false;

    if (!user || !valid) {
      return reply.code(401).send({ message: 'Invalid email or password.' });
    }

    await issueSessionCookie(reply, user);
    return reply.send({ success: true, user: publicUser(user) });
  };

  const providersHandler = async () => ({
    success: true,
    providers: {
      email: true,
      github:
        Boolean(config.github.clientId && config.github.clientSecret) &&
        !/^(mock_|your_)/.test(config.github.clientId) &&
        !/^(mock_|your_)/.test(config.github.clientSecret),
      google: Boolean(config.google.clientId && config.google.clientSecret),
    },
  });

  for (const prefix of ['/api/auth', '/api/v1/auth']) {
    app.post(`${prefix}/register`, authRateLimit, registerHandler);
    app.post(`${prefix}/login`, authRateLimit, loginHandler);
    app.get(`${prefix}/providers`, providersHandler);
  }
}
