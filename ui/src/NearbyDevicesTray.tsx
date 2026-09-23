import React from 'react';
import { Monitor, Laptop, Smartphone, Tablet, Wifi, ArrowRight } from 'lucide-react';
import { LocalDiscoveryBeacon } from 'core';

export interface NearbyDevicesTrayProps {
  discoveredPeers: LocalDiscoveryBeacon[];
  onSelectPeer: (peer: LocalDiscoveryBeacon) => void;
}

export const NearbyDevicesTray: React.FC<NearbyDevicesTrayProps> = ({
  discoveredPeers,
  onSelectPeer,
}) => {
  if (discoveredPeers.length === 0) {
    return null;
  }

  const getIcon = (type: 'desktop' | 'mobile', name: string) => {
    const isTablet = name.toLowerCase().includes('ipad') || name.toLowerCase().includes('tablet');
    if (type === 'desktop') {
      return name.toLowerCase().includes('mac') || name.toLowerCase().includes('laptop') ? (
        <Laptop size={16} />
      ) : (
        <Monitor size={16} />
      );
    }
    return isTablet ? <Tablet size={16} /> : <Smartphone size={16} />;
  };

  return (
    <div
      role="region"
      aria-label="Nearby devices discovered on local network"
      className="flex flex-col gap-2 p-3 bg-slate-900/80 border border-purple-500/30 rounded-2xl shadow-xl backdrop-blur-md w-full max-w-sm"
    >
      <div className="flex items-center justify-between text-xs font-semibold text-slate-300 px-1">
        <div className="flex items-center gap-1.5 text-purple-400">
          <Wifi size={14} className="animate-pulse" />
          <span>Nearby Devices on Wi-Fi</span>
        </div>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-300">
          {discoveredPeers.length} Found
        </span>
      </div>

      <div className="flex flex-col gap-1.5 mt-1">
        {discoveredPeers.map((peer) => (
          <div
            key={peer.deviceId}
            className="flex items-center justify-between p-2 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-slate-700/60 transition group"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-purple-600/20 text-purple-300 flex items-center justify-center shrink-0">
                {getIcon(peer.deviceType, peer.deviceName)}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-200 truncate">
                  {peer.deviceName}
                </p>
                <p className="text-[10px] text-slate-400 font-mono">
                  PIN: {peer.roomPin}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => onSelectPeer(peer)}
              className="px-2.5 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 active:scale-95 text-white text-xs font-medium flex items-center gap-1 transition shadow-md shadow-purple-600/20"
            >
              <span>Connect</span>
              <ArrowRight size={12} className="group-hover:translate-x-0.5 transition-transform" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
