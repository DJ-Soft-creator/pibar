// Voice in the chat (tasks J1/J2): a dictation button for the input and reading an answer aloud. Both use the voice
// services of the shared settings on the server (transcribe_audio, improve_text, speak_text). Placeholder of the
// rebuild: no button, no voice – the chat shows them as soon as these functions return something.

/** A microphone button that records, transcribes and hands the text over; null = dictation not configured */
export function createDictationButton(_onText: (text: string) => void): HTMLElement | null {
  return null;
}

/** Whether reading aloud is available (a TTS service is configured) */
export function canSpeak(): boolean {
  return false;
}

/** Read a text aloud */
export function speakText(_text: string): Promise<void> {
  return Promise.resolve();
}
