import { motion } from 'framer-motion';
import { usePokerStore, type CardValue } from '../store/usePokerStore';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface CardProps {
  card: CardValue;
  isRevealed: boolean;
  isMe: boolean;
  revealIndex?: number;
}

export default function Card({ card, isRevealed, isMe, revealIndex = 0 }: CardProps) {
  const { animationsEnabled } = usePokerStore();

  if (!card) {
    return (
      <div className="w-8 h-12 rounded bg-gray-100 dark:bg-gray-700/50 border border-dashed border-gray-300 dark:border-gray-600 flex items-center justify-center">
        <span className="text-gray-400 dark:text-gray-500 text-xs">...</span>
      </div>
    );
  }

  const isFlipped = isRevealed || isMe;

  // Static fallback when animations are disabled.
  if (!animationsEnabled) {
    return (
      <div className="w-8 h-12">
        <div
          className={cn(
            'w-full h-full rounded shadow-sm border flex items-center justify-center font-bold relative overflow-hidden',
            isFlipped
              ? 'bg-white dark:bg-gray-800 border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400'
              : 'bg-gradient-to-br from-blue-500 to-indigo-600 border-transparent text-transparent'
          )}
        >
          {isFlipped ? <span className="text-sm">{card}</span> : null}
        </div>
      </div>
    );
  }

  // Staggered reveal: delay each card proportional to its list index so they
  // flip over one-by-one instead of simultaneously. Only applies when the host
  // triggers reveal (not when viewing your own card).
  const revealDelay = isRevealed && !isMe ? revealIndex * 0.12 : 0;

  return (
    <div className="w-8 h-12" style={{ perspective: 1000 }}>
      <motion.div
        className="w-full h-full relative preserve-3d"
        initial={{ rotateY: 0, scale: 0.8, opacity: 0, y: 20 }}
        animate={{
          rotateY: isFlipped ? 0 : 180,
          scale: 1,
          opacity: 1,
          y: 0,
        }}
        transition={{
          rotateY: {
            duration: 0.75,
            delay: revealDelay,
            ease: [0.4, 0.0, 0.2, 1],
          },
          scale: { type: 'spring', stiffness: 260, damping: 20, delay: revealDelay },
          opacity: { duration: 0.2, delay: revealDelay },
          y: { type: 'spring', stiffness: 260, damping: 20, delay: revealDelay },
        }}
      >
        {/* Front face (card value) */}
        <motion.div
          className={cn('absolute inset-0 backface-hidden', !isFlipped && 'hidden')}
          animate={
            isRevealed && !isMe
              ? {
                  boxShadow: [
                    '0 0 0 0 rgba(250, 204, 21, 0)',
                    '0 0 0 4px rgba(250, 204, 21, 0.6)',
                    '0 0 0 0 rgba(250, 204, 21, 0)',
                  ],
                }
              : {}
          }
          transition={{ duration: 1.2, delay: revealDelay + 0.4, times: [0, 0.4, 1] }}
          style={{ borderRadius: 4 }}
        >
          <div
            className={cn(
              'w-full h-full rounded shadow-sm border flex items-center justify-center font-bold relative overflow-hidden',
              'bg-white dark:bg-gray-800 border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400'
            )}
          >
            <span className="text-sm">{card}</span>
            {card === '☕' && (
              <motion.div
                className="absolute -top-2 left-1/2 -translate-x-1/2 w-4 h-4 bg-gray-300 dark:bg-gray-500 rounded-full blur-[4px]"
                animate={{
                  y: [-5, -15, -25],
                  opacity: [0, 0.6, 0],
                  scale: [0.5, 1.2, 1.5],
                }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
              />
            )}
          </div>
        </motion.div>

        {/* Back face (hidden card) */}
        <div className={cn('absolute inset-0 backface-hidden [transform:rotateY(180deg)]', isFlipped && 'hidden')}>
          <div className="w-full h-full rounded shadow-sm border border-transparent bg-gradient-to-br from-blue-500 to-indigo-600 relative overflow-hidden">
            <div className="absolute inset-0 opacity-20 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-white to-transparent mix-blend-overlay"></div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
