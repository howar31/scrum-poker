import { motion, useMotionTemplate, useMotionValue, useSpring, useTransform } from 'framer-motion';
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
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_CLASS: Record<NonNullable<CardProps['size']>, string> = {
  sm: 'w-8 h-12 text-sm',
  md: 'w-16 h-24 text-xl',
  lg: 'w-24 h-36 text-3xl',
};

function CoffeeSmoke() {
  // 5 particles spaced across the card bottom, each staggered so smoke
  // appears continuous rather than a single pulse.
  return (
    <div className="absolute inset-0 pointer-events-none">
      {[0, 1, 2, 3, 4].map((i) => (
        <motion.div
          key={i}
          className="absolute rounded-full bg-white/50 dark:bg-gray-300/40 blur-md"
          style={{
            left: `${15 + i * 17}%`,
            bottom: 0,
            width: 6 + (i % 2) * 2,
            height: 6 + (i % 2) * 2,
          }}
          animate={{
            y: [0, -24, -48],
            x: [0, (i % 2 === 0 ? -4 : 4), (i % 2 === 0 ? -8 : 8)],
            opacity: [0, 0.55, 0],
            scale: [0.5, 1.3, 2.2],
          }}
          transition={{
            duration: 2.4,
            repeat: Infinity,
            delay: i * 0.45,
            ease: 'easeOut',
          }}
        />
      ))}
    </div>
  );
}

export default function Card({ card, isRevealed, isMe, revealIndex = 0, size = 'sm' }: CardProps) {
  const { animationsEnabled } = usePokerStore();

  // Pointer-driven tilt. Normalized to [-0.5, 0.5] across the card area.
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const rotateY = useSpring(useTransform(pointerX, [-0.5, 0.5], [-14, 14]), {
    stiffness: 220,
    damping: 18,
  });
  const rotateX = useSpring(useTransform(pointerY, [-0.5, 0.5], [14, -14]), {
    stiffness: 220,
    damping: 18,
  });
  // Holographic foil angle follows pointerX so the sheen slides across the
  // card back as the mouse moves horizontally.
  const foilAngle = useTransform(pointerX, [-0.5, 0.5], [40, 140]);
  const foilBackground = useMotionTemplate`linear-gradient(${foilAngle}deg, transparent 15%, rgba(255,0,200,0.35) 32%, rgba(0,220,255,0.35) 50%, rgba(255,255,100,0.35) 68%, transparent 85%)`;

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!animationsEnabled) return;
    const rect = e.currentTarget.getBoundingClientRect();
    pointerX.set((e.clientX - rect.left) / rect.width - 0.5);
    pointerY.set((e.clientY - rect.top) / rect.height - 0.5);
  };

  const handleMouseLeave = () => {
    pointerX.set(0);
    pointerY.set(0);
  };

  // Empty placeholder (no card chosen yet)
  if (!card) {
    return (
      <div
        className={cn(
          'rounded bg-gray-100 dark:bg-gray-700/50 border border-dashed border-gray-300 dark:border-gray-600 flex items-center justify-center',
          SIZE_CLASS[size]
        )}
      >
        <span className="text-gray-400 dark:text-gray-500 text-xs">...</span>
      </div>
    );
  }

  const isFlipped = isRevealed || isMe;

  // Non-animated fallback. Keeps the same DOM shape so animations toggle
  // cleanly without losing state.
  if (!animationsEnabled) {
    return (
      <div className={SIZE_CLASS[size]}>
        <div
          className={cn(
            'w-full h-full rounded shadow-sm border flex items-center justify-center font-bold relative overflow-hidden',
            isFlipped
              ? 'bg-white dark:bg-gray-800 border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400'
              : 'bg-gradient-to-br from-blue-500 to-indigo-600 border-transparent text-transparent'
          )}
        >
          {isFlipped ? <span>{card}</span> : null}
        </div>
      </div>
    );
  }

  // Staggered reveal: each card in a list flips with a small delay so the
  // table doesn't flip all at once — more dramatic, easier to parse.
  const revealDelay = isRevealed ? revealIndex * 0.12 : 0;

  return (
    <div
      className={SIZE_CLASS[size]}
      style={{ perspective: 1000 }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* Outer wrapper: tilt (rotateX/rotateY from pointer) */}
      <motion.div
        className="w-full h-full relative"
        style={{ rotateX, rotateY, transformStyle: 'preserve-3d' }}
      >
        {/* Inner wrapper: the flip animation itself (pick-up → flip → put-down) */}
        <motion.div
          className="w-full h-full relative preserve-3d"
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{
            scale: 1,
            opacity: 1,
            y: [0, -24, -24, 0],
            rotateY: isFlipped ? [180, 180, 0, 0] : [0, 0, 180, 180],
            boxShadow: [
              '0 2px 6px rgba(0,0,0,0.2)',
              '0 22px 40px rgba(0,0,0,0.45)',
              '0 22px 40px rgba(0,0,0,0.45)',
              '0 2px 6px rgba(0,0,0,0.2)',
            ],
          }}
          transition={{
            scale: { type: 'spring', stiffness: 260, damping: 20 },
            opacity: { duration: 0.2 },
            y: { duration: 0.9, delay: revealDelay, times: [0, 0.25, 0.75, 1], ease: [0.4, 0, 0.2, 1] },
            rotateY: { duration: 0.9, delay: revealDelay, times: [0, 0.25, 0.75, 1], ease: [0.4, 0, 0.2, 1] },
            boxShadow: { duration: 0.9, delay: revealDelay, times: [0, 0.25, 0.75, 1] },
          }}
        >
          {/* Front face */}
          <motion.div
            className={cn('absolute inset-0 backface-hidden rounded', !isFlipped && 'hidden')}
            animate={
              isRevealed
                ? {
                    boxShadow: [
                      '0 0 0 0 rgba(34,197,94,0)',
                      '0 0 0 4px rgba(34,197,94,0.55)',
                      '0 0 0 0 rgba(34,197,94,0)',
                    ],
                  }
                : undefined
            }
            transition={{ duration: 1.2, delay: revealDelay + 0.5, times: [0, 0.4, 1] }}
          >
            <div
              className={cn(
                'w-full h-full rounded shadow-sm border flex items-center justify-center font-bold relative overflow-hidden',
                'bg-white dark:bg-gray-800 border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400'
              )}
            >
              <span>{card}</span>
              {card === '☕' && <CoffeeSmoke />}
            </div>
          </motion.div>

          {/* Back face with holographic foil */}
          <div
            className={cn(
              'absolute inset-0 backface-hidden [transform:rotateY(180deg)] rounded',
              isFlipped && 'hidden'
            )}
          >
            <div className="relative w-full h-full rounded shadow-sm border border-transparent bg-gradient-to-br from-blue-500 to-indigo-600 overflow-hidden">
              {/* Static holographic base — slow conic rainbow under the overlay */}
              <div
                className="absolute inset-0 opacity-40"
                style={{
                  background:
                    'conic-gradient(from 0deg at 50% 50%, #ff4fd8, #4fbbff, #ffe14f, #4fffaa, #ff4fd8)',
                  filter: 'blur(24px)',
                }}
              />
              {/* Dynamic sheen — angle follows pointer */}
              <motion.div
                className="absolute inset-0 mix-blend-overlay"
                style={{ backgroundImage: foilBackground }}
              />
              {/* Original soft radial highlight */}
              <div className="absolute inset-0 opacity-20 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-white to-transparent mix-blend-overlay" />
            </div>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
