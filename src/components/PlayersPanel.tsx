import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Crown, UserMinus, X, CheckCircle2, Circle } from 'lucide-react';
import { clsx } from 'clsx';
import { usePokerStore, type Player } from '../store/usePokerStore';

interface PlayersPanelProps {
  open: boolean;
  onClose: () => void;
  players: Player[];
  hostId: string | null;
  currentPlayerId: string;
  amIHost: boolean;
  isRevealed: boolean;
  onMakeHost: (id: string) => void;
  onKick: (id: string) => void;
}

type PendingAction =
  | { action: 'transfer' | 'kick'; playerId: string }
  | null;

const CONFIRM_TIMEOUT_MS = 3000;

export default function PlayersPanel({
  open,
  onClose,
  players,
  hostId,
  currentPlayerId,
  amIHost,
  isRevealed,
  onMakeHost,
  onKick,
}: PlayersPanelProps) {
  const { t } = useTranslation();
  const animationsEnabled = usePokerStore((s) => s.animationsEnabled);
  const [pending, setPending] = useState<PendingAction>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pending state resets naturally when the panel closes: AnimatePresence
  // unmounts the dialog after its exit animation, so useState starts fresh
  // on next open. No explicit cleanup effect needed.

  // Escape key closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const armPending = (next: PendingAction) => {
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setPending(next);
    if (next) {
      confirmTimerRef.current = setTimeout(() => setPending(null), CONFIRM_TIMEOUT_MS);
    }
  };

  const handleAction = (
    action: 'transfer' | 'kick',
    playerId: string,
    execute: () => void
  ) => {
    const armed = pending && pending.action === action && pending.playerId === playerId;
    if (armed) {
      armPending(null);
      execute();
      return;
    }
    armPending({ action, playerId });
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={animationsEnabled ? { opacity: 0 } : false}
            animate={{ opacity: 1 }}
            exit={animationsEnabled ? { opacity: 0 } : undefined}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/40 z-40"
            aria-hidden="true"
          />

          {/* Drawer */}
          <motion.aside
            key="drawer"
            initial={
              animationsEnabled
                ? { x: '100%', y: 0, opacity: 0 }
                : false
            }
            animate={{ x: 0, y: 0, opacity: 1 }}
            exit={
              animationsEnabled
                ? { x: '100%', y: 0, opacity: 0, transition: { duration: 0.2 } }
                : undefined
            }
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            className={clsx(
              // Mobile: bottom sheet. Desktop (md+): right-side drawer.
              'fixed z-50 bg-white dark:bg-gray-900 shadow-2xl flex flex-col',
              'inset-x-0 bottom-0 max-h-[75vh] rounded-t-2xl',
              'md:inset-y-0 md:right-0 md:left-auto md:top-0 md:w-96 md:max-h-none md:rounded-none md:rounded-l-2xl'
            )}
            role="dialog"
            aria-modal="true"
            aria-label={t('players.title')}
          >
            <header className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-800">
              <h2 className="text-lg font-semibold">
                {t('players.title')}{' '}
                <span className="text-sm text-gray-400 dark:text-gray-500 font-normal">
                  {t('players.countLabel', { count: players.length })}
                </span>
              </h2>
              <button
                onClick={onClose}
                className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition text-gray-500"
                aria-label={t('players.close')}
                title={t('players.close')}
              >
                <X className="w-5 h-5" />
              </button>
            </header>

            <ul className="flex-1 overflow-y-auto py-2">
              {players.map((player) => {
                const isMe = player.id === currentPlayerId;
                const isHost = player.id === hostId;
                const hasVoted = player.card !== null;
                const transferPending =
                  pending?.action === 'transfer' && pending.playerId === player.id;
                const kickPending =
                  pending?.action === 'kick' && pending.playerId === player.id;

                return (
                  <li
                    key={player.id}
                    className="px-5 py-3 flex items-center gap-3 border-b border-gray-100 dark:border-gray-800 last:border-b-0"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {isHost && (
                        <Crown
                          className="w-4 h-4 text-yellow-500 flex-shrink-0"
                          aria-label={t('players.host')}
                        />
                      )}
                      <span className="font-medium truncate" title={player.name}>
                        {player.name}
                      </span>
                      {isMe && (
                        <span className="text-[10px] bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded text-gray-600 dark:text-gray-300 uppercase tracking-wider flex-shrink-0">
                          {t('table.you')}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      {/* Vote status / revealed value */}
                      {isRevealed && hasVoted ? (
                        <span className="font-mono font-bold text-sm bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded">
                          {player.card}
                        </span>
                      ) : hasVoted ? (
                        <span
                          className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400"
                          title={t('players.voted')}
                        >
                          <CheckCircle2 className="w-4 h-4" />
                        </span>
                      ) : (
                        <span
                          className="flex items-center gap-1 text-xs text-gray-400"
                          title={t('players.notVoted')}
                        >
                          <Circle className="w-4 h-4" />
                        </span>
                      )}

                      {/* Host-only actions */}
                      {amIHost && !isMe && (
                        <>
                          <button
                            onClick={() =>
                              handleAction('transfer', player.id, () => onMakeHost(player.id))
                            }
                            className={clsx(
                              'p-1.5 rounded-md transition text-xs font-medium flex items-center gap-1',
                              transferPending
                                ? 'bg-blue-500 text-white hover:bg-blue-600'
                                : 'text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/40'
                            )}
                            title={
                              transferPending
                                ? t('players.confirmHint')
                                : t('players.transferHost')
                            }
                          >
                            <Crown className="w-3.5 h-3.5" />
                            {transferPending && (
                              <span className="hidden sm:inline">{t('players.confirmHint')}</span>
                            )}
                          </button>
                          <button
                            onClick={() =>
                              handleAction('kick', player.id, () => onKick(player.id))
                            }
                            className={clsx(
                              'p-1.5 rounded-md transition text-xs font-medium flex items-center gap-1',
                              kickPending
                                ? 'bg-red-500 text-white hover:bg-red-600'
                                : 'text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40'
                            )}
                            title={
                              kickPending ? t('players.confirmHint') : t('players.kick')
                            }
                          >
                            <UserMinus className="w-3.5 h-3.5" />
                            {kickPending && (
                              <span className="hidden sm:inline">{t('players.confirmHint')}</span>
                            )}
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
