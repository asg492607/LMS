import { supabaseAuth } from './supabaseAuth.js';
import { adminDb, UNIVERSITY_ID } from './supabaseDb.js';

export async function requireAuthenticated(request, response, next) {
  if (!supabaseAuth) {
    return response.status(503).json({ error: 'Supabase Auth is not configured on the backend.' });
  }

  const match = (request.get('authorization') || '').match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  if (!match) return response.status(401).json({ error: 'Authentication required.' });

  try {
    const { data, error } = await supabaseAuth.auth.getUser(match[1]);
    const user = data?.user;
    if (error || !user) {
      return response.status(401).json({ error: 'Session is invalid or expired. Sign in again.' });
    }
    const emailVerified = Boolean(user.email_confirmed_at || user.confirmed_at);
    if (!emailVerified) {
      return response.status(403).json({ error: 'Verify your email before accessing protected LMS services.' });
    }
    request.authUser = {
      uid: user.id,
      email: user.email || null,
      email_verified: emailVerified,
      must_change_password: user.app_metadata?.must_change_password === true,
      app_metadata: user.app_metadata || {},
      name: user.user_metadata?.display_name || user.user_metadata?.full_name || null,
    };
    return next();
  } catch {
    return response.status(401).json({ error: 'Session is invalid or expired. Sign in again.' });
  }
}

export function requirePasswordChanged(request, response, next) {
  if (request.authUser.must_change_password) {
    return response.status(403).json({
      code: 'password_change_required',
      error: 'Change your temporary password before using the LMS.',
    });
  }
  return next();
}

export async function requirePlatformAdmin(request, response, next) {
  if (!adminDb) return response.status(503).json({ error: 'The LMS database is not configured.' });
  try {
    const roles = await adminDb.collection('users').doc(request.authUser.uid).collection('roles')
      .where('universityId', '==', UNIVERSITY_ID)
      .limit(100)
      .get();
    if (!roles.docs.some((doc) => doc.data()?.role === 'platform_admin')) {
      return response.status(403).json({ error: 'Platform administrator access is required.' });
    }
    request.authUser.platformAdmin = true;
    return next();
  } catch {
    return response.status(503).json({ error: 'Administrator access could not be checked.' });
  }
}
