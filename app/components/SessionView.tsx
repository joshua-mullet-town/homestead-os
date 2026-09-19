'use client';

import { usePathname } from 'next/navigation';
import { useSession } from '../context/SessionContext';
import TerminalManager from './TerminalManager';
import ChatManager from './ChatManager';

/**
 * SessionView wraps both Terminal and Chat views,
 * showing the appropriate one based on terminalSettings.viewMode.
 * Both managers keep all instances alive per session for instant switching.
 */
export default function SessionView() {
  const pathname = usePathname();
  const { activeSession, activeTab, terminalSettings } = useSession();

  // Determine if we should show anything
  const isOnSessionPage = pathname?.startsWith('/session/');
  const showView = isOnSessionPage && (activeTab === 'terminal' || activeTab === null);

  if (!showView || !activeSession) {
    // Still render both managers but hidden, so connections persist
    return (
      <>
        <TerminalManager />
        <ChatManager />
      </>
    );
  }

  const { viewMode } = terminalSettings;

  return (
    <>
      {/* Terminal is always rendered but hidden when in chat mode, to preserve connections */}
      <div style={{ display: viewMode === 'terminal' ? 'block' : 'none' }}>
        <TerminalManager />
      </div>

      {/* Chat manager handles visibility internally based on viewMode and activeSession */}
      <ChatManager />
    </>
  );
}
