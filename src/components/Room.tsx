import { useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { RotateCcw, Eye, Users } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { usePokerStore, type CardValue } from '../store/usePokerStore';
import { peerManager } from '../utils/peerManager';
import Table from './Table';
import Statistics from './Statistics';
import PlayersPanel from './PlayersPanel';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const HAND: CardValue[] = ['0', '0.5', '1', '2', '3', '5', '8', '13', '21', '?', '☕'];

function HandCard({
  card,
  selected,
  disabled,
  onClick,
}: {
  card: CardValue;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const { animationsEnabled } = usePokerStore();

  const Button = (
    <button
      onClick={onClick}
      disabled={disabled}
      data-slot="hand-card"
      data-card-value={card}
      className={cn(
        'relative w-16 h-24 md:w-20 md:h-28 rounded-xl border-2 font-bold text-2xl md:text-3xl transition-colors focus:outline-none flex items-center justify-center flex-shrink-0',
        selected
          ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 shadow-lg ring-4 ring-blue-400/40'
          : 'border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:border-blue-400 dark:hover:border-blue-500',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      {card}
    </button>
  );

  if (!animationsEnabled) {
    return Button;
  }

  return (
    <motion.div
      whileHover={!disabled ? { y: -12, rotate: 0 } : undefined}
      whileTap={!disabled ? { scale: 0.92 } : undefined}
      animate={selected ? { y: -16 } : { y: 0 }}
      transition={{ type: 'spring', stiffness: 320, damping: 22 }}
    >
      {Button}
    </motion.div>
  );
}

export default function Room() {
  const { t } = useTranslation();
  const { hostId, playerId, players, isRevealed } = usePokerStore();
  const [playersOpen, setPlayersOpen] = useState(false);

  const amIHost = hostId === playerId;
  const myPlayer = players[playerId];
  const allPlayers = Object.values(players).sort((a, b) => a.joinedAt - b.joinedAt);

  const selectCard = (card: CardValue) => {
    if (isRevealed) return;
    const next = myPlayer?.card === card ? null : card;
    peerManager.sendAction({ type: 'SELECT_CARD', payload: { id: playerId, card: next } });
  };

  const revealCards = () => peerManager.sendAction({ type: 'REVEAL' });
  const resetCards = () => peerManager.sendAction({ type: 'RESET' });
  const kickPlayer = (id: string) => peerManager.sendAction({ type: 'KICK', payload: { id } });
  const makeHost = (id: string) => peerManager.sendAction({ type: 'TRANSFER_HOST', payload: { id } });

  const anyCardPlayed = allPlayers.some((p) => p.card !== null);

  return (
    <div className="flex flex-col h-full gap-6">
      {/* Main: Table on left, Statistics on right (lg) */}
      <div className="flex flex-col lg:flex-row gap-6 flex-1 min-h-0">
        <div className="flex-1 flex flex-col gap-4 min-w-0">
          <div className="flex items-center justify-start">
            <button
              data-slot="players-pill"
              onClick={() => setPlayersOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-sm font-medium transition"
              aria-label={t('players.openPanel')}
              title={t('players.openPanel')}
            >
              <Users className="w-4 h-4" />
              <span>{t('players.title')}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {allPlayers.length}
              </span>
            </button>
          </div>

          <Table
            players={allPlayers}
            isRevealed={isRevealed}
            currentPlayerId={playerId}
            hostId={hostId}
          />

          {amIHost && (
            <div className="flex justify-center gap-3">
              <button
                data-slot="host-reset"
                onClick={resetCards}
                disabled={!isRevealed && !anyCardPlayed}
                className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RotateCcw className="w-4 h-4" />
                {t('room.reset')}
              </button>
              <button
                data-slot="host-reveal"
                onClick={revealCards}
                disabled={isRevealed || !anyCardPlayed}
                className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition disabled:opacity-50 disabled:bg-blue-400 disabled:cursor-not-allowed shadow-md"
              >
                <Eye className="w-4 h-4" />
                {t('room.reveal')}
              </button>
            </div>
          )}
        </div>

        <div className="lg:w-80 flex-shrink-0">
          <Statistics />
        </div>
      </div>

      <PlayersPanel
        open={playersOpen}
        onClose={() => setPlayersOpen(false)}
        players={allPlayers}
        hostId={hostId}
        currentPlayerId={playerId}
        amIHost={amIHost}
        isRevealed={isRevealed}
        onMakeHost={makeHost}
        onKick={kickPlayer}
      />

      {/* Bottom: Hand rail */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-4 md:p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t('room.yourHand')}
          </h2>
          {isRevealed && (
            <span className="text-xs text-gray-400">{t('room.waitingReset')}</span>
          )}
        </div>
        {/* pt-8 reserves vertical room for the hover/selected lift so the
            lifted card isn't clipped by overflow-x-auto. */}
        <div className="flex gap-2 md:gap-3 overflow-x-auto pt-8 pb-3 -mt-4">
          {HAND.map((card) => (
            <HandCard
              key={card}
              card={card}
              selected={myPlayer?.card === card}
              disabled={isRevealed}
              onClick={() => selectCard(card)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
