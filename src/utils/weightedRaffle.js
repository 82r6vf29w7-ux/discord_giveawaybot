
/**
 * After Dark Entertainment
 * Weighted raffle drawing
 *
 * Uses ticketWeight saved when a member joins.
 * Each member can win only once per drawing.
 */

import { randomInt } from 'node:crypto';

export function drawWeightedEntries(entries, winnersCount, exclude = []) {
  const excluded = new Set(exclude);

  const pool = entries
    .filter((entry) => !excluded.has(entry.userId))
    .map((entry) => ({
      userId: entry.userId,
      weight: Math.max(
        1,
        Math.min(7, Number(entry.ticketWeight) || 1)
      ),
    }));

  const winners = [];
  const limit = Math.min(
    Math.max(0, Math.floor(Number(winnersCount) || 0)),
    pool.length
  );

  while (pool.length > 0 && winners.length < limit) {
    const totalWeight = pool.reduce(
      (sum, entry) => sum + entry.weight,
      0
    );

    let ticket = randomInt(totalWeight);
    let selectedIndex = 0;

    for (let i = 0; i < pool.length; i++) {
      ticket -= pool[i].weight;

      if (ticket < 0) {
        selectedIndex = i;
        break;
      }
    }

    const [winner] = pool.splice(selectedIndex, 1);
    winners.push(winner.userId);
  }

  return winners;
}
