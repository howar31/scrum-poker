import { useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Crown } from 'lucide-react';
import { usePokerStore, type Player } from '../store/usePokerStore';
import Card from './Card';

interface TableProps {
  players: Player[];
  isRevealed: boolean;
  currentPlayerId: string;
  hostId: string | null;
}

// Deterministic per-player tilt + vertical offset, so every player's card
// leans and sits slightly differently yet identically across re-renders.
// Two-axis variation means even two players in the same tilt bucket still
// look visually distinct.
function tiltForPlayerId(id: string): { rotate: number; yOffset: number } {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const h = Math.abs(hash);
  // Rotate: ±10° in ~1° increments (21 buckets).
  const rotate = (h % 21) - 10;
  // Vertical offset: 0–10 px so some cards sit slightly higher/lower.
  const yOffset = (h >>> 5) % 11;
  return { rotate, yOffset };
}

function PlayerSeat({
  player,
  isRevealed,
  isMe,
  isHost,
  revealIndex,
}: {
  player: Player;
  isRevealed: boolean;
  isMe: boolean;
  isHost: boolean;
  revealIndex: number;
}) {
  const { t } = useTranslation();
  const { animationsEnabled } = usePokerStore();
  const tilt = useMemo(() => tiltForPlayerId(player.id), [player.id]);

  return (
    <motion.div
      layout={animationsEnabled}
      initial={animationsEnabled ? { opacity: 0, y: 30, scale: 0.8 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={animationsEnabled ? { opacity: 0, scale: 0.7, transition: { duration: 0.25 } } : undefined}
      transition={{ type: 'spring', stiffness: 280, damping: 24 }}
      className="flex flex-col items-center gap-2 relative"
    >
      <div
        className="relative"
        style={
          animationsEnabled
            ? { transform: `rotate(${tilt.rotate}deg) translateY(${tilt.yOffset}px)` }
            : undefined
        }
      >
        {/* isMe intentionally false: all played cards stay face-down on the
            table until the host reveals. Standard Planning Poker convention. */}
        <Card
          card={player.card}
          isRevealed={isRevealed}
          isMe={false}
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
            {t('table.you')}
          </span>
        )}
      </div>
    </motion.div>
  );
}

export default function Table({ players, isRevealed, currentPlayerId, hostId }: TableProps) {
  const { t } = useTranslation();
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
          {t('table.waitingPlayers')}
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
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
