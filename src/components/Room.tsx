import { useState } from 'react';
import { motion } from 'framer-motion';
import { LogOut, Copy, Check, RotateCcw, Eye, Home as HomeIcon } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { usePokerStore, type CardValue } from '../store/usePokerStore';
import { peerManager } from '../utils/peerManager';
import Table from './Table';
import Statistics from './Statistics';
import Toast from './Toast';

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
  const { roomId, hostId, playerId, players, isRevealed, isConnected, error } = usePokerStore();
  const [copied, setCopied] = useState(false);

  const amIHost = hostId === playerId;
  const myPlayer = players[playerId];
  const allPlayers = Object.values(players).sort((a, b) => a.joinedAt - b.joinedAt);

  const handleCopy = () => {
    if (roomId) {
      navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleLeave = () => {
    peerManager.leave();
    usePokerStore.getState().leaveRoom();
  };

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
      <Toast />

      {/* Top Bar */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 gap-3">
        <div className="flex items-center gap-4 flex-wrap">
          <button
            onClick={handleLeave}
            className="p-2 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition"
            title="Back to home"
          >
            <HomeIcon className="w-4 h-4" />
          </button>

          <div className="flex flex-col">
            <span className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Room ID
            </span>
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold text-lg tracking-wider">{roomId}</span>
              <button
                onClick={handleCopy}
                className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition text-gray-500"
                title="Copy invite link"
              >
                {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="h-10 w-px bg-gray-200 dark:bg-gray-700 hidden md:block" />

          <div className="flex flex-col">
            <span className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Status
            </span>
            <span className={cn('font-medium', isConnected ? 'text-green-500' : 'text-red-500')}>
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>

        <button
          onClick={handleLeave}
          className="flex items-center gap-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 px-4 py-2 rounded-lg transition font-medium"
        >
          <LogOut className="w-4 h-4" />
          Leave Room
        </button>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          <strong className="font-bold">Error: </strong>
          <span>{error}</span>
        </div>
      )}

      {/* Main: Table on left, Statistics on right (lg) */}
      <div className="flex flex-col lg:flex-row gap-6 flex-1 min-h-0">
        <div className="flex-1 flex flex-col gap-4 min-w-0">
          <Table
            players={allPlayers}
            isRevealed={isRevealed}
            currentPlayerId={playerId}
            hostId={hostId}
            amIHost={amIHost}
            onMakeHost={makeHost}
            onKick={kickPlayer}
          />

          {amIHost && (
            <div className="flex justify-center gap-3">
              <button
                onClick={resetCards}
                disabled={!isRevealed && !anyCardPlayed}
                className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RotateCcw className="w-4 h-4" />
                Reset
              </button>
              <button
                onClick={revealCards}
                disabled={isRevealed || !anyCardPlayed}
                className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition disabled:opacity-50 disabled:bg-blue-400 disabled:cursor-not-allowed shadow-md"
              >
                <Eye className="w-4 h-4" />
                Reveal
              </button>
            </div>
          )}
        </div>

        <div className="lg:w-80 flex-shrink-0">
          <Statistics />
        </div>
      </div>

      {/* Bottom: Hand rail */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-4 md:p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Your hand
          </h2>
          {isRevealed && (
            <span className="text-xs text-gray-400">Waiting for host to reset...</span>
          )}
        </div>
        <div className="flex gap-2 md:gap-3 overflow-x-auto pb-2">
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
