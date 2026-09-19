'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string | React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  confirmColor?: 'red' | 'orange' | 'green' | 'purple';
  onConfirm: () => void;
  onCancel: () => void;
}

const colorClasses = {
  red: 'bg-[#FF3333] hover:bg-[#FF5555] text-black',
  orange: 'bg-[#FF6600] hover:bg-[#FF8833] text-black',
  green: 'bg-[#00FF66] hover:bg-[#33FF88] text-black',
  purple: 'bg-[#9966FF] hover:bg-[#AA77FF] text-black',
};

export default function ConfirmModal({
  isOpen,
  title,
  message,
  confirmText = 'CONFIRM',
  cancelText = 'CANCEL',
  confirmColor = 'red',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onCancel();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  // Focus trap
  useEffect(() => {
    if (isOpen && modalRef.current) {
      modalRef.current.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={onCancel}
      />

      {/* Modal */}
      <div
        ref={modalRef}
        tabIndex={-1}
        className="relative bg-gray-900 border-4 border-[#FFCC00] rounded-lg shadow-2xl w-full max-w-sm animate-in zoom-in-95 duration-150"
        style={{
          boxShadow: '0 0 30px rgba(255, 204, 0, 0.3), inset 0 0 20px rgba(0, 0, 0, 0.5)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b-2 border-[#FFCC00]/30">
          <h2
            style={{ fontFamily: 'VT323, monospace' }}
            className="text-2xl text-[#FFCC00]"
          >
            {title}
          </h2>
          <button
            onClick={onCancel}
            className="p-1 text-gray-500 hover:text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="px-4 py-4">
          <div
            style={{ fontFamily: 'VT323, monospace' }}
            className="text-lg text-gray-300 whitespace-pre-line"
          >
            {message}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 px-4 py-4 border-t-2 border-[#FFCC00]/30">
          <button
            onClick={onCancel}
            style={{ fontFamily: 'VT323, monospace' }}
            className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-lg rounded transition-colors"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            style={{ fontFamily: 'VT323, monospace' }}
            className={`flex-1 px-4 py-2 text-lg rounded transition-colors ${colorClasses[confirmColor]}`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
