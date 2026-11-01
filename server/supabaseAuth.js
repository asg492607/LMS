import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const projectUrl = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const adminKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabaseAuthConfigured = Boolean(projectUrl && publishableKey);
export const supabaseAuth = supabaseAuthConfigured
  ? createClient(projectUrl, publishableKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    })
  : null;
export const supabaseAdminAuthConfigured = Boolean(projectUrl && adminKey);
export const supabaseAdminAuth = supabaseAdminAuthConfigured
  ? createClient(projectUrl, adminKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    })
  : null;
