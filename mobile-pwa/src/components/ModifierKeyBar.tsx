import React, { useState, useCallback } from 'react';
import { OmniRTCManager, InputEventEnvelope } from 'core';

interface ModifierKeyBarProps {
  rtcManager: OmniRTCManager | null;
  targetWindowId: string | null;
  targetDeviceId: string | null;
}

interface ModifierState {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export const ModifierKeyBar: React.FC<ModifierKeyBarProps> = ({
  rtcManager,
  targetWindowId,
  targetDeviceId,
}) => {
  const [modifiers, setModifiers] = useState<ModifierState>({
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  });

  const sendKey = useCallback(
    (code: string, key: string, type: 'keydown' | 'keyup') => {
      if (!rtcManager || !targetDeviceId || !targetWindowId) return;

      const envelope: InputEventEnvelope = {
        targetWindowId,
        timestamp: Date.now(),
        event: {
          type,
          data: { code, key },
        },
      };
      rtcManager.sendKeyboardInput(targetDeviceId, envelope);
    },
    [rtcManager, targetDeviceId, targetWindowId]
  );

  const toggleModifier = (mod: keyof ModifierState, code: string, key: string) => {
    const nextState = !modifiers[mod];
    setModifiers((prev) => ({ ...prev, [mod]: nextState }));
    sendKey(code, key, nextState ? 'keydown' : 'keyup');
  };

  const sendKeyPress = (code: string, key: string) => {
    sendKey(code, key, 'keydown');
    setTimeout(() => {
      sendKey(code, key, 'keyup');
    }, 40);
  };

  if (!targetDeviceId || !targetWindowId) {
    return null;
  }

  return (
    <div
      role="toolbar"
      aria-label="Remote keyboard modifier and action bar"
      className="flex items-center gap-1.5 p-2 bg-slate-900/90 backdrop-blur-md border border-slate-700/60 rounded-xl shadow-xl overflow-x-auto max-w-full text-xs font-mono select-none"
    >
      {/* Sticky modifier toggles */}
      <button
        type="button"
        onClick={() => toggleModifier('ctrl', 'ControlLeft', 'Control')}
        className={`px-2.5 py-1.5 rounded-lg border font-semibold transition-all ${
          modifiers.ctrl
            ? 'bg-purple-600 border-purple-400 text-white shadow-md shadow-purple-500/30'
            : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700'
        }`}
        aria-pressed={modifiers.ctrl}
      >
        Ctrl
      </button>

      <button
        type="button"
        onClick={() => toggleModifier('alt', 'AltLeft', 'Alt')}
        className={`px-2.5 py-1.5 rounded-lg border font-semibold transition-all ${
          modifiers.alt
            ? 'bg-purple-600 border-purple-400 text-white shadow-md shadow-purple-500/30'
            : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700'
        }`}
        aria-pressed={modifiers.alt}
      >
        Alt
      </button>

      <button
        type="button"
        onClick={() => toggleModifier('shift', 'ShiftLeft', 'Shift')}
        className={`px-2.5 py-1.5 rounded-lg border font-semibold transition-all ${
          modifiers.shift
            ? 'bg-purple-600 border-purple-400 text-white shadow-md shadow-purple-500/30'
            : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700'
        }`}
        aria-pressed={modifiers.shift}
      >
        Shift
      </button>

      <button
        type="button"
        onClick={() => toggleModifier('meta', 'MetaLeft', 'Meta')}
        className={`px-2.5 py-1.5 rounded-lg border font-semibold transition-all ${
          modifiers.meta
            ? 'bg-purple-600 border-purple-400 text-white shadow-md shadow-purple-500/30'
            : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700'
        }`}
        aria-pressed={modifiers.meta}
      >
        Win/⌘
      </button>

      <div className="w-[1px] h-5 bg-slate-700 mx-0.5" />

      {/* Action Keys */}
      <button
        type="button"
        onClick={() => sendKeyPress('Escape', 'Escape')}
        className="px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 active:bg-slate-600 transition"
      >
        Esc
      </button>

      <button
        type="button"
        onClick={() => sendKeyPress('Tab', 'Tab')}
        className="px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 active:bg-slate-600 transition"
      >
        Tab
      </button>

      <button
        type="button"
        onClick={() => sendKeyPress('Backspace', 'Backspace')}
        className="px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 active:bg-slate-600 transition"
      >
        Bksp
      </button>

      <button
        type="button"
        onClick={() => sendKeyPress('Enter', 'Enter')}
        className="px-2.5 py-1.5 rounded-lg bg-purple-600/30 border border-purple-500/40 text-purple-200 hover:bg-purple-600/50 active:bg-purple-600 transition font-bold"
      >
        ↵ Enter
      </button>

      <div className="w-[1px] h-5 bg-slate-700 mx-0.5" />

      {/* Navigation Arrows */}
      <button
        type="button"
        onClick={() => sendKeyPress('ArrowLeft', 'ArrowLeft')}
        className="px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 active:bg-slate-600 transition"
        aria-label="Arrow Left"
      >
        ←
      </button>
      <button
        type="button"
        onClick={() => sendKeyPress('ArrowUp', 'ArrowUp')}
        className="px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 active:bg-slate-600 transition"
        aria-label="Arrow Up"
      >
        ↑
      </button>
      <button
        type="button"
        onClick={() => sendKeyPress('ArrowDown', 'ArrowDown')}
        className="px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 active:bg-slate-600 transition"
        aria-label="Arrow Down"
      >
        ↓
      </button>
      <button
        type="button"
        onClick={() => sendKeyPress('ArrowRight', 'ArrowRight')}
        className="px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 active:bg-slate-600 transition"
        aria-label="Arrow Right"
      >
        →
      </button>
    </div>
  );
};
