import { useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { supabase } from '../lib/supabase';

export type AuthMode = 'login' | 'signup' | 'forgot' | 'reset' | null;

type Props = {
  mode: AuthMode;
  onClose: () => void;
  onMode: (mode: AuthMode) => void;
};

export function AuthDialog({ mode, onClose, onMode }: Props) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  if (!mode) return null;
  const title = {
    login: 'Good to see you.',
    signup: 'Make it yours.',
    forgot: 'Reset your password.',
    reset: 'Choose a new password.',
  }[mode];

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    if (!supabase) {
      setError('Add the Supabase project URL and publishable key to .env.local first.');
      setBusy(false);
      return;
    }
    try {
      if (mode === 'login') {
        const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });
        if (loginError) throw loginError;
        onClose();
      } else if (mode === 'signup') {
        const { data, error: signupError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: window.location.origin,
            data: { full_name: name.trim(), phone: phone.trim() || null },
          },
        });
        if (signupError) throw signupError;
        if (data.session) onClose();
        else setNotice('Check your email for the verification link. Your account will have visitor access.');
      } else if (mode === 'forgot') {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + '/?mode=reset',
        });
        if (resetError) throw resetError;
        setNotice('If an account uses that email, Supabase will send a password reset link.');
      } else {
        const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
        if (updateError) throw updateError;
        setNotice('Password updated. You can now sign in.');
        setPassword('');
        onMode('login');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Authentication failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
      <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18}/></button>
      <span className="eyebrow"><span className="eyebrow-line"/> ILIGUIDE ACCOUNT</span>
      <h2 id="auth-title">{title}</h2>
      <p>{mode === 'signup'
        ? 'Create a visitor account. Staff roles are granted by the Tourism Office.'
        : mode === 'login' ? 'Sign in to manage your bookings and staff workspace.'
        : mode === 'forgot' ? 'We will send a reset link to your email address.'
        : 'Set a new password for your account.'}</p>
      <form onSubmit={submit}>
        {mode === 'signup' && <>
          <label>Full name<input required autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120}/></label>
          <label>Phone <span className="field-optional">optional</span><input autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={40}/></label>
        </>}
        {mode !== 'reset' && <label>Email<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254}/></label>}
        {mode === 'login' && <label>Password<input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)}/></label>}
        {mode === 'signup' && <label>Password<input required type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters"/></label>}
        {mode === 'reset' && <label>New password<input required type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="At least 8 characters"/></label>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {notice && <p className="form-success" role="status">{notice}</p>}
        <button className="btn btn-primary btn-wide" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Log in'
            : mode === 'signup' ? 'Create visitor account'
            : mode === 'forgot' ? 'Send reset link' : 'Update password'}
          {!busy && <ArrowRight size={16}/>}
        </button>
      </form>
      <div className="auth-switch">
        {mode === 'login' && <>
          <button onClick={() => onMode('forgot')}>Forgot password?</button>
          <span>New here? <button onClick={() => onMode('signup')}>Create account</button></span>
        </>}
        {mode === 'signup' && <span>Already have an account? <button onClick={() => onMode('login')}>Log in</button></span>}
        {mode === 'forgot' && <span>Remember your password? <button onClick={() => onMode('login')}>Log in</button></span>}
        {mode === 'reset' && <span><button onClick={() => onMode('login')}>Return to log in</button></span>}
      </div>
    </section>
  </div>;
}
