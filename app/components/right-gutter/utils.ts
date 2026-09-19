import type { SessionInfo, ClaudeSessionStatus } from '../../context/SessionContext';

// Generate a unique color based on session name
export function getSessionColor(name: string): string {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
    '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
    '#F8B500', '#00CED1', '#FF7F50', '#9FE2BF', '#DE3163',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash = hash & hash;
  }
  return colors[Math.abs(hash) % colors.length];
}

// Get status color
export function getStatusColor(status: ClaudeSessionStatus): string {
  switch (status) {
    case 'working': return '#FFCC00';
    case 'waiting': return '#00FF66';
    case 'terminated': return '#FF3333';
    case 'interrupted': return '#FF6633';
    default: return '#666666';
  }
}

// Format time since a date
export function formatTimeSince(date: Date | null): string {
  if (!date) return '—';
  const now = new Date();
  const elapsed = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (elapsed < 0) return '—';
  const seconds = elapsed % 60;
  const minutes = Math.floor(elapsed / 60) % 60;
  const hours = Math.floor(elapsed / 3600);
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  return `${seconds}s`;
}

/**
 * Build unique 2-char abbreviations for all sessions.
 * Multi-strategy: overrides → label prefix → label divergence → session name (ticket#) → index fallback.
 */
export function buildSessionAbbrevs(sessions: SessionInfo[], overrides: Record<string, string> = {}): Map<string, string> {
  const abbrevs = new Map<string, string>();

  const remaining: SessionInfo[] = [];
  for (const s of sessions) {
    if (overrides[s.name]) {
      abbrevs.set(s.name, overrides[s.name].slice(0, 2).toUpperCase());
    } else {
      remaining.push(s);
    }
  }

  for (const s of remaining) {
    const label = s.worktree || s.project;
    abbrevs.set(s.name, label.slice(0, 2).toUpperCase());
  }

  function getCollisionGroups(subset: SessionInfo[]) {
    const byAbbrev = new Map<string, SessionInfo[]>();
    for (const s of subset) {
      const ab = abbrevs.get(s.name)!;
      if (!byAbbrev.has(ab)) byAbbrev.set(ab, []);
      byAbbrev.get(ab)!.push(s);
    }
    return byAbbrev;
  }

  // Pass 2: Label divergence
  let collisions = getCollisionGroups(remaining);
  for (const [, group] of collisions) {
    if (group.length < 2) continue;
    const labels = group.map(s => s.worktree || s.project);
    let diffStart = 0;
    outer: for (let i = 0; i < Math.min(...labels.map(l => l.length)); i++) {
      const ch = labels[0][i];
      for (const l of labels) {
        if (l[i] !== ch) { diffStart = i; break outer; }
      }
      diffStart = i + 1;
    }
    const newAbbrevs = group.map(s => {
      const label = s.worktree || s.project;
      const unique = label.slice(diffStart, diffStart + 2);
      return unique.toUpperCase() || label.slice(-2).toUpperCase();
    });
    if (!newAbbrevs.every(a => a === newAbbrevs[0])) {
      group.forEach((s, i) => abbrevs.set(s.name, newAbbrevs[i]));
    }
  }

  // Pass 3: Session name divergence — ticket numbers
  collisions = getCollisionGroups(remaining);
  for (const [, group] of collisions) {
    if (group.length < 2) continue;
    const nums = group.map(s => {
      const match = s.name.match(/(\d+)[^0-9]*$/);
      return match ? match[1] : null;
    });
    const allHaveNums = nums.every(n => n !== null);
    if (allHaveNums) {
      const last2 = nums.map(n => n!.slice(-2).padStart(2, '0'));
      if (new Set(last2).size === group.length) {
        group.forEach((s, i) => abbrevs.set(s.name, last2[i]));
        continue;
      }
    }
    const names = group.map(s => s.name);
    let nameStart = 0;
    nameOuter: for (let i = 0; i < Math.min(...names.map(n => n.length)); i++) {
      const ch = names[0][i];
      for (const n of names) {
        if (n[i] !== ch) { nameStart = i; break nameOuter; }
      }
      nameStart = i + 1;
    }
    const nameAbbrevs = group.map(s => {
      const unique = s.name.slice(nameStart, nameStart + 2);
      return unique ? unique.toUpperCase() : null;
    });
    if (nameAbbrevs.every(a => a !== null) && new Set(nameAbbrevs).size === group.length) {
      group.forEach((s, i) => abbrevs.set(s.name, nameAbbrevs[i]!));
    }
  }

  // Pass 4: Numeric suffix fallback
  collisions = getCollisionGroups(remaining);
  for (const [, group] of collisions) {
    if (group.length < 2) continue;
    group.forEach((s, i) => {
      const label = s.worktree || s.project;
      abbrevs.set(s.name, `${label[0].toUpperCase()}${i + 1}`);
    });
  }

  return abbrevs;
}
