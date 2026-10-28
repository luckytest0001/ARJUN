import React, { useEffect, useState } from 'react';
import {
  Cast,
  Tv,
  Wifi,
  X,
  RefreshCw,
  Volume2,
  VolumeX,
  Play,
  Pause,
  Plus,
  Radio,
  Laptop,
  Check,
  ChevronRight,
  Sliders,
  AlertCircle,
  Square,
} from 'lucide-react';
import {
  castManager,
  CastDevice,
  CastSessionState,
  CastMediaPayload,
} from '../utils/castManager';
import { Channel } from '../utils/playlistParser';

interface CastModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeChannel?: Channel | null;
  onSelectChannelToCast?: (channel: Channel) => void;
}

export const CastModal: React.FC<CastModalProps> = ({
  isOpen,
  onClose,
  activeChannel,
}) => {
  const [devices, setDevices] = useState<CastDevice[]>([]);
  const [session, setSession] = useState<CastSessionState>(castManager.getSessionState());
  const [isScanning, setIsScanning] = useState<boolean>(true);
  const [continuousSearch, setContinuousSearch] = useState<boolean>(true);
  const [showAddIp, setShowAddIp] = useState<boolean>(false);
  const [customIpInput, setCustomIpInput] = useState<string>('');
  const [customNameInput, setCustomNameInput] = useState<string>('');
  const [connectingId, setConnectingId] = useState<string | null>(null);

  // Subscribe to CastManager updates
  useEffect(() => {
    if (!isOpen) return;

    // Start scanning immediately when opened
    castManager.startScanning();
    setDevices(castManager.getDevices());
    setSession(castManager.getSessionState());
    setIsScanning(castManager.getIsScanning());

    const unsubscribe = castManager.subscribe(() => {
      setDevices(castManager.getDevices());
      setSession(castManager.getSessionState());
      setIsScanning(castManager.getIsScanning());
    });

    return () => {
      unsubscribe();
      if (!continuousSearch) {
        castManager.stopScanning();
      }
    };
  }, [isOpen, continuousSearch]);

  if (!isOpen) return null;

  const handleToggleContinuousSearch = () => {
    const next = !continuousSearch;
    setContinuousSearch(next);
    if (next) {
      castManager.startScanning();
    } else {
      castManager.stopScanning();
    }
  };

  const handleManualScan = () => {
    castManager.performNetworkScan();
  };

  const handleConnectDevice = async (device: CastDevice) => {
    setConnectingId(device.id);

    const payload: CastMediaPayload | undefined = activeChannel
      ? {
          title: activeChannel.name,
          subtitle: activeChannel.group || 'Live Stream',
          streamUrl: activeChannel.originalUrl || activeChannel.url,
          logoUrl: activeChannel.logo,
          isLive: true,
        }
      : undefined;

    await castManager.connectToDevice(device, payload);
    setConnectingId(null);
  };

  const handleAddCustomDevice = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customIpInput.trim()) return;

    const added = castManager.addDeviceByIp(
      customIpInput.trim(),
      customNameInput.trim() || undefined
    );
    setCustomIpInput('');
    setCustomNameInput('');
    setShowAddIp(false);
    handleConnectDevice(added);
  };

  const getDeviceIcon = (type: CastDevice['type']) => {
    switch (type) {
      case 'chromecast':
      case 'android_tv':
        return <Tv className="w-5 h-5 text-[#5BAAF5]" />;
      case 'speaker':
        return <Radio className="w-5 h-5 text-[#81C784]" />;
      case 'smart_tv':
      case 'custom_ip':
      default:
        return <Tv className="w-5 h-5 text-[#FFB74D]" />;
    }
  };

  const renderSignalBars = (strength: number) => {
    return (
      <div className="flex items-end gap-[2px] h-3.5" title={`Signal: ${strength}/4`}>
        {[1, 2, 3, 4].map((bar) => (
          <div
            key={bar}
            className={`w-[2.5px] rounded-t-[1px] transition-all ${
              bar <= strength ? 'bg-[#5BAAF5]' : 'bg-white/20'
            }`}
            style={{ height: `${bar * 25}%` }}
          />
        ))}
      </div>
    );
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-[#282828] border border-white/[0.08] rounded-lg shadow-2xl overflow-hidden flex flex-col max-h-[92vh] text-white animate-in fade-in zoom-in-95 duration-150"
      >
        {/* ===================================================================
            HEADER: Cast Title + Radar Scan Beacon + Close Button
           =================================================================== */}
        <div className="px-5 py-4 bg-[#212121] border-b border-white/[0.08] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative w-9 h-9 rounded-full bg-[#5BAAF5]/15 border border-[#5BAAF5]/30 flex items-center justify-center text-[#5BAAF5]">
              <Cast className="w-5 h-5" />
              {isScanning && (
                <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[#5BAAF5] animate-ping" />
              )}
            </div>
            <div>
              <h2 className="text-[17px] font-semibold text-white tracking-wide">
                Google Cast
              </h2>
              <p className="text-[12px] text-[#A0A0A0] flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#4CAF50] animate-pulse" />
                Wi-Fi Network Scanner
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full flex items-center justify-center text-[#9E9E9E] hover:text-white hover:bg-white/10 active:bg-white/15 transition-colors"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ===================================================================
            CONTINUOUS SCAN STATUS BAR
           =================================================================== */}
        <div className="px-5 py-3 bg-[#1F1F1F] border-b border-white/[0.06] flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <Wifi className="w-4 h-4 text-[#5BAAF5]" />
            <span className="text-[#CCCCCC] font-normal">
              {isScanning
                ? 'Continuously scanning Wi-Fi devices...'
                : 'Continuous scan paused'}
            </span>
          </div>

          <div className="flex items-center gap-3">
            {/* Continuous Toggle */}
            <button
              onClick={handleToggleContinuousSearch}
              className={`px-2.5 py-1 rounded text-[11px] font-medium tracking-wide transition-colors border ${
                continuousSearch
                  ? 'bg-[#5BAAF5]/20 text-[#5BAAF5] border-[#5BAAF5]/40'
                  : 'bg-white/5 text-[#9E9E9E] border-white/10'
              }`}
              title="Toggle automatic continuous background device search"
            >
              {continuousSearch ? 'Continuous: ON' : 'Continuous: OFF'}
            </button>

            {/* Manual Refresh */}
            <button
              onClick={handleManualScan}
              className="p-1 rounded text-[#CCCCCC] hover:text-white hover:bg-white/10 active:bg-white/20 transition-colors"
              title="Scan Wi-Fi network now"
              aria-label="Scan now"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`}
              />
            </button>
          </div>
        </div>

        {/* ===================================================================
            BODY CONTENT: Scrollable
           =================================================================== */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* ACTIVE CONNECTED DEVICE PANEL */}
          {session.isConnected && session.connectedDevice && (
            <div className="p-4 rounded-md bg-[#1B3045] border border-[#5BAAF5]/40 shadow-md">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-[#5BAAF5]/20 border border-[#5BAAF5]/40 flex items-center justify-center text-[#5BAAF5] shrink-0">
                    <Tv className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-[15px] font-semibold text-white">
                        {session.connectedDevice.name}
                      </span>
                      <span className="text-[10px] font-semibold uppercase tracking-wider bg-[#4CAF50]/20 text-[#81C784] border border-[#4CAF50]/30 px-1.5 py-0.5 rounded">
                        Connected
                      </span>
                    </div>
                    <p className="text-[12px] text-[#90CAF9] mt-0.5">
                      {session.connectedDevice.model}
                      {session.connectedDevice.ip && ` • ${session.connectedDevice.ip}`}
                    </p>
                  </div>
                </div>

                <button
                  onClick={() => castManager.disconnect()}
                  className="px-3 py-1.5 rounded text-xs font-medium text-[#EF9A9A] hover:bg-[#D32F2F]/20 border border-[#D32F2F]/40 transition-colors shrink-0"
                >
                  Disconnect
                </button>
              </div>

              {/* Media Controls for Cast */}
              <div className="mt-3 pt-3 border-t border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="min-w-0 pr-2">
                    <span className="text-[11px] font-semibold text-[#81C784] uppercase tracking-wider block">
                      Now Casting
                    </span>
                    <p className="text-[14px] text-white font-medium truncate mt-0.5">
                      {session.activeMedia?.title || activeChannel?.name || 'Live Channel'}
                    </p>
                  </div>

                  <button
                    onClick={() => castManager.togglePlayPause()}
                    className="w-8 h-8 rounded-full bg-[#5BAAF5] text-[#212121] flex items-center justify-center hover:bg-[#90CAF9] active:scale-95 transition-all shadow"
                    aria-label={session.isPlaying ? 'Pause' : 'Play'}
                  >
                    {session.isPlaying ? (
                      <Pause className="w-4 h-4 fill-current" />
                    ) : (
                      <Play className="w-4 h-4 fill-current ml-0.5" />
                    )}
                  </button>
                </div>

                {/* Volume Slider */}
                <div className="flex items-center gap-2.5 pt-1">
                  <button
                    onClick={() => castManager.toggleMute()}
                    className="text-[#CCCCCC] hover:text-white transition-colors"
                    aria-label="Toggle mute"
                  >
                    {session.isMuted || session.volume === 0 ? (
                      <VolumeX className="w-4 h-4 text-[#EF5350]" />
                    ) : (
                      <Volume2 className="w-4 h-4 text-[#5BAAF5]" />
                    )}
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={session.isMuted ? 0 : session.volume}
                    onChange={(e) => castManager.setVolume(Number(e.target.value))}
                    className="flex-1 accent-[#5BAAF5] h-1.5 bg-white/20 rounded-lg cursor-pointer"
                  />
                  <span className="text-xs text-[#CCCCCC] tabular-nums font-mono w-8 text-right">
                    {session.isMuted ? '0%' : `${session.volume}%`}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* ACTIVE CHANNEL PREVIEW (If Ready to Cast) */}
          {!session.isConnected && activeChannel && (
            <div className="p-3 bg-[#1E2633] border border-[#5BAAF5]/25 rounded-md flex items-center justify-between">
              <div className="min-w-0 pr-2 flex items-center gap-2.5">
                {activeChannel.logo ? (
                  <img
                    src={activeChannel.logo}
                    alt=""
                    className="w-7 h-7 object-contain rounded shrink-0 bg-black/40"
                    onError={(e) => {
                      (e.currentTarget as HTMLElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <div className="w-7 h-7 rounded bg-[#5BAAF5]/20 text-[#5BAAF5] flex items-center justify-center font-bold text-xs shrink-0">
                    {activeChannel.name.charAt(0)}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white truncate">
                    Ready to stream: {activeChannel.name}
                  </p>
                  <p className="text-[11px] text-[#A0A0A0] truncate">
                    Select a TV or device below to begin casting
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* AVAILABLE DEVICES LIST */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11.5px] font-semibold text-[#A0A0A0] uppercase tracking-wider">
                Available Cast Devices ({devices.length})
              </span>
              {isScanning && (
                <div className="flex items-center gap-1.5 text-[11px] text-[#5BAAF5]">
                  <span className="w-2 h-2 rounded-full bg-[#5BAAF5] animate-ping" />
                  <span>Scanning Wi-Fi...</span>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              {devices.map((device) => {
                const isThisConnected = session.connectedDevice?.id === device.id;
                const isConnectingThis = connectingId === device.id || device.status === 'connecting';

                return (
                  <div
                    key={device.id}
                    onClick={() => {
                      if (!isThisConnected && !isConnectingThis) {
                        handleConnectDevice(device);
                      }
                    }}
                    className={`w-full p-3 rounded-md flex items-center justify-between transition-all cursor-pointer border ${
                      isThisConnected
                        ? 'bg-[#1C364F] border-[#5BAAF5]/60 shadow-sm'
                        : 'bg-[#303030] hover:bg-[#383838] border-white/[0.04] active:bg-[#404040]'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0 pr-2">
                      <div
                        className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 border ${
                          isThisConnected
                            ? 'bg-[#5BAAF5]/20 border-[#5BAAF5]/40 text-[#5BAAF5]'
                            : 'bg-white/5 border-white/10 text-white/70'
                        }`}
                      >
                        {getDeviceIcon(device.type)}
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-[14.5px] font-medium text-white truncate">
                            {device.name}
                          </p>
                        </div>
                        <p className="text-[12px] text-[#9E9E9E] truncate">
                          {device.model}
                          {device.ip ? ` • ${device.ip}` : ''}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      {renderSignalBars(device.signalStrength)}

                      {isThisConnected ? (
                        <div className="flex items-center gap-1 text-xs font-semibold text-[#81C784] bg-[#4CAF50]/15 px-2 py-1 rounded border border-[#4CAF50]/30">
                          <Check className="w-3.5 h-3.5" />
                          <span>Active</span>
                        </div>
                      ) : isConnectingThis ? (
                        <div className="flex items-center gap-1.5 text-xs text-[#5BAAF5]">
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          <span>Connecting</span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="px-3 py-1 rounded text-xs font-medium text-white bg-[#5BAAF5]/20 hover:bg-[#5BAAF5] hover:text-[#212121] border border-[#5BAAF5]/40 transition-colors"
                        >
                          Cast
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ADD DEVICE BY IP (For direct connection to Android TV / Fire TV / WebOS) */}
          <div className="pt-2">
            {!showAddIp ? (
              <button
                type="button"
                onClick={() => setShowAddIp(true)}
                className="w-full py-2.5 px-3 rounded border border-dashed border-white/20 text-[#CCCCCC] hover:text-white hover:border-white/40 flex items-center justify-center gap-2 text-xs font-medium transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span>Add device by IP address or Hostname</span>
              </button>
            ) : (
              <form
                onSubmit={handleAddCustomDevice}
                className="p-3.5 bg-[#242424] border border-white/10 rounded-md space-y-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white">
                    Direct Device Wi-Fi IP Connection
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowAddIp(false)}
                    className="text-[#9E9E9E] hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="space-y-2">
                  <input
                    type="text"
                    required
                    placeholder="e.g. 192.168.1.150 or chromecast.local"
                    value={customIpInput}
                    onChange={(e) => setCustomIpInput(e.target.value)}
                    className="w-full bg-[#303030] text-white text-xs px-3 py-2 rounded border border-white/15 focus:border-[#5BAAF5] outline-none"
                  />
                  <input
                    type="text"
                    placeholder="Custom name (optional, e.g. Living Room Box)"
                    value={customNameInput}
                    onChange={(e) => setCustomNameInput(e.target.value)}
                    className="w-full bg-[#303030] text-white text-xs px-3 py-2 rounded border border-white/15 focus:border-[#5BAAF5] outline-none"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowAddIp(false)}
                    className="px-3 py-1.5 text-xs text-[#CCCCCC] hover:bg-white/5 rounded"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-3.5 py-1.5 text-xs font-medium bg-[#5BAAF5] text-[#212121] rounded hover:bg-[#90CAF9] transition-colors"
                  >
                    Add & Connect
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* HELP & NETWORK TROUBLESHOOTING TIP */}
          <div className="p-3 rounded bg-white/[0.03] border border-white/[0.06] flex items-start gap-2.5 text-[11.5px] text-[#9E9E9E] leading-relaxed">
            <AlertCircle className="w-4 h-4 text-[#5BAAF5] shrink-0 mt-0.5" />
            <p>
              Continuous search scans for Google Cast, Chromecast, and Android TV receivers on your current local Wi-Fi. Ensure your TV and phone/tablet are connected to the same wireless network.
            </p>
          </div>
        </div>

        {/* ===================================================================
            FOOTER: Close Button
           =================================================================== */}
        <div className="px-5 py-3 bg-[#212121] border-t border-white/[0.08] flex items-center justify-between">
          <span className="text-[11px] text-[#757575]">
            Google Cast Web SDK v1
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded text-xs font-medium text-[#5BAAF5] hover:bg-white/10 uppercase tracking-wider"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
