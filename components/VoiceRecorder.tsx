'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Mic, Send, X, Eye, Loader2, AlertCircle } from 'lucide-react';

interface VoiceRecorderProps {
  sessionId: string;
  onSendMessage: (message: string) => void;
}

export default function VoiceRecorder({
  sessionId,
  onSendMessage
}: VoiceRecorderProps) {
  // State management
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribedText, setTranscribedText] = useState('');
  const [showTextPreview, setShowTextPreview] = useState(false);
  const [error, setError] = useState('');

  // Native MediaRecorder refs (simpler and more mobile-friendly)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // Transcription function
  const transcribeAudio = useCallback(async (audioBlob: Blob): Promise<string> => {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'audio.webm');

    const response = await fetch('/api/transcribe', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error('Transcription failed');
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Transcription failed');
    }

    return data.transcript || '';
  }, []);

  // Recording functions using native MediaRecorder
  const startRecording = useCallback(async () => {
    try {
      // Debug information
      console.log('🔍 Protocol:', window.location.protocol);
      console.log('🔍 Host:', window.location.host);
      console.log('🔍 isSecureContext:', window.isSecureContext);
      console.log('🔍 navigator.mediaDevices exists:', !!navigator.mediaDevices);

      // Check for secure context (required for microphone)
      if (!window.isSecureContext) {
        setError('Microphone requires HTTPS. Current: ' + window.location.protocol);
        return;
      }

      // Check for microphone support
      if (!navigator.mediaDevices) {
        setError('navigator.mediaDevices not available. Need HTTPS or localhost.');
        return;
      }

      if (!navigator.mediaDevices.getUserMedia) {
        setError('getUserMedia not supported in this browser.');
        return;
      }

      // Note: enumerateDevices() only shows device details AFTER permission is granted
      // So we'll see 0 devices here, but that's OK - getUserMedia() will prompt
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');
        console.log('🎤 Audio input devices found (before permission):', audioInputs.length);
        console.log('🎤 Devices:', audioInputs);
        // Don't return early - getUserMedia will trigger the permission prompt
      } catch (enumErr) {
        console.warn('🎤 Could not enumerate devices:', enumErr);
      }

      console.log('🎤 About to call getUserMedia...');
      console.log('🎤 This should trigger permission prompt...');

      // Try with minimal constraints first (iOS Safari can be picky)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true  // Simplest possible constraint
      });

      console.log('🎤 SUCCESS! Got media stream:', stream);
      console.log('🎤 Audio tracks:', stream.getAudioTracks());

      streamRef.current = stream;
      console.log('🎤 Microphone access granted');

      // Determine best mime type
      let mimeType = 'audio/webm';
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        mimeType = 'audio/webm;codecs=opus';
      } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
        mimeType = 'audio/mp4';
      } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
        mimeType = 'audio/ogg;codecs=opus';
      }
      console.log('🎤 Using mime type:', mimeType);

      // Create MediaRecorder
      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      // Collect audio data
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      // Start recording
      mediaRecorder.start(100); // Collect data every 100ms
      setIsRecording(true);
      setError('');
      console.log('🎤 Recording started');

    } catch (err) {
      console.error('🎤 Recording failed:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to start recording';

      // Provide helpful error messages
      if (errorMessage.includes('NotAllowedError') || errorMessage.includes('Permission denied')) {
        setError('Microphone permission denied. Please allow microphone access.');
      } else if (errorMessage.includes('NotFoundError')) {
        setError('No microphone found. Please check device settings.');
      } else if (errorMessage.includes('NotSupportedError')) {
        setError('HTTPS required for microphone. Use localhost or https://');
      } else {
        setError(errorMessage);
      }
      setIsRecording(false);
    }
  }, []);

  const stopRecording = useCallback(async (): Promise<Blob | null> => {
    return new Promise((resolve) => {
      if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
        resolve(null);
        return;
      }

      mediaRecorderRef.current.onstop = () => {
        const blob = new Blob(audioChunksRef.current, {
          type: mediaRecorderRef.current?.mimeType || 'audio/webm'
        });
        console.log('🎙️ Recording stopped, blob size:', blob.size);

        // Stop all tracks
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop());
          streamRef.current = null;
        }

        resolve(blob);
      };

      mediaRecorderRef.current.stop();
      setIsRecording(false);
    });
  }, []);

  const cancelRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    audioChunksRef.current = [];
    setTranscribedText('');
    setShowTextPreview(false);
    setError('');
    setIsRecording(false);
  }, []);

  const handlePreview = useCallback(async () => {
    const audioBlob = await stopRecording();
    setIsTranscribing(true);

    try {
      if (!audioBlob || audioBlob.size === 0) {
        throw new Error('No recorded audio available');
      }

      console.log('🎙️ Transcribing audio blob:', audioBlob.size, 'bytes');
      const transcript = await transcribeAudio(audioBlob);
      setTranscribedText(transcript);
      setShowTextPreview(true);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transcription failed');
      setShowTextPreview(true);
    } finally {
      setIsTranscribing(false);
      audioChunksRef.current = [];
    }
  }, [stopRecording, transcribeAudio]);

  const handleDirectSend = useCallback(async () => {
    const audioBlob = await stopRecording();
    setIsTranscribing(true);

    try {
      if (!audioBlob || audioBlob.size === 0) {
        throw new Error('No recorded audio available');
      }

      const transcript = await transcribeAudio(audioBlob);

      if (transcript) {
        onSendMessage(transcript);
      }

      setTranscribedText('');
      setShowTextPreview(false);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setIsTranscribing(false);
      audioChunksRef.current = [];
    }
  }, [stopRecording, transcribeAudio, onSendMessage]);

  const handleSendTranscribed = useCallback(() => {
    if (transcribedText) {
      onSendMessage(transcribedText);
      setTranscribedText('');
      setShowTextPreview(false);
      setError('');
      audioChunksRef.current = [];
    }
  }, [transcribedText, onSendMessage]);

  return (
    <div className="w-full p-4 bg-black border-t-2 border-[#FF6600]">
      {!isRecording && !isTranscribing && !showTextPreview ? (
        /* Initial State: Record Button */
        <div className="flex justify-center">
          <motion.button
            onClick={startRecording}
            className="flex items-center space-x-2 px-6 py-3 rounded-lg text-base font-bold font-['Righteous'] transition-all duration-200 bg-[#FF3333] text-white shadow-lg active:scale-95"
            style={{ minHeight: '48px', minWidth: '120px' }}
          >
            <Mic size={20} />
            <span>RECORD</span>
          </motion.button>
        </div>
      ) : showTextPreview ? (
        /* Text Preview State */
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          {/* Transcribed Text Display */}
          <div className="bg-black border-2 border-[#FF6600] rounded-lg p-4">
            {error ? (
              <div className="flex items-start space-x-3">
                <AlertCircle size={20} className="text-[#FF3333] mt-1" />
                <div>
                  <p className="text-[#FF3333] font-bold text-sm font-['Righteous']">Error</p>
                  <p className="text-white text-sm font-['VT323']">{error}</p>
                </div>
              </div>
            ) : (
              <textarea
                value={transcribedText}
                onChange={(e) => setTranscribedText(e.target.value)}
                placeholder="Transcribed text will appear here..."
                className="w-full h-24 p-0 bg-transparent border-none text-white text-base font-['VT323'] placeholder-white/40 focus:outline-none resize-none"
                style={{ fontSize: '18px' }}
              />
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex justify-center space-x-3">
            <motion.button
              onClick={() => {
                setShowTextPreview(false);
                setTranscribedText('');
                setError('');
                audioChunksRef.current = [];
              }}
              className="flex items-center space-x-2 px-5 py-3 rounded-lg text-base font-bold font-['Righteous'] transition-all bg-gray-700 text-white active:scale-95"
              style={{ minHeight: '48px' }}
            >
              <X size={18} />
              <span>CANCEL</span>
            </motion.button>

            <motion.button
              onClick={handleSendTranscribed}
              disabled={!transcribedText.trim()}
              className="flex items-center space-x-2 px-5 py-3 rounded-lg text-base font-bold font-['Righteous'] transition-all bg-[#00FF66] text-black disabled:opacity-50 disabled:bg-gray-500 active:scale-95"
              style={{ minHeight: '48px' }}
            >
              <Send size={18} />
              <span>SEND</span>
            </motion.button>
          </div>
        </motion.div>
      ) : isTranscribing ? (
        /* Transcribing State */
        <div className="flex justify-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center space-x-3 px-6 py-3 rounded-lg bg-[#FFCC00] text-black"
          >
            <Loader2 size={20} className="animate-spin" />
            <span className="text-base font-bold font-['Righteous']">TRANSCRIBING...</span>
          </motion.div>
        </div>
      ) : (
        /* Recording State */
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4 flex flex-col items-center"
        >
          {/* Recording Indicator */}
          <div className="flex items-center space-x-3 px-6 py-3 rounded-lg bg-[#FF3333] text-white">
            <motion.div
              animate={{ scale: [1, 1.2, 1] }}
              transition={{ repeat: Infinity, duration: 1.5 }}
              className="w-3 h-3 bg-white rounded-full"
            />
            <span className="text-base font-bold font-['Righteous']">RECORDING...</span>
          </div>

          {/* Recording Action Buttons */}
          <div className="flex space-x-3">
            <motion.button
              onClick={cancelRecording}
              className="flex items-center space-x-2 px-4 py-3 rounded-lg text-base font-bold font-['Righteous'] transition-all bg-gray-700 text-white active:scale-95"
              style={{ minHeight: '48px' }}
            >
              <X size={18} />
              <span>STOP</span>
            </motion.button>

            <motion.button
              onClick={handlePreview}
              className="flex items-center space-x-2 px-4 py-3 rounded-lg text-base font-bold font-['Righteous'] transition-all bg-[#FFCC00] text-black active:scale-95"
              style={{ minHeight: '48px' }}
            >
              <Eye size={18} />
              <span>PREVIEW</span>
            </motion.button>

            <motion.button
              onClick={handleDirectSend}
              className="flex items-center space-x-2 px-4 py-3 rounded-lg text-base font-bold font-['Righteous'] transition-all bg-[#00FF66] text-black active:scale-95"
              style={{ minHeight: '48px' }}
            >
              <Send size={18} />
              <span>SEND</span>
            </motion.button>
          </div>
        </motion.div>
      )}
    </div>
  );
}
