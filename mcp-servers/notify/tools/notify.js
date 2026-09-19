/**
 * notify_user tool - Get the user's attention with a browser overlay
 */

import {
  waitForPageInList,
  waitForPageReady,
  injectOverlay,
  activateTab,
} from '../lib/cdp.js';

import {
  openUrl,
  bringChromeToFront,
  playSound,
  checkDevServer,
  getTmuxSessionId,
} from '../lib/macos.js';

export const notifyTool = {
  name: 'notify_user',
  description: 'Get the user\'s attention on a specific browser page with an overlay showing test instructions. Opens the URL in Chrome, waits for it to load, injects a floating overlay with the feature name and instructions, activates the tab, brings Chrome to front, and plays a sound alert. The overlay has "Works!" and issue reporting buttons that send feedback back to the calling Claude Code session.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to open/navigate to (e.g., http://localhost:3000/shop)',
      },
      feature: {
        type: 'string',
        description: 'Feature name shown in overlay header (e.g., "Add to Cart")',
      },
      instructions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of instruction steps to show in the overlay (each becomes a numbered line)',
      },
      session_id: {
        type: 'string',
        description: 'tmux session ID for sending feedback back. Auto-detected if omitted.',
      },
    },
    required: ['url', 'feature', 'instructions'],
  },

  async execute(args) {
    const { url, feature, instructions, session_id } = args;

    // Validate inputs
    if (!url || typeof url !== 'string') {
      return { success: false, error: 'url is required and must be a string' };
    }
    if (!feature || typeof feature !== 'string') {
      return { success: false, error: 'feature is required and must be a string' };
    }
    if (!Array.isArray(instructions) || instructions.length === 0) {
      return { success: false, error: 'instructions must be a non-empty array of strings' };
    }

    // Get session ID (auto-detect if not provided)
    const sessionId = session_id || getTmuxSessionId();

    // Add unique identifier to URL to find the exact tab we opened
    const testId = `claude-test-${Date.now()}`;
    const urlWithId = url.includes('?')
      ? `${url}&_test=${testId}`
      : `${url}?_test=${testId}`;

    try {
      // Check dev server is alive before opening browser
      const serverAlive = await checkDevServer(url);
      if (!serverAlive) {
        return {
          success: false,
          error: `Dev server is not running at ${new URL(url).origin}. Start it first.`,
        };
      }

      // Open the URL
      await openUrl(urlWithId);

      // Give Chrome a moment to start opening the URL
      await new Promise(r => setTimeout(r, 1000));

      // Wait for page to appear in CDP list
      const page = await waitForPageInList(testId);
      if (!page) {
        // Fallback: just bring Chrome to front and play sound
        await bringChromeToFront();
        await playSound();
        return {
          success: true,
          warning: 'Could not find page in Chrome DevTools list. Chrome was brought to front but overlay was not injected.',
        };
      }

      // Wait for page to load
      const ready = await waitForPageReady(page, url);
      if (!ready) {
        // Wait a bit more as fallback
        await new Promise(r => setTimeout(r, 2000));
      }

      // Inject the overlay
      await injectOverlay(page, feature, instructions, sessionId);

      // Activate the tab and bring Chrome to front
      await activateTab(page);
      await bringChromeToFront();
      await playSound();

      return {
        success: true,
        message: `Notified user to test "${feature}" at ${url}`,
        sessionId,
        pageId: page.id,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  },
};
