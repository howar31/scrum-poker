import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Info, AlertTriangle, XCircle, CheckCircle2 } from 'lucide-react';
import { clsx } from 'clsx';
import { usePokerStore, type Toast as ToastType, type ToastVariant } from '../store/usePokerStore';

const AUTO_DISMISS_MS = 3500;

const VARIANT_STYLES: Record<ToastVariant, string> = {
  info: 'bg-blue-50 dark:bg-blue-950/60 border-blue-300 dark:border-blue-700 text-blue-800 dark:text-blue-100',
  success: 'bg-green-50 dark:bg-green-950/60 border-green-300 dark:border-green-700 text-green-800 dark:text-green-100',
  warning: 'bg-amber-50 dark:bg-amber-950/60 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-100',
  error: 'bg-red-50 dark:bg-red-950/60 border-red-300 dark:border-red-700 text-red-800 dark:text-red-100',
};

const VARIANT_ICON: Record<ToastVariant, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

function ToastItem({ toast }: { toast: ToastType }) {
  const dismissToast = usePokerStore((s) => s.dismissToast);
  const Icon = VARIANT_ICON[toast.variant];

  useEffect(() => {
    const handle = setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(handle);
  }, [toast.id, dismissToast]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 40, scale: 0.9 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, scale: 0.85, transition: { duration: 0.2 } }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      className={clsx(
        'flex items-start gap-2.5 border rounded-lg shadow-lg px-4 py-3 text-sm min-w-[260px] max-w-sm backdrop-blur-sm',
        VARIANT_STYLES[toast.variant]
      )}
      role="status"
    >
      <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" />
      <span className="flex-1">{toast.message}</span>
      <button
        onClick={() => dismissToast(toast.id)}
        className="opacity-60 hover:opacity-100 transition text-xs"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </motion.div>
  );
}

export default function ToastContainer() {
  const toasts = usePokerStore((s) => s.toasts);

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      <div className="pointer-events-auto flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
