'use client';

import { useSession } from '../context/SessionContext';
import VoiceRecorder from './VoiceRecorder';

export default function GlobalVoiceRecorder() {
  const { activeSession } = useSession();

  return (
    <VoiceRecorder activeSession={activeSession} />
  );
}
