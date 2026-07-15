import React, { useState, useEffect } from 'react';
import { Shield, Settings, AlertCircle, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';

interface PermissionOnboardingProps {
  scope: 'accessibility' | 'screen_recording';
  onClose: () => void;
  onPermissionGranted: () => void;
}

export const PermissionOnboarding: React.FC<PermissionOnboardingProps> = ({
  scope,
  onClose,
  onPermissionGranted,
}) => {
  const [platform, setPlatform] = useState<'macos' | 'linux' | 'other'>('other');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('mac')) {
      setPlatform('macos');
    } else if (ua.includes('linux')) {
      setPlatform('linux');
    } else {
      setPlatform('other');
    }
  }, []);

  const handleOpenSettings = async () => {
    try {
      if (scope === 'screen_recording') {
        await invoke('request_screen_recording_permission');
      } else {
        await invoke('request_accessibility_permission');
      }
    } catch (err: any) {
      console.error(err);
    }
  };

  const handleVerify = async () => {
    setChecking(true);
    setError(null);
    try {
      const command = scope === 'screen_recording'
        ? 'check_screen_recording_permission'
        : 'check_accessibility_permission';
      
      const hasPermission = await invoke<boolean>(command);
      if (hasPermission) {
        onPermissionGranted();
      } else {
        if (platform === 'macos') {
          if (scope === 'screen_recording') {
            setError('Screen Recording permission is still missing. Please ensure Omni-Space is checked in System Settings.');
          } else {
            setError('Accessibility permission is still missing. Please ensure Omni-Space is checked in System Settings.');
          }
        } else if (platform === 'linux' && scope === 'accessibility') {
          setError('Write access to /dev/uinput is still missing. Please check your udev rules or user groups.');
        } else {
          setError('Required permission is still missing.');
        }
      }
    } catch (err: any) {
      setError(`Verification failed: ${err.message || err}`);
    } finally {
      setChecking(false);
    }
  };

  const title = scope === 'screen_recording' ? 'Screen Recording Permission' : 'Input Control Onboarding';
  const description = scope === 'screen_recording'
    ? 'Omni-Space requires Screen Recording authorization to capture and stream window frames.'
    : 'Omni-Space requires special OS permission to inject synthetic inputs (mouse clicks, scrolls, and key presses).';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4">
      <div className="relative w-full max-w-md bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl flex flex-col gap-6 text-slate-100">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-violet-500/10 border border-violet-500/20 text-violet-400 rounded-xl">
              <Shield size={22} className="animate-pulse" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-200">{title}</h3>
              <p className="text-xs text-slate-500 mt-0.5">Setup permission to enable control loops</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-300 transition p-1 rounded-lg hover:bg-slate-800"
          >
            <X size={16} />
          </button>
        </div>

        {/* Info Copy */}
        <div className="text-xs leading-relaxed text-slate-400 flex flex-col gap-3">
          <p>{description}</p>

          {platform === 'macos' ? (
            <div className="bg-slate-950/40 border border-slate-800 p-4 rounded-xl flex flex-col gap-2.5">
              <div className="font-semibold text-slate-300 flex items-center gap-1.5">
                <Settings size={14} className="text-violet-400" /> macOS System Settings Instructions
              </div>
              <ol className="list-decimal list-inside space-y-1.5 text-slate-400">
                <li>Click <strong>Open System Settings</strong> below.</li>
                <li>Go to the <strong>{scope === 'screen_recording' ? 'Screen Recording' : 'Accessibility'}</strong> section.</li>
                <li>Find <strong>Omni-Space</strong> in the list and toggle it <strong>ON</strong>.</li>
                <li>Return here and click <strong>Verify Permission</strong>.</li>
              </ol>
            </div>
          ) : platform === 'linux' && scope === 'accessibility' ? (
            <div className="bg-slate-950/40 border border-slate-800 p-4 rounded-xl flex flex-col gap-2.5 font-mono text-[11px]">
              <div className="font-semibold text-slate-300 font-sans text-xs flex items-center gap-1.5">
                <Settings size={14} className="text-violet-400" /> Linux uinput Configuration
              </div>
              <p className="text-slate-400 font-sans text-[11px] leading-normal">
                To write events directly to the uinput device, add your user to the <code>input</code> group and configure local udev rules:
              </p>
              <div className="bg-slate-950 p-2.5 rounded border border-slate-800 text-slate-300 select-all space-y-1">
                <div>echo 'KERNEL=="uinput", GROUP="input", MODE="0660"' | sudo tee /etc/udev/rules.d/99-uinput.rules</div>
                <div>sudo usermod -aG input $USER</div>
              </div>
              <p className="text-slate-500 font-sans text-[10px] leading-normal">
                * Note: You will need to reboot or log out and back in for group changes to take effect.
              </p>
            </div>
          ) : (
            <div className="bg-slate-950/40 border border-slate-800 p-3.5 rounded-xl text-slate-400 text-center">
              No special configurations are required on this operating system. Simply proceed!
            </div>
          )}
        </div>

        {/* Error Alert */}
        {error && (
          <div className="flex items-start gap-2.5 text-rose-400 text-xs bg-rose-500/10 border border-rose-500/20 p-3 rounded-xl">
            <AlertCircle size={15} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3">
          {platform === 'macos' && (
            <button
              onClick={handleOpenSettings}
              className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold py-2.5 rounded-xl border border-slate-700 transition"
            >
              Open System Settings
            </button>
          )}

          <button
            onClick={handleVerify}
            disabled={checking}
            className="flex-1 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-slate-100 text-xs font-semibold py-2.5 rounded-xl shadow-lg shadow-purple-500/10 transition disabled:opacity-50"
          >
            {checking ? 'Verifying...' : 'Verify Permission'}
          </button>
        </div>
      </div>
    </div>
  );
};
