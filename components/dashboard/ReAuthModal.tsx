'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

interface ReAuthModalProps {
  open: boolean;
  title?: string;
  description?: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

export function ReAuthModal({ open, title, description, onConfirm, onClose }: ReAuthModalProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState(false);

  if (!open) return null;

  const handleVerify = async () => {
    setError('');
    if (!password.trim()) {
      setError('Please enter your password.');
      return;
    }
    setVerifying(true);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.email) {
        setError('Unable to verify your identity. Please try again.');
        setVerifying(false);
        return;
      }
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password,
      });
      if (signInError) {
        setError('Incorrect password. Please try again.');
        setVerifying(false);
        return;
      }
      // Password verified — execute the action
      await onConfirm();
      setPassword('');
      onClose();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="reauth-modal-title" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="mx-4 w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-800">
        <h2 id="reauth-modal-title" className="text-lg font-semibold text-gray-900 dark:text-white">
          {title || 'Confirm Your Identity'}
        </h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          {description || 'Please enter your password to continue with this action.'}
        </p>

        <div className="mt-4">
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            Current Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleVerify(); }}
            placeholder="Enter your password"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            autoFocus
          />
        </div>

        {error && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        <div className="mt-6 flex gap-3">
          <button
            onClick={handleVerify}
            disabled={verifying || !password.trim()}
            className="flex-1 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {verifying ? 'Verifying...' : 'Confirm'}
          </button>
          <button
            onClick={() => { setPassword(''); setError(''); onClose(); }}
            disabled={verifying}
            className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
