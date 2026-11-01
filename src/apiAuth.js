import { supabase } from './supabase.js';

export async function getAccessToken() {
  if (!supabase) throw new Error('Supabase is not configured. Check the VITE_SUPABASE settings.');
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) {
    throw new Error('Your session has expired. Sign in again to continue.');
  }
  return data.session.access_token;
}
