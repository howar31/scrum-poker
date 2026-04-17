import { usePokerStore, type CardValue } from '../store/usePokerStore';
import { peerManager } from '../utils/peerManager';
import Card from './Card';
import Toast from './Toast';
import { LogOut, Copy, Check, Crown } from 'lucide-react';
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const CARDS: CardValue[] = ['0', '0.5', '1', '2', '3', '5', '8', '13', '21', '?', '☕'];

export default function Room() {
  const { roomId, hostId, playerId, players, isRevealed, isConnected, error, animationsEnabled } = usePokerStore();
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
    if (myPlayer?.card === card) {
      peerManager.sendAction({ type: 'SELECT_CARD', payload: { id: playerId, card: null } });
    } else {
      peerManager.sendAction({ type: 'SELECT_CARD', payload: { id: playerId, card } });
    }
  };

  const revealCards = () => peerManager.sendAction({ type: 'REVEAL' });
  const resetCards = () => peerManager.sendAction({ type: 'RESET' });
  const kickPlayer = (id: string) => peerManager.sendAction({ type: 'KICK', payload: { id } });
  const makeHost = (id: string) => peerManager.sendAction({ type: 'TRANSFER_HOST', payload: { id } });

  return (
    <div className="flex flex-col h-full gap-8">
      <Toast />

      {/* Top Bar */}
      <div className="flex flex-col md:flex-row justify-between items-center bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        <div className="flex items-center gap-4">
          <div className="flex flex-col">
            <span className="text-sm text-gray-500 dark:text-gray-400">Room ID</span>
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold text-lg tracking-wider">{roomId}</span>
              <button onClick={handleCopy} className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition text-gray-500">
                {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div className="h-10 w-px bg-gray-200 dark:bg-gray-700 mx-2 hidden md:block"></div>
          <div className="flex flex-col">
            <span className="text-sm text-gray-500 dark:text-gray-400">Status</span>
            <span className={cn('font-medium', isConnected ? 'text-green-500' : 'text-red-500')}>
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>

        <button
          onClick={handleLeave}
          className="mt-4 md:mt-0 flex items-center gap-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 px-4 py-2 rounded-lg transition font-medium"
        >
          <LogOut className="w-4 h-4" />
          Leave Room
        </button>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative">
          <strong className="font-bold">Error: </strong>
          <span className="block sm:inline">{error}</span>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col gap-8 lg:flex-row">
        {/* Card Selection */}
        <div className="flex-1 flex flex-col gap-4">
          <h2 className="text-xl font-bold">Choose your card</h2>
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-4 lg:gap-6 justify-items-center bg-white dark:bg-gray-800 p-6 md:p-8 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700">
            {CARDS.map((card) => {
              const selected = myPlayer?.card === card;
              const CardButton = (
                <button
                  onClick={() => selectCard(card)}
                  disabled={isRevealed}
                  className={cn(
                    'relative w-full aspect-[2.5/3.5] max-w-[100px] rounded-xl border-2 transition-all duration-200 transform focus:outline-none',
                    selected
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 shadow-lg ring-4 ring-blue-400/40 dark:ring-blue-400/30'
                      : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-blue-300 dark:hover:border-blue-600 hover:-translate-y-2 hover:shadow-lg',
                    isRevealed && 'opacity-50 cursor-not-allowed hover:-translate-y-0'
                  )}
                >
                  <span className="absolute inset-0 flex items-center justify-center text-2xl md:text-3xl font-bold">
                    {card}
                  </span>
                </button>
              );

              if (!animationsEnabled) {
                return <div key={card} className="w-full">{CardButton}</div>;
              }

              return (
                <motion.div
                  key={card}
                  whileTap={{ scale: 0.9 }}
                  animate={selected ? { scale: [1, 1.15, 1.05], y: [0, -4, -8] } : { scale: 1, y: 0 }}
                  transition={{ duration: 0.35, ease: [0.34, 1.56, 0.64, 1] }}
                  className="w-full"
                >
                  {CardButton}
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* Players List & Host Actions */}
        <div className="w-full lg:w-96 flex flex-col gap-4">
          <div className="flex justify-between items-end">
            <h2 className="text-xl font-bold">Players ({allPlayers.length})</h2>
            {amIHost && (
              <div className="flex gap-2">
                <button
                  onClick={resetCards}
                  disabled={!isRevealed && !allPlayers.some((p) => p.card)}
                  className="px-3 py-1.5 text-sm font-medium bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-md transition disabled:opacity-50"
                >
                  Reset
                </button>
                <button
                  onClick={revealCards}
                  disabled={isRevealed || allPlayers.every((p) => !p.card)}
                  className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md transition disabled:opacity-50 disabled:bg-blue-400"
                >
                  Reveal
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden flex flex-col">
            <div className="flex-1 overflow-y-auto p-2">
              <motion.div
                className="flex flex-col gap-2"
                variants={{
                  visible: isRevealed ? { transition: { staggerChildren: 0.12 } } : {},
                }}
                initial={false}
                animate="visible"
              >
                <AnimatePresence initial={false}>
                  {allPlayers.map((player, index) => (
                    <motion.div
                      key={player.id}
                      layout={animationsEnabled}
                      initial={animationsEnabled ? { opacity: 0, x: -20, scale: 0.85 } : false}
                      animate={{ opacity: 1, x: 0, scale: 1 }}
                      exit={animationsEnabled ? { opacity: 0, x: 30, scale: 0.85, transition: { duration: 0.25 } } : undefined}
                      transition={{ type: 'spring', stiffness: 320, damping: 26, delay: animationsEnabled && isRevealed ? index * 0.1 : 0 }}
                      className="flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-750 group"
                    >
                      <div className="flex items-center gap-3">
                        <div className="relative">
                          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold uppercase">
                            {player.name.substring(0, 2)}
                          </div>
                          {player.id === hostId && (
                            <div className="absolute -top-1 -right-1 bg-yellow-400 text-yellow-900 rounded-full p-0.5 shadow-sm" title="Host">
                              <Crown className="w-3 h-3" />
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col">
                          <span className="font-medium flex items-center gap-2">
                            {player.name}
                            {player.id === playerId && <span className="text-xs bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded text-gray-600 dark:text-gray-300">You</span>}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        {amIHost && player.id !== playerId && (
                          <div className="opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                            <button onClick={() => makeHost(player.id)} className="text-xs text-blue-500 hover:underline px-1" title="Make Host">Host</button>
                            <button onClick={() => kickPlayer(player.id)} className="text-xs text-red-500 hover:underline px-1" title="Kick">Kick</button>
                          </div>
                        )}

                        <div className="w-12 flex justify-center">
                          <Card
                            card={player.card}
                            isRevealed={isRevealed}
                            isMe={player.id === playerId}
                            revealIndex={index}
                          />
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </motion.div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
