/**
 * list_sessions tool — List all active Homestead sessions.
 *
 * Shows who's on the walkie-talkie channel. Returns project name,
 * branch, worktree status so you can pick the right target.
 */

import { getTmuxSessionId } from '../lib/macos.js';

const HOMESTEAD_URL = 'http://localhost:3005';

export const listSessionsTool = {
  name: 'list_sessions',
  description: 'List all active Homestead sessions. Returns session names, project names, branches, and whether they are worktrees. Use the session "name" field as the target for send_message. You can find the right target by matching on project name or branch.',
  inputSchema: {
    type: 'object',
    properties: {},
  },

  async execute() {
    const self = getTmuxSessionId() || 'unknown';

    try {
      const response = await fetch(`${HOMESTEAD_URL}/api/sessions`, {
        signal: AbortSignal.timeout(5000),
      });
      const sessions = await response.json();

      const list = (Array.isArray(sessions) ? sessions : sessions.sessions || []).map(s => ({
        name: s.name,
        project: s.project,
        branch: s.branch,
        isWorktree: s.isWorktree || false,
        isSelf: s.name === self,
      }));

      return {
        self,
        sessions: list,
        count: list.length,
      };
    } catch (error) {
      // Fallback to raw tmux listing
      const { listSessions } = await import('../lib/macos.js');
      const names = listSessions();
      return {
        self,
        sessions: names.map(name => ({
          name,
          project: name.replace(/^holler-/, '').replace(/--.*$/, ''),
          isSelf: name === self,
        })),
        count: names.length,
        note: 'Homestead API unavailable, showing basic info only',
      };
    }
  },
};
