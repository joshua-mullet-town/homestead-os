'use client';

import { useState, useRef, useCallback, ReactNode, useEffect } from 'react';
import { useSession } from '../context/SessionContext';
import { GripVertical } from 'lucide-react';

interface DesktopSplitLayoutProps {
  leftPanel: ReactNode;  // Terminal (always visible)
  rightPanel: ReactNode; // Tabbed content (Docs/Preview/Git)
  minLeftPercent?: number;  // Minimum left panel percentage (default 30)
  maxLeftPercent?: number;  // Maximum left panel percentage (default 80)
}

export default function DesktopSplitLayout({
  leftPanel,
  rightPanel,
  minLeftPercent = 30,
  maxLeftPercent = 80,
}: DesktopSplitLayoutProps) {
  const { terminalSettings, setTerminalSettings } = useSession();
  const splitRatio = terminalSettings.desktopSplitRatio;

  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartX, setDragStartX] = useState(0);
  const [dragStartRatio, setDragStartRatio] = useState(splitRatio);

  // Update split ratio
  const updateSplitRatio = useCallback((newRatio: number) => {
    const clampedRatio = Math.max(minLeftPercent, Math.min(maxLeftPercent, newRatio));
    setTerminalSettings({ desktopSplitRatio: clampedRatio });
  }, [minLeftPercent, maxLeftPercent, setTerminalSettings]);

  // Handle mouse/touch drag start
  const handleDragStart = useCallback((clientX: number) => {
    setIsDragging(true);
    setDragStartX(clientX);
    setDragStartRatio(splitRatio);
  }, [splitRatio]);

  // Handle mouse/touch drag move
  const handleDragMove = useCallback((clientX: number) => {
    if (!isDragging || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const deltaX = clientX - dragStartX;
    const deltaPercent = (deltaX / containerRect.width) * 100;
    const newRatio = dragStartRatio + deltaPercent;

    updateSplitRatio(newRatio);
  }, [isDragging, dragStartX, dragStartRatio, updateSplitRatio]);

  // Handle drag end
  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Mouse event handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    handleDragStart(e.clientX);
  };

  // Touch event handlers
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      handleDragStart(e.touches[0].clientX);
    }
  };

  // Global mouse/touch move and up handlers
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      handleDragMove(e.clientX);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        handleDragMove(e.touches[0].clientX);
      }
    };

    const handleEnd = () => {
      handleDragEnd();
    };

    // Add global listeners
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchmove', handleTouchMove);
    document.addEventListener('touchend', handleEnd);
    document.addEventListener('touchcancel', handleEnd);

    // Prevent text selection while dragging
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleEnd);
      document.removeEventListener('touchcancel', handleEnd);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isDragging, handleDragMove, handleDragEnd]);

  return (
    <div
      ref={containerRef}
      className="flex-1 flex overflow-hidden"
    >
      {/* Left Panel - Terminal */}
      <div
        className="flex flex-col overflow-hidden bg-[#0a0a0a]"
        style={{ width: `${splitRatio}%` }}
      >
        {leftPanel}
      </div>

      {/* Draggable Divider */}
      <div
        className={`relative flex-shrink-0 w-1 cursor-col-resize group ${
          isDragging ? 'bg-[#FF6600]' : 'bg-gray-700 hover:bg-[#FF6600]'
        }`}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        style={{
          touchAction: 'none', // Prevent scroll interference
        }}
      >
        {/* Visual grip indicator */}
        <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 p-1 rounded ${
          isDragging ? 'bg-[#FF6600]' : 'bg-gray-700 group-hover:bg-[#FF6600]'
        }`}>
          <GripVertical
            size={16}
            className={isDragging ? 'text-black' : 'text-gray-400 group-hover:text-black'}
          />
        </div>

        {/* Wider hit area for easier grabbing */}
        <div
          className="absolute inset-y-0 -left-2 -right-2 cursor-col-resize"
          style={{ touchAction: 'none' }}
        />
      </div>

      {/* Right Panel - Tabbed Content */}
      <div
        className="flex flex-col overflow-hidden bg-gray-900"
        style={{ width: `${100 - splitRatio}%` }}
      >
        {rightPanel}
      </div>
    </div>
  );
}
