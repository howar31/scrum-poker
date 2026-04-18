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
  // Specular highlight position tracks the pointer so the glass reflection
  // "moves with your eyes".
  const specularX = useTransform(pointerX, [-0.5, 0.5], ['20%', '80%']);
  const specularY = useTransform(pointerY, [-0.5, 0.5], ['20%', '80%']);
  const specularBackground = useMotionTemplate`radial-gradient(circle at ${specularX} ${specularY}, rgba(255,255,255,0.55), rgba(255,255,255,0) 50%)`;

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

          {/* Back face: glass reflection (no rainbow foil) */}
          <div
            className={cn(
              'absolute inset-0 backface-hidden [transform:rotateY(180deg)] rounded-lg',
              isFlipped && 'hidden'
            )}
          >
            <div
              className="relative w-full h-full rounded-lg overflow-hidden"
              style={{
                background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #312e81 100%)',
                boxShadow:
                  'inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -1px 0 rgba(255,255,255,0.08), 0 0 0 1px rgba(255,255,255,0.2)',
              }}
            >
              {/* Pointer-tracked specular highlight */}
              <motion.div
                className="absolute inset-0 pointer-events-none"
                style={{
                  backgroundImage: specularBackground,
                  mixBlendMode: 'screen',
                }}
              />

              {/* Fixed top-left glass sheen (always-on reflection) */}
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background:
                    'linear-gradient(135deg, rgba(255,255,255,0.32) 0%, rgba(255,255,255,0.05) 40%, transparent 55%)',
                }}
              />

              {/* Bottom edge reflection for depth */}
              <div
                className="absolute inset-x-0 bottom-0 h-1/3 pointer-events-none"
                style={{
                  background: 'linear-gradient(to top, rgba(255,255,255,0.12), transparent)',
                }}
              />
            </div>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
