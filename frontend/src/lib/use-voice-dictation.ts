/**
 * Push-to-hold voice dictation.
 *
 * Uses the browser's Web Speech API (`webkitSpeechRecognition` on Chromium,
 * `SpeechRecognition` on standards-track) to transcribe the mic stream while
 * a hotkey is held. The Tauri WebView ships Chromium, so this works on
 * macOS / Windows / Linux without any new dependencies.
 *
 * On platforms where the API is unavailable (e.g. older WebViews), the hook
 * silently no-ops — `supported` reports false and the hotkey has no effect.
 */

import { useEffect, useRef, useState } from "react";

interface SpeechRecognitionResultPiece {
  transcript: string;
}
interface SpeechRecognitionResult {
  isFinal: boolean;
  0: SpeechRecognitionResultPiece;
}
interface SpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResult>;
}
interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface VoiceDictation {
  /** True iff the underlying WebSpeech API is reachable in this WebView. */
  supported: boolean;
  /** True while the hotkey is held + the recogniser is open. */
  listening: boolean;
  /** Latest accumulated transcript (final + interim). Cleared on start. */
  transcript: string;
}

export interface VoiceDictationOptions {
  /**
   * Called with the *final* transcript when recognition ends (i.e. when the
   * user releases the hotkey). Consumers append this to their input.
   */
  onFinalTranscript?: (text: string) => void;
}

/**
 * Wire push-to-hold dictation. Default hotkey is Cmd+Shift+Space (mac) /
 * Ctrl+Shift+Space (win/linux). The component decides what to do with the
 * transcript via `onFinalTranscript`.
 */
export function useVoiceDictation(
  options: VoiceDictationOptions = {},
): VoiceDictation {
  const Ctor = getSpeechRecognitionCtor();
  const supported = Ctor !== null;

  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const recogRef = useRef<SpeechRecognitionInstance | null>(null);
  // True iff a `stop()` was requested before the engine finished opening.
  // The kept-flag is consumed inside `r.onstart` so the engine stops on its
  // own as soon as it's ready.
  const stopPendingRef = useRef(false);
  const transcriptRef = useRef("");
  const onFinalRef = useRef(options.onFinalTranscript);

  useEffect(() => {
    onFinalRef.current = options.onFinalTranscript;
  }, [options.onFinalTranscript]);

  useEffect(() => {
    if (!Ctor) return;
    function isHotkey(e: KeyboardEvent): boolean {
      // Cmd+Shift+Space on mac, Ctrl+Shift+Space elsewhere — the WebView
      // sees Cmd as `metaKey`, Ctrl as `ctrlKey`. Accept either modifier
      // alongside Shift+Space so the binding feels native on each OS.
      return (e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "Space";
    }
    function start(): void {
      if (recogRef.current || !Ctor) return;
      const r = new Ctor();
      r.continuous = false;
      r.interimResults = true;
      r.lang = navigator.language || "en-US";
      transcriptRef.current = "";
      stopPendingRef.current = false;
      setTranscript("");
      r.onresult = (ev) => {
        let acc = transcriptRef.current;
        for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
          const result = ev.results[i] as SpeechRecognitionResult;
          acc += result[0].transcript;
        }
        transcriptRef.current = acc;
        setTranscript(acc);
      };
      r.onerror = () => undefined;
      r.onend = () => {
        const final = transcriptRef.current.trim();
        recogRef.current = null;
        stopPendingRef.current = false;
        setListening(false);
        if (final && onFinalRef.current) onFinalRef.current(final);
      };
      try {
        r.start();
        recogRef.current = r;
        setListening(true);
        // Consume any stop request that landed before start() returned.
        if (stopPendingRef.current) stop();
      } catch {
        recogRef.current = null;
        setListening(false);
      }
    }
    function stop(): void {
      const r = recogRef.current;
      if (!r) {
        // Started but not yet wired — flag for the start() epilogue.
        stopPendingRef.current = true;
        return;
      }
      try {
        r.stop();
      } catch {
        /* ignore */
      }
    }
    // Track which keys of the hotkey set are currently down. PTT only
    // releases when the *combination* is no longer satisfied, so a stray
    // Shift tap during dictation doesn't kill the recogniser.
    const down = { meta: false, ctrl: false, shift: false, space: false };
    function isHotkeyHeld(): boolean {
      return (down.meta || down.ctrl) && down.shift && down.space;
    }
    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
    }
    function trackDown(e: KeyboardEvent): void {
      if (e.code === "Space") down.space = true;
      else if (e.code.startsWith("Shift")) down.shift = true;
      else if (e.code.startsWith("Meta")) down.meta = true;
      else if (e.code.startsWith("Control")) down.ctrl = true;
    }
    function trackUp(e: KeyboardEvent): void {
      if (e.code === "Space") down.space = false;
      else if (e.code.startsWith("Shift")) down.shift = false;
      else if (e.code.startsWith("Meta")) down.meta = false;
      else if (e.code.startsWith("Control")) down.ctrl = false;
    }
    function onKeyDown(e: KeyboardEvent): void {
      trackDown(e);
      // Don't hijack Space typed into an input/textarea/contenteditable.
      if (isTypingTarget(e.target)) return;
      if (isHotkey(e) && !e.repeat) {
        e.preventDefault();
        start();
      }
    }
    function onKeyUp(e: KeyboardEvent): void {
      trackUp(e);
      if (!isHotkeyHeld()) stop();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      stop();
    };
  }, [Ctor]);

  return { supported, listening, transcript };
}
