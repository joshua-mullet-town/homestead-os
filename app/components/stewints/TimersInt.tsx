'use client';

import type { StewIntProps } from './StewIntLoader';
import TimersPanel from '../TimersPanel';

/**
 * Timers StewInt — thin wrapper around TimersPanel.
 *
 * Appears auto-discovered when a steward's dir has `timers.json`. For Rooster
 * (id=rooster) we render the aggregated view (every steward's timers grouped
 * by owner) instead of just Rooster's own — more useful as the engine owner.
 */
export default function TimersInt({ stewardId, color }: StewIntProps) {
  const effectiveId = stewardId === 'rooster' ? '_all' : stewardId;
  return <TimersPanel stewardId={effectiveId} color={color} />;
}
