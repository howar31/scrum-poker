import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { usePokerStore } from '../store/usePokerStore';

export default function MigrationOverlay() {
  const { t } = useTranslation();
  const migrationPhase = usePokerStore((s) => s.migrationPhase);
  const animationsEnabled = usePokerStore((s) => s.animationsEnabled);

  const active = migrationPhase !== 'idle';
  const title = migrationPhase === 'reclaiming' ? t('migration.reclaiming') : t('migration.waiting');
  const detail =
    migrationPhase === 'reclaiming'
      ? t('migration.reclaimingDetail')
      : t('migration.waitingDetail');

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          key="migration-overlay"
          initial={animationsEnabled ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          exit={animationsEnabled ? { opacity: 0 } : undefined}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          role="status"
          aria-live="polite"
        >
          <motion.div
            initial={animationsEnabled ? { scale: 0.9, opacity: 0 } : false}
            animate={{ scale: 1, opacity: 1 }}
            exit={animationsEnabled ? { scale: 0.9, opacity: 0 } : undefined}
            transition={{ type: 'spring', stiffness: 320, damping: 24 }}
            className="flex flex-col items-center gap-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl px-8 py-6 shadow-2xl max-w-sm mx-4 text-center"
          >
            <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
            <div className="font-semibold text-lg">{title}</div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{detail}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
