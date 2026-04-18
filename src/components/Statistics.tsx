import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Target } from 'lucide-react';
import { usePokerStore } from '../store/usePokerStore';
import { computeStats } from '../utils/stats';

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex-1 bg-gray-50 dark:bg-gray-900/60 border border-gray-200 dark:border-gray-700 rounded-lg p-3 text-center">
      <div className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-2xl font-bold mt-0.5 font-mono">{value}</div>
    </div>
  );
}

export default function Statistics() {
  const { t } = useTranslation();
  const { players, isRevealed, animationsEnabled } = usePokerStore();
  const stats = computeStats(players);

  // Pre-reveal: voting progress.
  if (!isRevealed) {
    const pct = stats.totalPlayers > 0 ? (stats.voteCount / stats.totalPlayers) * 100 : 0;
    return (
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-5 flex flex-col gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {t('stats.voting')}
        </h3>
        <div className="text-3xl font-bold">
          {stats.voteCount}
          <span className="text-gray-400 dark:text-gray-500 text-xl font-normal">
            {' '}/ {stats.totalPlayers}
          </span>
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {stats.voteCount === stats.totalPlayers && stats.totalPlayers > 0
            ? t('stats.everyoneVoted')
            : t('stats.waitingVotes')}
        </div>
        <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mt-1">
          <motion.div
            className="h-full bg-blue-500"
            initial={false}
            animate={{ width: `${pct}%` }}
            transition={{ type: 'spring', stiffness: 120, damping: 20 }}
          />
        </div>
      </div>
    );
  }

  // Post-reveal: full stats panel.
  const maxCount = Math.max(1, ...stats.distribution.map((d) => d.count));

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-5 flex flex-col gap-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {t('stats.results')}
      </h3>

      <AnimatePresence>
        {stats.consensus !== null && (
          <motion.div
            key="consensus"
            initial={animationsEnabled ? { scale: 0.6, opacity: 0 } : false}
            animate={{ scale: 1, opacity: 1 }}
            exit={animationsEnabled ? { scale: 0.6, opacity: 0 } : undefined}
            transition={{ type: 'spring', stiffness: 380, damping: 22 }}
            className="flex items-center gap-3 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-900/30 dark:to-emerald-900/30 border border-green-300 dark:border-green-700 rounded-lg p-3"
          >
            <Target className="w-6 h-6 text-green-600 dark:text-green-400 flex-shrink-0" />
            <div>
              <div className="text-xs uppercase tracking-wider text-green-700 dark:text-green-300">
                {t('stats.consensus')}
              </div>
              <div className="text-2xl font-bold text-green-700 dark:text-green-200 font-mono">
                {stats.consensus}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex gap-2">
        <MetricCard
          label={t('stats.average')}
          value={stats.average !== null ? String(stats.average) : '—'}
        />
        <MetricCard label={t('stats.min')} value={stats.min !== null ? String(stats.min) : '—'} />
        <MetricCard label={t('stats.max')} value={stats.max !== null ? String(stats.max) : '—'} />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {t('stats.distribution')}
        </div>
        {stats.distribution.length === 0 ? (
          <div className="text-sm text-gray-400">{t('stats.noVotes')}</div>
        ) : (
          stats.distribution.map((d, idx) => (
            <div key={d.card} className="flex items-center gap-2 text-sm">
              <span className="w-8 text-right font-mono font-semibold text-gray-700 dark:text-gray-300">
                {d.card}
              </span>
              <div className="flex-1 h-5 bg-gray-100 dark:bg-gray-900/60 rounded relative overflow-hidden">
                <motion.div
                  className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 rounded"
                  initial={animationsEnabled ? { width: 0 } : false}
                  animate={{ width: `${(d.count / maxCount) * 100}%` }}
                  transition={{
                    duration: 0.6,
                    delay: animationsEnabled ? idx * 0.08 : 0,
                    ease: [0.4, 0, 0.2, 1],
                  }}
                />
              </div>
              <span className="w-6 text-right text-xs text-gray-500 dark:text-gray-400">
                {d.count}
              </span>
            </div>
          ))
        )}
      </div>

      {stats.voteCount > stats.numericVoteCount && (
        <div className="text-xs text-gray-400 dark:text-gray-500">
          {t('stats.nonNumericExcluded', {
            count: stats.voteCount - stats.numericVoteCount,
          })}
        </div>
      )}
    </div>
  );
}
