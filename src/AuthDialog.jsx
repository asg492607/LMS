import React, { useEffect, useState } from 'react';
import { supabase } from './supabase.js';
import { getAccessToken } from './apiAuth.js';
import { apiUrl } from './apiBase.js';

function getFriendlyError(error) {
  const messages = {
    invalid_credentials: 'Email or password is incorrect.',
    invalid_email: 'Enter a valid email address.',
    user_already_exists: 'An account already exists for this email.',
    weak_password: 'Choose a stronger password with at least 12 characters.',
    over_email_send_rate_limit: 'Too many email requests. Wait a while and try again.',
    email_not_confirmed: 'Verify your email using the link we sent, then sign in again.',
    signup_disabled: 'Email and password sign-up is not enabled in Supabase Auth yet.',
  };
  return messages[error?.code] || 'We could not complete that request. Check your details and try again.';
}

function isStrongPassword(value) {
  return value.length >= 12
    && value.length <= 128
    && /[a-z]/.test(value)
    && /[A-Z]/.test(value)
    && /\d/.test(value)
    && /[^A-Za-z0-9]/.test(value);
}

export default function AuthDialog({ user, isPlatformAdmin, roleAssignments, onAdminStatus, onRoleAssignments, onOpenAdmin, onOpenPortal, onClose }) {
  const [mode, setMode] = useState('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [apiStatus, setApiStatus] = useState('Checking protected service…');

  useEffect(() => {
    if (!user) {
      onAdminStatus(false);
      onRoleAssignments([]);
      return undefined;
    }
    if (user.mustChangePassword) {
      onAdminStatus(false);
      onRoleAssignments([]);
      setApiStatus('Change your temporary password to finish account setup.');
      return undefined;
    }
    let active = true;
    onAdminStatus(false);
    onRoleAssignments([]);
    (async () => {
      try {
        const token = await getAccessToken();
        const response = await fetch(apiUrl('/api/me'), {
          headers: { Authorization: `Bearer ${token}` },
        });
        const result = await response.json().catch(() => ({}));
        if (response.status === 503) throw new Error(result.error || 'Supabase Auth or the LMS database is unavailable. Check the backend configuration.');
        if (response.status === 403) throw new Error('Email verification is required. Verify your email, then sign out and sign in again.');
        if (response.status === 401) throw new Error('This session is invalid or expired. Sign out and sign in again.');
        if (!response.ok) throw new Error('The protected backend could not verify this session.');
        if (active) {
          setApiStatus(`Supabase LMS backend connected for ${result.email || user.email}.`);
          onAdminStatus(result.platformAdmin === true);
          onRoleAssignments(Array.isArray(result.roles) ? result.roles : []);
        }
      } catch (error) {
        if (active) {
          onAdminStatus(false);
          onRoleAssignments([]);
          setApiStatus(error.message || 'Backend is unavailable. Start the API server to use protected features.');
        }
      }
    })();
    return () => { active = false; };
  }, [user, onAdminStatus, onRoleAssignments]);

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const setFeedback = (text, error = false) => {
    setMessage(text);
    setIsError(error);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!supabase) {
      setFeedback('Supabase is not configured. Add the VITE_SUPABASE settings to .env.local and restart Vite.', true);
      return;
    }
    setLoading(true);
    setFeedback('');
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { display_name: name.trim() },
            emailRedirectTo: window.location.origin,
          },
        });
        if (error) throw error;
        await supabase.auth.signOut();
        setPassword('');
        setMode('signin');
        setFeedback('Account created. Check your email to verify it, then sign in. If an administrator invited you, use the same email address.');
      } else if (mode === 'reset') {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
        if (error) throw error;
        setFeedback('If an account exists for that email, a password reset link has been sent.');
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        if (!data.user?.email_confirmed_at && !data.user?.confirmed_at) {
          await supabase.auth.resend({ type: 'signup', email: email.trim(), options: { emailRedirectTo: window.location.origin } });
          await supabase.auth.signOut();
          setPassword('');
          setFeedback('Please verify your email using the link we just sent, then sign in again.', true);
        }
      }
    } catch (error) {
      if (mode === 'reset') {
        setFeedback('If an account exists for that email, a password reset link has been sent.');
      } else {
        setFeedback(getFriendlyError(error), true);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleInitialPasswordChange = async (event) => {
    event.preventDefault();
    if (!supabase) {
      setFeedback('Supabase is not configured on this page.', true);
      return;
    }
    if (!isStrongPassword(newPassword)) {
      setFeedback('Use 12–128 characters with uppercase and lowercase letters, a number, and a symbol.', true);
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setFeedback('The new passwords do not match.', true);
      return;
    }
    setLoading(true);
    setFeedback('');
    try {
      const token = await getAccessToken();
      const response = await fetch(apiUrl('/api/auth/change-initial-password'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'The password could not be updated. Try again.');
      setNewPassword('');
      setConfirmNewPassword('');
      const { error } = await supabase.auth.refreshSession();
      if (error) {
        await supabase.auth.signOut();
        setFeedback('Password updated. Sign in again with the new password.');
      } else {
        setFeedback('Password updated. Your LMS access is ready.');
      }
    } catch (error) {
      setFeedback(error.message || 'The password could not be updated. Try again.', true);
    } finally {
      setLoading(false);
    }
  };

  const changeMode = (nextMode) => {
    setMode(nextMode);
    setPassword('');
    setFeedback('');
  };

  const handleSignOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    onAdminStatus(false);
    setFeedback('You are signed out.');
    setMode('signin');
  };

  const handleResendVerification = async () => {
    if (!supabase || !user) return;
    setLoading(true);
    setFeedback('');
    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: user.email,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      setFeedback('Verification email sent. Check your inbox, then sign out and sign in again.');
    } catch (error) {
      setFeedback(getFriendlyError(error), true);
    } finally {
      setLoading(false);
    }
  };

  const title = user
    ? user.mustChangePassword ? 'Finish account setup' : 'You’re signed in'
    : mode === 'signup' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : 'Welcome back';

  return (
    <div className="auth-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <button className="auth-close" type="button" onClick={onClose} aria-label="Close sign-in dialog">×</button>
        <div className="auth-logo"><img src="/assets/mit-adt-logo.png" alt="MIT ADT University" /></div>
        <h2 id="auth-title">{title}</h2>
        <p className="auth-intro">{user ? 'Your MIT ADT LMS session is active.' : 'Sign in to continue to your learning space, or create an account to get started.'}</p>

        {user ? (
          <div className="signed-in-panel">
            <strong>{user.displayName || user.email}</strong>
            {user.mustChangePassword ? (
              <>
                <p>Set a new password before opening your LMS workspace.</p>
                <form className="auth-form" onSubmit={handleInitialPasswordChange}>
                  <label className="auth-field">New password<input type="password" autoComplete="new-password" minLength={12} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
                  <label className="auth-field">Confirm new password<input type="password" autoComplete="new-password" minLength={12} maxLength={128} value={confirmNewPassword} onChange={(event) => setConfirmNewPassword(event.target.value)} required /></label>
                  <small>Use 12–128 characters with uppercase and lowercase letters, a number, and a symbol.</small>
                  <button className="auth-submit" type="submit" disabled={loading}>{loading ? 'Updating…' : 'Update password'}</button>
                </form>
              </>
            ) : (
              <>
                <p>{user.emailVerified ? 'Email verified' : 'Email verification required'} · {apiStatus}</p>
                {isPlatformAdmin && <button className="admin-access-button" type="button" onClick={onOpenAdmin}>Open admin dashboard</button>}
                {roleAssignments.length > 0 && <button className="portal-access-button" type="button" onClick={onOpenPortal}>Open my workspace <span>({roleAssignments.length} role{roleAssignments.length === 1 ? '' : 's'})</span></button>}
                {!user.emailVerified && <button className="verify-button" type="button" onClick={handleResendVerification} disabled={loading}>{loading ? 'Sending…' : 'Resend verification email'}</button>}
              </>
            )}
            <button className="signout-button" type="button" onClick={handleSignOut}>Sign out</button>
          </div>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit}>
            {mode === 'signup' && <label className="auth-field">Full name<input autoComplete="name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} required /></label>}
            <label className="auth-field">University email<input type="email" name="email" autoComplete="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
            {mode !== 'reset' && <label className="auth-field">Password<input type="password" name="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={mode === 'signup' ? 12 : 1} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>}
            <button className="auth-submit" type="submit" disabled={loading || !supabase}>
              {loading ? 'Please wait…' : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'}
            </button>
          </form>
        )}

        {!user && <div className="auth-switches">
          {mode === 'signin' ? <><button type="button" onClick={() => changeMode('signup')}>Create an account</button><button type="button" onClick={() => changeMode('reset')}>Forgot password?</button></> : <button type="button" onClick={() => changeMode('signin')}>Back to sign in</button>}
        </div>}
        {message && <p className={`auth-message ${isError ? 'error' : ''}`} role="status">{message}</p>}
        <p className="auth-security-note">Public signups must verify their email. Accounts created by an administrator are confirmed during provisioning and must change their temporary password before using the LMS.</p>
      </section>
    </div>
  );
}
