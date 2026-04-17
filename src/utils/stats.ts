import type { Player } from '../store/usePokerStore';

// Cards that contribute to numeric aggregates.
const NUMERIC_CARDS = ['0', '0.5', '1', '2', '3', '5', '8', '13', '21'] as const;
// All face values in canonical display order (for distribution charts).
const ALL_CARDS = [...NUMERIC_CARDS, '?', '☕'] as const;

export interface Stats {
  totalPlayers: number;
  voteCount: number;            // number of players who chose any card
  numericVoteCount: number;     // subset: players who chose a numeric card
  average: number | null;       // rounded to 1 decimal, null if no numeric votes
  min: number | null;
  max: number | null;
  consensus: string | null;     // non-null if every numeric vote is the same value
  distribution: Array<{ card: string; count: number }>;
}

export function computeStats(players: Record<string, Player>): Stats {
  const list = Object.values(players);
  const totalPlayers = list.length;
  const voted = list.filter((p) => p.card !== null);
  const voteCount = voted.length;

  const numericValues = voted
    .filter((p) => p.card !== '?' && p.card !== '☕')
    .map((p) => parseFloat(p.card as string))
    .filter((n) => Number.isFinite(n));

  const numericVoteCount = numericValues.length;

  const average =
    numericVoteCount > 0
      ? Math.round((numericValues.reduce((a, b) => a + b, 0) / numericVoteCount) * 10) / 10
      : null;
  const min = numericVoteCount > 0 ? Math.min(...numericValues) : null;
  const max = numericVoteCount > 0 ? Math.max(...numericValues) : null;

  // Consensus: at least two numeric votes, all equal.
  const consensus = numericVoteCount >= 2 && min === max ? formatNumber(min!) : null;

  const counts = new Map<string, number>();
  voted.forEach((p) => {
    const key = String(p.card);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });

  const distribution = ALL_CARDS
    .filter((c) => counts.has(c))
    .map((c) => ({ card: c, count: counts.get(c) ?? 0 }));

  return { totalPlayers, voteCount, numericVoteCount, average, min, max, consensus, distribution };
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toString();
}
