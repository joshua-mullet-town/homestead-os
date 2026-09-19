'use client';

import { useRouter } from 'next/navigation';
import { Home, ZoomIn, ZoomOut, Trash2, X } from 'lucide-react';

interface SessionNavProps {
  isOpen: boolean;
  onClose: () => void;
  currentSessionId: string;
  currentRepo?: string;
  currentIssue?: string;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  onDestroySession: () => void;
}

export default function SessionNav({
  isOpen,
  onClose,
  currentSessionId,
  currentRepo,
  currentIssue,
  fontSize,
  onFontSizeChange,
  onDestroySession,
}: SessionNavProps) {
  const router = useRouter();

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40"
          onClick={onClose}
        />
      )}

      {/* Drawer */}
      <div
        className={`fixed top-0 right-0 h-full w-80 bg-[rgb(var(--color-orange))] shadow-2xl z-50 transform transition-transform duration-300 ease-in-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="bg-gray-900 p-4 flex items-center justify-between border-b-4 border-black">
            <h2 style={{ fontFamily: 'VT323, monospace' }} className="text-2xl text-white font-bold">
              SESSION MENU
            </h2>
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-800 rounded transition-colors"
            >
              <X size={24} className="text-white" />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Current Session Info */}
            <div className="bg-white border-4 border-black p-4 shadow-retro-lg">
              <div style={{ fontFamily: 'VT323, monospace' }} className="text-sm text-gray-600 mb-1">
                CURRENT SESSION
              </div>
              {currentRepo && (
                <div style={{ fontFamily: 'VT323, monospace' }} className="text-xl font-bold text-black">
                  {currentRepo}
                </div>
              )}
              {currentIssue && (
                <div style={{ fontFamily: 'VT323, monospace' }} className="text-lg text-gray-700">
                  Issue #{currentIssue}
                </div>
              )}
              <div style={{ fontFamily: 'VT323, monospace' }} className="text-xs text-gray-500 mt-2 truncate">
                {currentSessionId}
              </div>
            </div>

            {/* Session Controls */}
            <div className="space-y-3">
              {/* Font Size */}
              <div className="bg-white border-4 border-black p-4 shadow-retro-lg">
                <div style={{ fontFamily: 'VT323, monospace' }} className="text-sm text-gray-600 mb-2">
                  FONT SIZE
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => onFontSizeChange(Math.max(10, fontSize - 2))}
                    className="flex-1 bg-gray-800 hover:bg-gray-700 text-white p-3 rounded flex items-center justify-center gap-2 transition-colors"
                  >
                    <ZoomOut size={20} />
                    <span style={{ fontFamily: 'VT323, monospace' }} className="text-lg">SMALLER</span>
                  </button>
                  <div style={{ fontFamily: 'VT323, monospace' }} className="text-2xl font-bold min-w-[3ch] text-center">
                    {fontSize}
                  </div>
                  <button
                    onClick={() => onFontSizeChange(Math.min(32, fontSize + 2))}
                    className="flex-1 bg-gray-800 hover:bg-gray-700 text-white p-3 rounded flex items-center justify-center gap-2 transition-colors"
                  >
                    <ZoomIn size={20} />
                    <span style={{ fontFamily: 'VT323, monospace' }} className="text-lg">LARGER</span>
                  </button>
                </div>
              </div>

              {/* Home */}
              <button
                onClick={() => router.push('/')}
                className="w-full bg-[#FFCC00] hover:bg-[#FFD633] border-4 border-black p-4 shadow-retro-lg transition-colors flex items-center justify-center gap-3"
              >
                <Home size={24} />
                <span style={{ fontFamily: 'VT323, monospace' }} className="text-2xl font-bold">
                  HOME
                </span>
              </button>

              {/* Destroy Session */}
              <button
                onClick={onDestroySession}
                className="w-full bg-[#FF3333] hover:bg-[#FF4444] border-4 border-black p-4 shadow-retro-lg transition-colors flex items-center justify-center gap-3"
              >
                <Trash2 size={24} />
                <span style={{ fontFamily: 'VT323, monospace' }} className="text-2xl font-bold">
                  DESTROY SESSION
                </span>
              </button>
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
