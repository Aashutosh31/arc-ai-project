/**
 * Toast state backbone (no components here — keeps fast-refresh lint happy).
 */
import { createContext } from 'react';

export const ToastContext = createContext(null);
