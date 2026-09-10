/**
 * useToast hook (separate module so Toast.jsx exports components only).
 */
import { useContext } from 'react';
import { ToastContext } from './toastContext.js';

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

export default useToast;
