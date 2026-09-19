'use client';

import { usePathname } from 'next/navigation';
import { useSession } from '../context/SessionContext';
import ChatView from './ChatView';
import { useIsDesktop } from '../hooks/useMediaQuery';

/**
 * ChatManager keeps all chat view instances alive (one per session)
 * and toggles visibility based on the active session.
 * This preserves scroll position and state when switching between sessions.
 */
export default function ChatManager() {
  const pathname = usePathname();
  const isDesktop = useIsDesktop();
  const { sessions, activeSession, activeTab, terminalSettings } = useSession();

  // Determine if we should show the chat overlay at all
  const isOnSessionPage = pathname?.startsWith('/session/');
  const showView = isOnSessionPage && (isDesktop || activeTab === 'terminal' || activeTab === null);
  const isInChatMode = terminalSettings.viewMode === 'chat';

  // Top offset: header + tab bar (mobile) or just header (desktop)
  const topOffset = isDesktop ? '46px' : '82px';

  // On desktop, chat only takes up the left portion based on split ratio
  const splitRatio = terminalSettings.desktopSplitRatio ?? 60;
  const rightOffset = isDesktop ? `calc(${100 - splitRatio}% + 4px)` : '0px';

  // Get all registered sessions
  const allSessions = Array.from(sessions.keys());

  return (
    <>
      {allSessions.map((sessionName) => {
        const isActive = sessionName === activeSession && showView && isInChatMode;

        return (
          <div
            key={sessionName}
            className="fixed bg-[#0a0a0a]"
            style={{
              display: isActive ? 'block' : 'none',
              top: topOffset,
              left: 0,
              right: rightOffset,
              bottom: '0px',
              zIndex: 10,
            }}
          >
            <ChatView sessionName={sessionName} isActive={isActive} />
          </div>
        );
      })}
    </>
  );
}
