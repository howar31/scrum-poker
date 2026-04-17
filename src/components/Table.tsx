import { useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Crown, UserMinus } from 'lucide-react';
import { usePokerStore, type Player } from '../store/usePokerStore';
import Card from './Card';

interface TableProps {
  players: Player[];
  isRevealed: boolean;
  currentPlayerId: string;
  hostId: string | null;
  amIHost: boolean;
  onMakeHost: (id: string) => void;
  onKick: (id: string) => void;
}

// Deterministic tilt per player so the same person's card keeps the same
// angle across re-renders. Hash playerId into a small range ±6°.
function tiltForPlayerId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const range = 13; // -6 ... +6
  return (Math.abs(hash) % range) - 6;
}

function PlayerSeat({
  player,
  isRevealed,
  isMe,
  isHost,
  revealIndex,
  canModerate,
  onMakeHost,
  onKick,
}: {
  player: Player;
  isRevealed: boolean;
  isMe: boolean;
  isHost: boolean;
  revealIndex: number;
  canModerate: boolean;
  onMakeHost: () => void;
  onKick: () => void;
}) {
  const { animationsEnabled } = usePokerStore();
  const tilt = useMemo(() => tiltForPlayerId(player.id), [player.id]);

  return (
    <motion.div
      layout={animationsEnabled}
      initial={animationsEnabled ? { opacity: 0, y: 30, scale: 0.8 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={animationsEnabled ? { opacity: 0, scale: 0.7, transition: { duration: 0.25 } } : undefined}
      transition={{ type: 'spring', stiffness: 280, damping: 24 }}
      className="flex flex-col items-center gap-2 group relative"
    >
      <div
        className="relative"
        style={animationsEnabled ? { transform: `rotate(${tilt}deg)` } : undefined}
      >
        <Card
          card={player.card}
          isRevealed={isRevealed}
          isMe={isMe}
          revealIndex={revealIndex}
          size="lg"
        />
      </div>

      <div className="flex items-center gap-1.5 text-sm">
        {isHost && <Crown className="w-3.5 h-3.5 text-yellow-500" />}
        <span className="font-medium truncate max-w-[8rem]" title={player.name}>
          {player.name}
        </span>
        {isMe && (
          <span className="text-[10px] bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded text-gray-600 dark:text-gray-300 uppercase tracking-wider">
            You
          </span>
        )}
      </div>

      {canModerate && !isMe && (
        <div className="opacity-0 group-hover:opacity-100 transition-opacity absolute -top-2 right-0 flex gap-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-sm p-0.5">
          <button
            onClick={onMakeHost}
            title="Make Host"
            className="p-1 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded"
          >
            <Crown className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onKick}
            title="Kick"
            className="p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded"
          >
            <UserMinus className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </motion.div>
  );
}

export default function Table({
  players,
  isRevealed,
  currentPlayerId,
  hostId,
  amIHost,
  onMakeHost,
  onKick,
}: TableProps) {
  return (
    <div className="relative bg-gradient-to-br from-emerald-800/90 via-emerald-900 to-green-950 dark:from-emerald-900 dark:via-emerald-950 dark:to-black rounded-3xl shadow-inner border-2 border-emerald-950/40 px-6 py-10 md:py-14 min-h-[20rem] overflow-hidden">
      {/* Subtle felt texture */}
      <div
        className="absolute inset-0 opacity-30 pointer-events-none"
        style={{
          backgroundImage:
            'radial-gradient(circle at 50% 50%, rgba(255,255,255,0.08) 0%, transparent 70%)',
        }}
      />

      {players.length === 0 ? (
        <div className="relative text-center text-emerald-100/70 py-12">
          Waiting for players to join...
        </div>
      ) : (
        <div className="relative flex flex-wrap items-end justify-center gap-x-6 gap-y-10">
          <AnimatePresence initial={false}>
            {players.map((player, index) => (
              <PlayerSeat
                key={player.id}
                player={player}
                isRevealed={isRevealed}
                isMe={player.id === currentPlayerId}
                isHost={player.id === hostId}
                revealIndex={index}
                canModerate={amIHost}
                onMakeHost={() => onMakeHost(player.id)}
                onKick={() => onKick(player.id)}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
