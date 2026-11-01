import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { adminAuth, adminDb, dbPool } from './supabaseDb.js';
import { supabaseAdminAuthConfigured, supabaseAuth } from './supabaseAuth.js';
import { requireAuthenticated, requirePasswordChanged, requirePlatformAdmin } from './auth.js';
import adminRoutes from './adminRoutes.js';
import portalRoutes from './portalRoutes.js';

const port = Number(process.env.PORT || process.env.API_PORT || 4000);
const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed.'));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  maxAge: 600,
}));
app.use(express.json({ limit: '2mb', strict: true }));
app.get('/healthz', async (_request, response) => {
  if (!dbPool || !supabaseAuth || !supabaseAdminAuthConfigured) {
    return response.status(503).type('text/plain').send('not ready');
  }
  try {
    await dbPool.query('select 1');
    return response.status(200).type('text/plain').send('ok');
  } catch (error) {
    console.error('Readiness check failed:', error?.code || error?.name || 'unknown-error');
    return response.status(503).type('text/plain').send('not ready');
  }
});
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
}));
const adminWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (request) => request.authUser.uid,
  skip: (request) => ['GET', 'HEAD', 'OPTIONS'].includes(request.method),
  message: { error: 'Admin change limit reached. Try again later.' },
});

function isStrongPassword(password) {
  return typeof password === 'string'
    && password.length >= 12
    && password.length <= 128
    && /[a-z]/.test(password)
    && /[A-Z]/.test(password)
    && /\d/.test(password)
    && /[^A-Za-z0-9]/.test(password);
}

app.get('/api/health', (_request, response) => {
  const authenticationConfigured = Boolean(supabaseAuth);
  const databaseConfigured = Boolean(adminDb);
  response.json({
    status: authenticationConfigured && databaseConfigured && supabaseAdminAuthConfigured ? 'ok' : 'degraded',
    authenticationConfigured,
    databaseConfigured,
    accountProvisioningConfigured: supabaseAdminAuthConfigured,
  });
});

app.post('/api/auth/change-initial-password', requireAuthenticated, async (request, response) => {
  if (!request.authUser.must_change_password) {
    return response.status(409).json({ error: 'No initial password change is required for this account.' });
  }
  const password = request.body?.password;
  if (!isStrongPassword(password)) {
    return response.status(400).json({ error: 'Use 12–128 characters with uppercase and lowercase letters, a number, and a symbol.' });
  }
  if (!adminAuth) {
    return response.status(503).json({ error: 'Secure password setup is not configured on this server.' });
  }
  try {
    await adminAuth.updateInitialPassword(request.authUser.uid, password, request.authUser.app_metadata);
    return response.status(204).end();
  } catch (error) {
    console.error('Initial password update failed:', error?.code || error?.name || 'unknown-error');
    return response.status(503).json({ error: 'The password could not be updated. Try again shortly.' });
  }
});

app.get('/api/me', requireAuthenticated, requirePasswordChanged, async (request, response) => {
  let roles = [];
  let platformAdmin = request.authUser.platformAdmin === true;
  if (adminDb) {
    try {
      const snapshot = await adminDb.collection('users').doc(request.authUser.uid).collection('roles').limit(100).get();
      const allRoles = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      platformAdmin ||= allRoles.some((role) => role.role === 'platform_admin');
      roles = allRoles.filter((role) => role.role !== 'platform_admin');
    } catch {
      roles = [];
    }
  }
  return response.json({
    uid: request.authUser.uid,
    email: request.authUser.email || null,
    emailVerified: Boolean(request.authUser.email_verified),
    platformAdmin,
    role: platformAdmin ? 'platform_admin' : null,
    roles,
  });
});

app.use('/api/admin', requireAuthenticated, requirePasswordChanged, requirePlatformAdmin, adminWriteLimiter, adminRoutes);
app.use('/api/portal', requireAuthenticated, requirePasswordChanged, portalRoutes);

app.use((error, _request, response, _next) => {
  if (response.headersSent) return;
  const originDenied = error?.message === 'Origin is not allowed.';
  const status = originDenied ? 403 : (error?.status >= 400 && error?.status < 500 ? error.status : 500);
  if (!originDenied) console.error('API request failed:', error?.code || error?.name || 'unknown-error');
  return response.status(status).json({
    error: originDenied ? 'Request origin is not allowed.' : status === 500 ? 'Request could not be processed.' : 'Invalid request.',
  });
});

app.listen(port, process.env.HOST || '0.0.0.0', () => {
  console.log(`MIT ADT LMS API listening on port ${port}`);
});
