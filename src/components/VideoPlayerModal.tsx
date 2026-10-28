import React, { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';

// Silence mpegts.js internal console noise for network loader and transmuxer errors
if (typeof window !== 'undefined') {
  try {
    const m = mpegts as unknown as { LoggingControl?: Record<string, boolean> };
    if (m?.LoggingControl) {
      m.LoggingControl.enableAll = false;
      m.LoggingControl.enableError = false;
      m.LoggingControl.enableWarn = false;
      m.LoggingControl.enableInfo = false;
      m.LoggingControl.enableDebug = false;
      m.LoggingControl.enableVerbose = false;
    }
  } catch {
    // ignore
  }
}

import {
  ArrowLeft,
  ChevronLeft,
  Star,
  MoreVertical,
} from 'lucide-react';
import {
  Channel,
  DEFAULT_PLAYER_USER_AGENT,
  STB_MODELS,
  buildAuthenticatedXtreamAltUrls,
  buildMacCookieHeader,
  getCachedClientVodDuration,
  getDefaultStalkerAuthSettings,
  isYouTubeChannelUrl,
  normalizeMacAddress,
  openExternalChannelLink,
  probeClientSideVodDuration,
  repairAndNormalizeChannel,
  resolveClientSideVodUrls,
  setDefaultStalkerAuthSettings,
} from '../utils/playlistParser';
import {
  buildPublicCorsProxyUrls,
  canUseBackendProxy,
  ensureBackendProbed,
  getEffectiveApiBaseUrl,
  getHttpsSafeMediaUrls,
  isDirectVodChannel,
  isStaticHostEnvironment,
} from '../utils/proxyHelper';
import {
  ClientTranscodeResult,
  transcodeChannelClientSide,
} from '../utils/clientFfmpegTranscoder';
import {
  parseRemoteKeyEvent,
  focusTvElement,
} from '../utils/tvNavigation';
import { createSmartHlsLoaderClass } from '../utils/smartHlsLoader';

interface VideoPlayerModalProps {
  channel: Channel;
  channels: Channel[];
  allChannels?: Channel[];
  isFavorite: boolean;
  onToggleFavorite: (channelId: string) => void;
  onSelectChannel: (channel: Channel) => void;
  onClose: () => void;
  onOpenSettings?: () => void;
  onOpenCast?: () => void;
  userAgent?: string;
  defaultMacAddress?: string;
  defaultPortalToken?: string;
  stbEmulationModel?: string;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const totalSecs = Math.floor(seconds);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function appendChannelAuthQueryParams(
  channel: Channel,
  fallbackUa?: string,
  overrideTargetUrl?: string
): string {
  const rawTarget = (overrideTargetUrl || channel.originalUrl || channel.url || '').trim();
  let targetUrl = rawTarget;
  if (rawTarget.includes('/api/proxy?url=')) {
    try {
      const match = rawTarget.match(/[?&]url=([^&]+)/);
      if (match && match[1]) {
        targetUrl = decodeURIComponent(match[1]);
      }
    } catch {
      // keep rawTarget
    }
  }
  let qs = `url=${encodeURIComponent(targetUrl)}`;
  const globalAuth = getDefaultStalkerAuthSettings();
  const effectiveMac = normalizeMacAddress(channel.macAddress) || globalAuth.mac;
  const effectiveAuth = (channel.authToken || globalAuth.token || '').trim();
  const effectiveUa =
    channel.userAgent ||
    fallbackUa ||
    (effectiveMac ? globalAuth.userAgent : undefined) ||
    DEFAULT_PLAYER_USER_AGENT;

  if (effectiveUa) {
    qs += `&ua=${encodeURIComponent(effectiveUa)}`;
  }
  if (channel.referer) {
    qs += `&ref=${encodeURIComponent(channel.referer)}`;
  }
  if (effectiveMac) {
    qs += `&mac=${encodeURIComponent(effectiveMac)}`;
  }
  const effectiveCookie = buildMacCookieHeader(effectiveMac, channel.cookie);
  if (effectiveCookie) {
    qs += `&cookie=${encodeURIComponent(effectiveCookie)}`;
  }
  if (effectiveAuth) {
    qs += `&auth=${encodeURIComponent(effectiveAuth)}`;
  }
  if (channel.xtreamParams) {
    qs += `&xtreamServer=${encodeURIComponent(channel.xtreamParams.server)}`;
    qs += `&xtreamUser=${encodeURIComponent(channel.xtreamParams.username)}`;
    qs += `&xtreamPass=${encodeURIComponent(channel.xtreamParams.password)}`;
    qs += `&xtreamStreamId=${encodeURIComponent(channel.xtreamParams.streamId)}`;
    qs += `&xtreamType=${encodeURIComponent(channel.xtreamParams.streamType)}`;
  }
  if (channel.name) {
    qs += `&title=${encodeURIComponent(channel.name)}`;
  }
  return qs;
}

function buildProxyUrl(
  channel: Channel,
  fallbackUa?: string,
  overrideTargetUrl?: string,
  baseUrlOverride?: string
): string {
  const target = (overrideTargetUrl || channel.url || '').trim();
  if (!overrideTargetUrl && target.includes('/api/proxy?')) {
    return target;
  }
  if (isStaticHostEnvironment() && !canUseBackendProxy() && baseUrlOverride === undefined) {
    return target;
  }
  const base = baseUrlOverride !== undefined ? baseUrlOverride : getEffectiveApiBaseUrl();
  const query = appendChannelAuthQueryParams(channel, fallbackUa, overrideTargetUrl);
  if (base && base.endsWith('/api/proxy')) {
    return `${base}?${query}`;
  }
  return `${base || ''}/api/proxy?${query}`;
}

function buildTranscodeUrl(
  channel: Channel,
  mode: 'remux' | 'full',
  seekSec = 0,
  fallbackUa?: string,
  overrideTargetUrl?: string,
  baseUrlOverride?: string,
  forceH264 = false
): string {
  if (isStaticHostEnvironment() && !canUseBackendProxy() && baseUrlOverride === undefined) {
    return '';
  }
  const base = baseUrlOverride !== undefined ? baseUrlOverride : getEffectiveApiBaseUrl();
  let url = `${base || ''}/api/transcode?mode=${mode}&${appendChannelAuthQueryParams(
    channel,
    fallbackUa,
    overrideTargetUrl
  )}`;
  if (forceH264 || mode === 'full') {
    url += '&forceH264=1';
  }
  if (seekSec > 0) {
    url += `&ss=${Math.floor(seekSec)}`;
  }
  return url;
}

function buildProbeUrl(
  channel: Channel,
  fallbackUa?: string,
  baseUrlOverride?: string
): string {
  if (isStaticHostEnvironment() && !canUseBackendProxy() && baseUrlOverride === undefined) {
    return '';
  }
  const base = baseUrlOverride !== undefined ? baseUrlOverride : getEffectiveApiBaseUrl();
  return `${base || ''}/api/probe?${appendChannelAuthQueryParams(channel, fallbackUa)}`;
}

const ASPECT_RATIO_LABELS = [
  'Best Fit',
  'Fit Horizontal',
  'Fit Vertical',
  'Fill',
  '16:9',
  '4:3',
  'Center',
] as const;

const SHOW_CLOCK_LABELS = [
  'Never',
  'When UI controls are visible',
  'Always',
] as const;

export type PortraitBoxShape = 'rectangle-16-9' | 'square-1-1' | 'rectangle-4-3';
export type TranscodeMode = 'auto' | 'force-all' | 'direct';

export const VideoPlayerModal: React.FC<VideoPlayerModalProps> = ({
  channel,
  channels,
  allChannels,
  isFavorite,
  onToggleFavorite,
  onSelectChannel,
  onClose,
  onOpenSettings,
  onOpenCast,
  userAgent,
  defaultMacAddress,
  defaultPortalToken,
  stbEmulationModel,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeDrawerItemRef = useRef<HTMLDivElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [showStalkerModal, setShowStalkerModal] = useState(false);
  const [stalkerMacDraft, setStalkerMacDraft] = useState('');
  const [stalkerTokenDraft, setStalkerTokenDraft] = useState('');
  const [stalkerModelDraft, setStalkerModelDraft] = useState('MAG 250 / 254 (Infomir Ministra)');
  const [aspectMode, setAspectMode] = useState<'fill' | 'cover' | 'contain'>('fill');
  const [showControls, setShowControls] = useState(true);
  const [logoError, setLogoError] = useState(false);
  const [showChannelDrawer, setShowChannelDrawer] = useState(false);
  const [drawerView, setDrawerView] = useState<'channels' | 'categories'>('channels');
  const [drawerCategory, setDrawerCategory] = useState<string>('All Channels');
  const [clockText, setClockText] = useState<string>(() =>
    new Date().toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  );
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showPlayerSettings, setShowPlayerSettings] = useState(false);
  const [accelMode, setAccelMode] = useState<'HW+' | 'HW' | 'SW'>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('iptv_accel_mode');
        if (saved === 'HW+' || saved === 'HW' || saved === 'SW') {
          return saved as 'HW+' | 'HW' | 'SW';
        }
      } catch {
        // ignore
      }
    }
    return 'HW+';
  });
  const [showAccelSubmenu, setShowAccelSubmenu] = useState(false);
  const [isScreenLocked, setIsScreenLocked] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [playerToast, setPlayerToast] = useState<string | null>(null);

  // Player in-screen Settings popup sliders (matching Screenshot_20261009-204818_IPTV.jpg)
  const [brightness, setBrightness] = useState<number>(92);
  const [volume, setVolume] = useState<number>(100);
  const [gestureHud, setGestureHud] = useState<'brightness' | 'volume' | null>(null);
  const [aspectRatioIdx, setAspectRatioIdx] = useState<number>(0); // 0 = 'Best Fit'
  const [videoScale, setVideoScale] = useState<number>(100); // 50% to 200%, default 100%
  const [showClockIdx, setShowClockIdx] = useState<number>(0); // 0 = 'Never'

  // Orientation state: controls Vertical (Portrait) vs Horizontal (Landscape) mode
  const [isLandscape, setIsLandscape] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth > window.innerHeight;
    }
    return true;
  });
  const [isPhysicalLandscape, setIsPhysicalLandscape] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth > window.innerHeight;
    }
    return true;
  });
  const [rotationHudText, setRotationHudText] = useState<string | null>(null);

  // Portrait Mode Box Layout Configuration: 'rectangle-16-9' | 'square-1-1' | 'rectangle-4-3'
  // When in portrait mode, restricts video to a centered box preserving aspect ratio instead of filling the full screen
  const [portraitBoxShape, setPortraitBoxShape] = useState<PortraitBoxShape>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('iptv_portrait_box_shape');
        if (saved === 'square-1-1' || saved === 'rectangle-4-3' || saved === 'rectangle-16-9') {
          return saved as PortraitBoxShape;
        }
      } catch {
        // ignore
      }
    }
    return 'rectangle-16-9';
  });

  const handleSetPortraitBoxShape = useCallback((shape: PortraitBoxShape) => {
    setPortraitBoxShape(shape);
    try {
      localStorage.setItem('iptv_portrait_box_shape', shape);
    } catch {
      // ignore
    }
    const label =
      shape === 'square-1-1'
        ? '1:1 Square Box (चौकोर)'
        : shape === 'rectangle-4-3'
        ? '4:3 Box (आयताकार 4:3)'
        : '16:9 Rectangle (आयताकार 16:9)';
    setRotationHudText(`Portrait: ${label}`);
    if (gestureHudTimeoutRef.current) {
      window.clearTimeout(gestureHudTimeoutRef.current);
    }
    gestureHudTimeoutRef.current = window.setTimeout(() => {
      setRotationHudText(null);
    }, 1400);
  }, []);

  // FFmpeg Transcoding Configuration Mode: 'auto' | 'force-all' | 'direct'
  // When 'force-all', forces FFmpeg transcoding for all channels to H.264 video and AAC audio
  const [transcodeMode, setTranscodeMode] = useState<TranscodeMode>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('iptv_transcode_mode');
        if (saved === 'force-all' || saved === 'auto' || saved === 'direct') {
          return saved as TranscodeMode;
        }
      } catch {
        // ignore
      }
    }
    return 'auto';
  });
  const [streamReloadKey, setStreamReloadKey] = useState<number>(0);

  const handleSetTranscodeMode = useCallback((mode: TranscodeMode) => {
    setTranscodeMode(mode);
    try {
      localStorage.setItem('iptv_transcode_mode', mode);
    } catch {
      // ignore
    }
    const label =
      mode === 'force-all'
        ? 'Force FFmpeg (H.264 + AAC Transcode)'
        : mode === 'direct'
        ? 'Direct Play (No Transcoding)'
        : 'Auto Smart Transcode (स्वतः)';
    setRotationHudText(`Transcode: ${label}`);
    if (gestureHudTimeoutRef.current) {
      window.clearTimeout(gestureHudTimeoutRef.current);
    }
    gestureHudTimeoutRef.current = window.setTimeout(() => {
      setRotationHudText(null);
    }, 1500);

    setStreamReloadKey((k) => k + 1);
  }, []);

  const openStalkerAuthModal = useCallback(() => {
    const globalAuth = getDefaultStalkerAuthSettings();
    setStalkerMacDraft(channel.macAddress || defaultMacAddress || globalAuth.mac || '');
    setStalkerTokenDraft(channel.authToken || defaultPortalToken || globalAuth.token || '');
    setStalkerModelDraft(stbEmulationModel || globalAuth.stbModel);
    setShowStalkerModal(true);
  }, [channel, defaultMacAddress, defaultPortalToken, stbEmulationModel]);

  const handleSaveStalkerAuth = useCallback(() => {
    const cleanMac = normalizeMacAddress(stalkerMacDraft);
    const cleanToken = stalkerTokenDraft.trim();
    setDefaultStalkerAuthSettings({
      mac: cleanMac,
      token: cleanToken,
      stbModel: stalkerModelDraft,
    });
    if (cleanMac) {
      channel.macAddress = cleanMac;
      channel.cookie = buildMacCookieHeader(cleanMac, channel.cookie);
    }
    if (cleanToken) {
      channel.authToken = cleanToken;
    }
    setShowStalkerModal(false);
    setPlayerToast('Stalker authentication updated. Reloading...');
    setHasError(false);
    setIsLoading(true);
    setStreamReloadKey((k) => k + 1);
  }, [channel, stalkerMacDraft, stalkerTokenDraft, stalkerModelDraft]);

  const handleSetAccelMode = useCallback(
    (mode: 'HW+' | 'HW' | 'SW') => {
      setAccelMode(mode);
      try {
        localStorage.setItem('iptv_accel_mode', mode);
      } catch {
        // ignore
      }
      if (mode === 'SW') {
        handleSetTranscodeMode('force-all');
      } else if (mode === 'HW') {
        handleSetTranscodeMode('direct');
      } else {
        handleSetTranscodeMode('auto');
      }
    },
    [handleSetTranscodeMode]
  );

  const handleCycleAccelMode = useCallback(() => {
    const nextMode = accelMode === 'HW+' ? 'SW' : accelMode === 'SW' ? 'HW' : 'HW+';
    handleSetAccelMode(nextMode);
  }, [accelMode, handleSetAccelMode]);

  const requestFullscreenSafe = useCallback(async () => {
    try {
      if (typeof document === 'undefined') return;
      if (document.fullscreenElement || (document as any).webkitFullscreenElement) {
        return;
      }
      const el = containerRef.current || document.documentElement;
      if (el.requestFullscreen) {
        await el.requestFullscreen().catch(() => {});
      } else if ((el as any).webkitRequestFullscreen) {
        (el as any).webkitRequestFullscreen();
      } else if ((el as any).mozRequestFullScreen) {
        (el as any).mozRequestFullScreen();
      } else if ((el as any).msRequestFullscreen) {
        (el as any).msRequestFullscreen();
      }
    } catch {
      // Browser requires user gesture for fullscreen
    }
  }, []);

  const exitFullscreenSafe = useCallback(() => {
    try {
      if (typeof document === 'undefined') return;
      if (document.fullscreenElement || (document as any).webkitFullscreenElement) {
        if (document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        } else if ((document as any).webkitExitFullscreen) {
          (document as any).webkitExitFullscreen().catch(() => {});
        }
      }
      if (screen.orientation && typeof screen.orientation.unlock === 'function') {
        try {
          screen.orientation.unlock();
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    // Only listen for orientation and viewport changes; do not auto-invoke requestFullscreen
    // on mount without user gesture to prevent browser TypeError console errors
    const handleOrientationOrResize = () => {
      const physicalLandscape = window.innerWidth > window.innerHeight;
      setIsPhysicalLandscape(physicalLandscape);
    };

    window.addEventListener('resize', handleOrientationOrResize);
    window.addEventListener('orientationchange', handleOrientationOrResize);
    if (screen.orientation && 'addEventListener' in screen.orientation) {
      screen.orientation.addEventListener('change', handleOrientationOrResize);
    }

    return () => {
      window.removeEventListener('resize', handleOrientationOrResize);
      window.removeEventListener('orientationchange', handleOrientationOrResize);
      if (screen.orientation && 'removeEventListener' in screen.orientation) {
        screen.orientation.removeEventListener('change', handleOrientationOrResize);
      }
      exitFullscreenSafe();
    };
  }, [exitFullscreenSafe]);

  const gestureHudTimeoutRef = useRef<number | null>(null);
  const suppressNextClickRef = useRef<boolean>(false);
  const gestureStateRef = useRef<{
    active: boolean;
    moved: boolean;
    side: 'left' | 'right';
    startY: number;
    startBrightness: number;
    startVolume: number;
  }>({
    active: false,
    moved: false,
    side: 'left',
    startY: 0,
    startBrightness: 92,
    startVolume: 100,
  });

  const triggerPlayerToast = (msg: string) => {
    setPlayerToast(msg);
    window.setTimeout(() => {
      setPlayerToast((prev) => (prev === msg ? null : prev));
    }, 2500);
  };

  // Timeline state: supports both LIVE streams ("00:07 ————— LIVE") and VOD ("00:15 ●———— 1:08:24")
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [isLiveStream, setIsLiveStream] = useState(true);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubTime, setScrubTime] = useState(0);
  const seekBaseOffsetRef = useRef<number>(0);
  const isScrubbingRef = useRef<boolean>(false);
  const knownVodDurationRef = useRef<number | null>(null);
  const userPausedRef = useRef<boolean>(false);
  const playerControlRef = useRef<{
    seekTo: (targetSec: number) => void;
  } | null>(null);

  const currentIndex = channels.findIndex((c) => c.id === channel.id);
  const isFavChannelTitle = /\bFAV\b/i.test(channel.name);

  const fullChannelList = allChannels && allChannels.length > 0 ? allChannels : channels;

  const drawerCategories = React.useMemo(() => {
    return ['All Channels'];
  }, []);

  const drawerChannels = React.useMemo(() => {
    return fullChannelList;
  }, [fullChannelList]);

  useEffect(() => {
    const updateClock = () => {
      setClockText(
        new Date().toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        })
      );
    };
    updateClock();
    const timer = window.setInterval(updateClock, 15000);
    // Focus player container immediately on Android TV
    containerRef.current?.focus();
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (showChannelDrawer) {
      if (activeDrawerItemRef.current) {
        activeDrawerItemRef.current.scrollIntoView({ block: 'center' });
      }
      const timer = window.setTimeout(() => {
        const target =
          activeDrawerItemRef.current ||
          document.querySelector<HTMLElement>('[data-tv="drawer-channel"]') ||
          document.querySelector<HTMLElement>('[data-tv="drawer-category"]');
        if (target) {
          focusTvElement(target, true);
        }
      }, 60);
      return () => window.clearTimeout(timer);
    }
  }, [showChannelDrawer, drawerView]);

  useEffect(() => {
    const normalizedChannel = repairAndNormalizeChannel(channel);
    let cleanUrl = (normalizedChannel.url || '').trim();
    if (cleanUrl.includes('/api/proxy') && /[?&]url=/.test(cleanUrl)) {
      try {
        const m = cleanUrl.match(/[?&]url=([^&]+)/);
        if (m && m[1]) {
          cleanUrl = decodeURIComponent(m[1]).trim();
          normalizedChannel.url = cleanUrl;
          normalizedChannel.forceProxy = false;
          normalizedChannel.isProxied = false;
        }
      } catch {
        // keep cleanUrl
      }
    }

    if (isYouTubeChannelUrl(cleanUrl)) {
      openExternalChannelLink(cleanUrl);
      onClose();
      return;
    }

    setLogoError(false);
    setHasError(false);
    setIsLoading(true);
    setIsPlaying(true);
    setShowControls(true);
    setCurrentTime(0);
    setDuration(null);
    setIsLiveStream(true);
    setIsScrubbing(false);
    setScrubTime(0);
    seekBaseOffsetRef.current = 0;
    isScrubbingRef.current = false;
    knownVodDurationRef.current = null;
    userPausedRef.current = false;

    const video = videoRef.current;
    if (!video) return;

    try {
      video.playbackRate = 1.0;
      video.defaultPlaybackRate = 1.0;
    } catch {
      // ignore
    }

    let hls: Hls | null = null;
    let mpegtsPlayer: mpegts.Player | null = null;
    let recoveredMediaError = false;
    let isMounted = true;
    let currentAttemptIdx = 0;
    let attemptToken = 0;
    let isTransitioning = false;
    let hasPlaybackStarted = false;
    let lastKnownTimestamp = 0;
    let pendingInitialSeekSec = 0;
    let reconnectRetries = 0;
    let transitionTimer: number | null = null;
    let stallTimer: number | null = null;
    let noVideoTimer: number | null = null;
    let reconnectTimer: number | null = null;
    let waitingWatchdogTimer: number | null = null;
    let seekFallbackTimer: number | null = null;
    let isClientFfmpegActive = false;
    let activeClientBlobUrl: string | null = null;
    let currentClientSegmentDuration = 28;
    let clientFfmpegAbort: AbortController | null = null;
    let nextClientSegment: {
      startSec: number;
      promise: Promise<ClientTranscodeResult | null>;
    } | null = null;

    const revokeClientBlob = () => {
      if (activeClientBlobUrl) {
        try {
          URL.revokeObjectURL(activeClientBlobUrl);
        } catch {
          // ignore
        }
        activeClientBlobUrl = null;
      }
    };

    const abortClientFfmpeg = () => {
      if (clientFfmpegAbort) {
        try {
          clientFfmpegAbort.abort();
        } catch {
          // ignore
        }
        clientFfmpegAbort = null;
      }
      nextClientSegment = null;
    };

    const clearWaitingWatchdog = () => {
      if (waitingWatchdogTimer !== null) {
        window.clearTimeout(waitingWatchdogTimer);
        waitingWatchdogTimer = null;
      }
    };

    const clearSeekFallbackTimer = () => {
      if (seekFallbackTimer !== null) {
        window.clearTimeout(seekFallbackTimer);
        seekFallbackTimer = null;
      }
    };

    const clearTimers = () => {
      if (transitionTimer !== null) {
        window.clearTimeout(transitionTimer);
        transitionTimer = null;
      }
      if (stallTimer !== null) {
        window.clearTimeout(stallTimer);
        stallTimer = null;
      }
      if (noVideoTimer !== null) {
        window.clearTimeout(noVideoTimer);
        noVideoTimer = null;
      }
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearWaitingWatchdog();
      clearSeekFallbackTimer();
    };

    const destroyPlayers = () => {
      if (hls) {
        try {
          hls.destroy();
        } catch {
          // ignore
        }
        hls = null;
      }
      if (mpegtsPlayer) {
        try {
          mpegtsPlayer.pause();
          mpegtsPlayer.unload();
          mpegtsPlayer.detachMediaElement();
          mpegtsPlayer.destroy();
        } catch {
          // ignore
        }
        mpegtsPlayer = null;
      }
    };

    const triggerStreamError = () => {
      if (!isMounted) return;
      clearTimers();
      setIsLoading(false);
      setIsPlaying(true);
      setHasError(true);
      setShowControls(true);
    };

    if (
      !cleanUrl ||
      !/^(https?:\/\/|rtmp:\/\/|rtsp:\/\/|udp:\/\/|mms:\/\/)/i.test(cleanUrl)
    ) {
      triggerStreamError();
      return;
    }

    const isHttpProtocol = /^https?:\/\//i.test(cleanUrl);
    const isHttpsUrl = /^https:\/\//i.test(cleanUrl);
    const isPageHttps =
      typeof window !== 'undefined' && window.location.protocol === 'https:';
    const isStaticDeploy = isStaticHostEnvironment();
    const hasMacAuth =
      Boolean(normalizedChannel.macAddress) ||
      Boolean(normalizedChannel.cookie) ||
      Boolean(normalizedChannel.authToken);
    const isMacAddressChannel =
      Boolean(normalizedChannel.macAddress) ||
      (Boolean(normalizedChannel.cookie) && /mac=/i.test(normalizedChannel.cookie || '')) ||
      /[?&;#|](?:mac|deviceMac|stb_mac|mac_address|hw_id)=/i.test(cleanUrl) ||
      /\/(?:play\/live\.php|stalker_portal|portal\.php)\b/i.test(cleanUrl);
    const hasMacOrXtreamAuth =
      hasMacAuth || Boolean(normalizedChannel.xtreamParams);

    const mustUseProxyOnly =
      !isHttpProtocol ||
      (/^http:\/\//i.test(cleanUrl) && isPageHttps) ||
      Boolean(normalizedChannel.referer) ||
      hasMacAuth;

    const isExplicitM3u8 = /\.m3u8(\?|$|#|&)/i.test(cleanUrl);
    const isExplicitTsOrFlv =
      /\.(ts|flv)(\?|$|#|&)/i.test(cleanUrl) ||
      /[?&](?:extension|output)=ts\b/i.test(cleanUrl);
    const isMkvAviOrLegacyContainer =
      /\.(mkv|avi|wmv|mpg|mpeg|3gp|divx)(\?|$|#|&)/i.test(cleanUrl);
    const isExplicitNativeVod =
      normalizedChannel.forceProxy ||
      normalizedChannel.isProxied ||
      cleanUrl.includes('/api/proxy?') ||
      /\.(mp4|webm|mov|m4v|ogg)(\?|$|#|&)/i.test(cleanUrl) ||
      /\/(movie|series|vod)\//i.test(cleanUrl) ||
      normalizedChannel.xtreamParams?.streamType === 'movie' ||
      normalizedChannel.xtreamParams?.streamType === 'series' ||
      /archive\.org|drive\.usercontent\.google\.com|drive\.google\.com|pixeldrain\.(com|dev)|dropbox\.com|dropboxusercontent\.com/i.test(
        cleanUrl
      );

    // Optional HTTPS-upgraded direct candidate for http:// VOD/HLS URLs on standard port 80
    const httpsUpgradedUrl =
      /^http:\/\/[^/:]+(\/|$)/i.test(cleanUrl)
        ? cleanUrl.replace(/^http:\/\//i, 'https://')
        : undefined;

    let proxyUrl = buildProxyUrl(normalizedChannel, userAgent);
    let transcodeFullUrl = buildTranscodeUrl(
      normalizedChannel,
      'full',
      0,
      userAgent,
      undefined,
      undefined,
      transcodeMode === 'force-all'
    );
    const xtreamAltUrls = buildAuthenticatedXtreamAltUrls(normalizedChannel);
    const xtreamHlsProxyUrl =
      xtreamAltUrls.hlsUrl && xtreamAltUrls.hlsUrl !== cleanUrl
        ? buildProxyUrl(normalizedChannel, userAgent, xtreamAltUrls.hlsUrl)
        : undefined;
    const xtreamTsProxyUrl =
      xtreamAltUrls.tsUrl && xtreamAltUrls.tsUrl !== cleanUrl
        ? buildProxyUrl(normalizedChannel, userAgent, xtreamAltUrls.tsUrl)
        : undefined;

    const attempts: Array<{
      mode: 'native' | 'hls' | 'mpegts' | 'client-ffmpeg';
      url: string;
      isDirect?: boolean;
    }> = [];

    const pushAttempt = (
      mode: 'native' | 'hls' | 'mpegts' | 'client-ffmpeg',
      url?: string,
      isDirect?: boolean
    ) => {
      if (!url) return;
      if (!attempts.some((a) => a.mode === mode && a.url === url)) {
        attempts.push({ mode, url, isDirect });
      }
    };

    const corsProxyUrls = buildPublicCorsProxyUrls(cleanUrl);
    const isVodChannel =
      isExplicitNativeVod ||
      isMkvAviOrLegacyContainer ||
      isDirectVodChannel(normalizedChannel);
    const httpsSafeCleanUrls = getHttpsSafeMediaUrls(cleanUrl, isVodChannel);
    const resolvedVodCandidates: string[] = [cleanUrl];

    if (isVodChannel) {
      setIsLiveStream(false);
    }

    const initialCachedDur = getCachedClientVodDuration(cleanUrl);
    if (initialCachedDur && initialCachedDur > 0) {
      knownVodDurationRef.current = initialCachedDur;
      setIsLiveStream(false);
      setDuration(initialCachedDur);
    }

    // 0. Force FFmpeg Transcoding mode check:
    // If user configured 'force-all' or accelMode is 'SW', put FFmpeg H.264+AAC transcode as #1 priority for every channel
    if (transcodeMode === 'force-all' || accelMode === 'SW') {
      if (canUseBackendProxy()) {
        pushAttempt('native', transcodeFullUrl);
      } else {
        // Static deployment (e.g. GitHub Pages) fallback to client-side WebAssembly FFmpeg
        pushAttempt('client-ffmpeg', cleanUrl);
      }
    }

    const hasBackend = canUseBackendProxy();

    if (cleanUrl.startsWith('blob:')) {
      pushAttempt('native', cleanUrl, true);
      pushAttempt('client-ffmpeg', cleanUrl);
    } else if (!isHttpProtocol) {
      // RTMP / RTSP / UDP / MMS streams handled via server-side FFmpeg H.264 transcode if backend available
      if (hasBackend) {
        pushAttempt('native', transcodeFullUrl);
      } else {
        pushAttempt('client-ffmpeg', cleanUrl);
      }
    } else if (isExplicitM3u8) {
      // 1. If backend proxy is available and stream requires proxy (mixed content, referer, MAC auth), try backend first
      if (hasBackend && mustUseProxyOnly && Hls.isSupported()) {
        pushAttempt('hls', proxyUrl);
      }
      // 2. Browser HLS (safe HTTPS clean URLs, upgraded URLs, or direct) with SmartHlsLoader
      if (Hls.isSupported()) {
        for (const safeUrl of httpsSafeCleanUrls) {
          pushAttempt('hls', safeUrl, true);
        }
      }
      // 3. Backend Proxy HLS (only if backend is verified and available)
      if (hasBackend && Hls.isSupported() && !mustUseProxyOnly) {
        pushAttempt('hls', proxyUrl);
      }
      // 4. On static deployments (GitHub Pages), try public CORS proxies when direct stream lacks CORS
      if (!hasBackend && Hls.isSupported()) {
        for (const corsUrl of corsProxyUrls) {
          pushAttempt('hls', corsUrl, false);
        }
      }
      // 5. If Xtream Codes live stream, try authenticated .ts endpoint via backend proxy
      if (hasBackend && xtreamTsProxyUrl && mpegts.isSupported()) {
        pushAttempt('mpegts', xtreamTsProxyUrl);
      } else if (!hasBackend && xtreamAltUrls.tsUrl && mpegts.isSupported() && !isPageHttps) {
        for (const safeTsUrl of getHttpsSafeMediaUrls(xtreamAltUrls.tsUrl)) {
          pushAttempt('mpegts', safeTsUrl, true);
        }
      }
      // 6. Native HLS fallback (Safari / iOS / Android WebView native HLS)
      for (const safeUrl of httpsSafeCleanUrls) {
        pushAttempt('native', safeUrl, true);
      }
      if (hasBackend) {
        pushAttempt('native', proxyUrl);
        pushAttempt('native', transcodeFullUrl);
      }
      pushAttempt('client-ffmpeg', cleanUrl);
    } else if (isMacAddressChannel) {
      if (isExplicitM3u8) {
        if (hasBackend && Hls.isSupported()) {
          pushAttempt('hls', proxyUrl);
        }
        for (const safeUrl of httpsSafeCleanUrls) {
          pushAttempt('hls', safeUrl, true);
        }
        if (hasBackend) {
          pushAttempt('native', proxyUrl);
          pushAttempt('native', transcodeFullUrl);
        }
      } else {
        // Stalker / Ministra MAG STB stream: authenticated MPEG-TS stream
        // 1. mpegts on proxyUrl (handles H.264+AAC TS streams directly)
        if (hasBackend && mpegts.isSupported()) {
          pushAttempt('mpegts', proxyUrl);
        }
        // 2. FFmpeg transcode (converts MPEG-2 / AC-3 / MP2 / HEVC to browser H.264+AAC fMP4)
        if (hasBackend) {
          pushAttempt('native', transcodeFullUrl);
          pushAttempt('native', proxyUrl);
        }
        // 3. Fallbacks for direct/static playback
        if (mpegts.isSupported() && (!hasBackend || !isPageHttps)) {
          for (const safeUrl of httpsSafeCleanUrls) {
            pushAttempt('mpegts', safeUrl, true);
          }
          if (!hasBackend) {
            for (const corsUrl of corsProxyUrls) {
              pushAttempt('mpegts', corsUrl, false);
            }
          }
        }
        for (const safeUrl of httpsSafeCleanUrls) {
          pushAttempt('native', safeUrl, true);
        }
        if (!hasBackend) {
          for (const corsUrl of corsProxyUrls) {
            pushAttempt('native', corsUrl, false);
          }
        }
        pushAttempt('client-ffmpeg', cleanUrl);
      }
    } else if (isExplicitTsOrFlv) {
      if (isVodChannel) {
        // Priority 1 for VOD TS: try the corresponding .mp4 URL through proxy!
        const altMp4 = xtreamAltUrls.vodMp4Url || cleanUrl.replace(/\.ts(\?|$)/i, '.mp4$1');
        if (hasBackend) {
          pushAttempt('native', buildProxyUrl(normalizedChannel, userAgent, altMp4));
        }
        for (const safeMp4 of getHttpsSafeMediaUrls(altMp4, true)) {
          pushAttempt('native', safeMp4, true);
        }
        if (hasBackend) {
          pushAttempt('native', proxyUrl);
          pushAttempt('native', transcodeFullUrl);
        }
        if (mpegts.isSupported()) {
          if (hasBackend) pushAttempt('mpegts', proxyUrl);
          for (const safeUrl of httpsSafeCleanUrls) {
            pushAttempt('mpegts', safeUrl, true);
          }
        }
        for (const safeUrl of httpsSafeCleanUrls) {
          pushAttempt('native', safeUrl, true);
        }
        pushAttempt('client-ffmpeg', cleanUrl);
      } else {
        if (hasBackend && mpegts.isSupported()) {
          pushAttempt('mpegts', proxyUrl);
        }
        if (hasBackend && Hls.isSupported()) {
          if (xtreamHlsProxyUrl) {
            pushAttempt('hls', xtreamHlsProxyUrl);
          }
          pushAttempt('hls', proxyUrl);
        }
        if (hasBackend) {
          pushAttempt('native', proxyUrl);
          pushAttempt('native', transcodeFullUrl);
        }
        if (mpegts.isSupported() && (!hasBackend || !isPageHttps)) {
          for (const safeUrl of httpsSafeCleanUrls) {
            pushAttempt('mpegts', safeUrl, true);
          }
        }
        if (Hls.isSupported() && xtreamAltUrls.hlsUrl && !mustUseProxyOnly) {
          for (const safeHlsUrl of getHttpsSafeMediaUrls(xtreamAltUrls.hlsUrl)) {
            pushAttempt('hls', safeHlsUrl, true);
          }
        }
        for (const safeUrl of httpsSafeCleanUrls) {
          pushAttempt('native', safeUrl, true);
        }
        pushAttempt('client-ffmpeg', cleanUrl);
      }
    } else if (isMkvAviOrLegacyContainer) {
      // 1. Browsers natively support MP4 (H.264+AAC) but reject Matroska (.mkv) container.
      // In Xtream Codes & IPTV VOD panels, the exact same movie is served on the .mp4 path!
      // Priority #1: Proxy to .mp4 version so it plays instantly with hardware acceleration!
      const altMp4 = xtreamAltUrls.vodMp4Url || cleanUrl.replace(/\.(mkv|avi|wmv)(\?|$)/i, '.mp4$1');
      if (hasBackend) {
        pushAttempt('native', buildProxyUrl(normalizedChannel, userAgent, altMp4));
      }
      for (const safeMp4 of getHttpsSafeMediaUrls(altMp4, true)) {
        pushAttempt('native', safeMp4, true);
      }
      // 2. Proxy to original URL (with Range header support)
      if (hasBackend) {
        pushAttempt('native', proxyUrl);
      }
      // 3. Backend FFmpeg transcode (for when video codec is HEVC or DTS/AC3)
      if (hasBackend) {
        pushAttempt('native', transcodeFullUrl);
      }
      if (!mustUseProxyOnly) {
        for (const safeUrl of httpsSafeCleanUrls) {
          pushAttempt('native', safeUrl, true);
        }
      }
      // 4. Client-side FFmpeg WASM converts in browser
      pushAttempt('client-ffmpeg', cleanUrl);
    } else if (isVodChannel || isExplicitNativeVod) {
      // Standard VOD (.mp4, .webm, .mov, /movie/, /series/, /vod/, Archive.org, Google Drive, Dropbox, Pixeldrain):
      if (hasBackend) {
        // Backend /api/proxy solves CORS, Referer, User-Agent, Mixed Content, and Range seeking!
        pushAttempt('native', proxyUrl);
        if (xtreamAltUrls.vodMp4Url && xtreamAltUrls.vodMp4Url !== cleanUrl) {
          pushAttempt('native', buildProxyUrl(normalizedChannel, userAgent, xtreamAltUrls.vodMp4Url));
        }
        for (const safeUrl of httpsSafeCleanUrls) {
          pushAttempt('native', safeUrl, true);
        }
        // FFmpeg /api/transcode converts any unsupported codec (HEVC, MPEG-4, MPEG-2, AC3) to browser H.264 + AAC
        pushAttempt('native', transcodeFullUrl);
        if (xtreamAltUrls.vodMkvUrl && xtreamAltUrls.vodMkvUrl !== cleanUrl) {
          pushAttempt('native', buildProxyUrl(normalizedChannel, userAgent, xtreamAltUrls.vodMkvUrl));
        }
      } else {
        for (const safeUrl of httpsSafeCleanUrls) {
          pushAttempt('native', safeUrl, true);
        }
        if (xtreamAltUrls.vodMp4Url && xtreamAltUrls.vodMp4Url !== cleanUrl) {
          for (const safeMp4 of getHttpsSafeMediaUrls(xtreamAltUrls.vodMp4Url, true)) {
            pushAttempt('native', safeMp4, true);
          }
        }
        if (xtreamAltUrls.vodMkvUrl && xtreamAltUrls.vodMkvUrl !== cleanUrl) {
          for (const safeMkv of getHttpsSafeMediaUrls(xtreamAltUrls.vodMkvUrl, true)) {
            pushAttempt('native', safeMkv, true);
          }
        }
      }
      if (Hls.isSupported() && /\.m3u8(\?|$)/i.test(cleanUrl)) {
        if (hasBackend) {
          pushAttempt('hls', proxyUrl);
        }
        for (const safeUrl of getHttpsSafeMediaUrls(cleanUrl, false)) {
          pushAttempt('hls', safeUrl, true);
        }
      }
      pushAttempt('client-ffmpeg', cleanUrl);
    } else {
      // Extensionless live IPTV URLs (e.g. Xtream Codes /live/user/pass/123, /user/pass/123, Stalker play/live.php?mac=...)
      if (normalizedChannel.xtreamParams?.streamType === 'live') {
        if (hasBackend && xtreamHlsProxyUrl && Hls.isSupported()) {
          pushAttempt('hls', xtreamHlsProxyUrl);
        }
        if (hasBackend && xtreamTsProxyUrl && mpegts.isSupported()) {
          pushAttempt('mpegts', xtreamTsProxyUrl);
        }
        if (hasBackend && Hls.isSupported()) {
          pushAttempt('hls', proxyUrl);
        }
        if (hasBackend && mpegts.isSupported()) {
          pushAttempt('mpegts', proxyUrl);
        }
        if (Hls.isSupported() && xtreamAltUrls.hlsUrl) {
          for (const safeHls of getHttpsSafeMediaUrls(xtreamAltUrls.hlsUrl)) {
            pushAttempt('hls', safeHls, true);
          }
          if (!hasBackend) {
            for (const corsUrl of buildPublicCorsProxyUrls(xtreamAltUrls.hlsUrl)) {
              pushAttempt('hls', corsUrl, false);
            }
          }
        }
        if (mpegts.isSupported() && (!hasBackend || !isPageHttps)) {
          if (xtreamAltUrls.tsUrl) {
            for (const safeTs of getHttpsSafeMediaUrls(xtreamAltUrls.tsUrl)) {
              pushAttempt('mpegts', safeTs, true);
            }
          }
        }
        if (hasBackend) {
          pushAttempt('native', proxyUrl);
          pushAttempt('native', transcodeFullUrl);
        }
      } else {
        if (hasBackend && mustUseProxyOnly && Hls.isSupported()) {
          pushAttempt('hls', proxyUrl);
        }
        if (hasBackend && mustUseProxyOnly && mpegts.isSupported()) {
          pushAttempt('mpegts', proxyUrl);
        }
        if (Hls.isSupported()) {
          for (const safeUrl of httpsSafeCleanUrls) {
            pushAttempt('hls', safeUrl, true);
          }
        }
        if (hasBackend && !mustUseProxyOnly && Hls.isSupported()) {
          pushAttempt('hls', proxyUrl);
        }
        if (hasBackend && !mustUseProxyOnly && mpegts.isSupported()) {
          pushAttempt('mpegts', proxyUrl);
        }
        if (!hasBackend && Hls.isSupported()) {
          for (const corsUrl of corsProxyUrls) {
            pushAttempt('hls', corsUrl, false);
          }
        }
        if (mpegts.isSupported() && (!hasBackend || !isPageHttps)) {
          for (const safeUrl of httpsSafeCleanUrls) {
            pushAttempt('mpegts', safeUrl, true);
          }
        }
        if (hasBackend) {
          pushAttempt('native', proxyUrl);
          pushAttempt('native', transcodeFullUrl);
        }
      }
      for (const safeUrl of httpsSafeCleanUrls) {
        pushAttempt('native', safeUrl, true);
      }
      pushAttempt('client-ffmpeg', cleanUrl);
    }

    const applyKnownDuration = (durSec: number | null | undefined) => {
      if (!isMounted || !durSec || !Number.isFinite(durSec) || durSec <= 0) return;
      const bestDur = Math.max(knownVodDurationRef.current || 0, durSec);
      knownVodDurationRef.current = bestDur;
      setIsLiveStream(false);
      setDuration(bestDur);
    };

    const probeController = new AbortController();
    const requestProbeDuration = () => {
      if (!isMounted || (knownVodDurationRef.current && knownVodDurationRef.current > 0)) {
        return;
      }
      // 1. Check cached client-side duration (e.g. from Archive.org metadata)
      for (const u of resolvedVodCandidates) {
        const cached = getCachedClientVodDuration(u);
        if (cached && cached > 0) {
          applyKnownDuration(cached);
          return;
        }
      }
      // 2. If backend /api/probe is available, query it
      if (canUseBackendProxy()) {
        fetch(buildProbeUrl(normalizedChannel, userAgent), {
          signal: probeController.signal,
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((data: { duration?: number | null } | null) => {
            if (data?.duration && Number.isFinite(data.duration) && data.duration > 0) {
              applyKnownDuration(data.duration);
            }
          })
          .catch(() => {});
      }
      // 3. Also run client-side duration probe (works on static GitHub Pages without /api/probe!)
      if (isVodChannel) {
        probeClientSideVodDuration(
          normalizedChannel,
          resolvedVodCandidates,
          probeController.signal
        )
          .then((dur) => {
            if (dur && dur > 0) {
              applyKnownDuration(dur);
            }
          })
          .catch(() => {});
      }
    };

    const safePlayVideo = () => {
      if (userPausedRef.current) return;
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise.catch((err: unknown) => {
          if (!isMounted) return;
          const errName = (err as { name?: string })?.name || '';
          if (errName === 'NotAllowedError') {
            video.muted = true;
            video.play().catch(() => {});
          }
        });
      }
    };

    /**
     * Runs client-side WebAssembly FFmpeg transcoding (H.264 + AAC MP4) for static hosts like GitHub Pages
     * when a video uses an unsupported codec (HEVC/MPEG-4 Part 2/MPEG-2) or non-native container.
     */
    const startClientFfmpegAt = (targetSec: number) => {
      if (!isMounted) return;
      const safeSec = Math.max(0, Math.floor(targetSec));
      clearTimers();

      const clientIdx = attempts.findIndex((a) => a.mode === 'client-ffmpeg');
      if (clientIdx !== -1) {
        currentAttemptIdx = clientIdx;
      }

      isClientFfmpegActive = true;
      seekBaseOffsetRef.current = safeSec;
      lastKnownTimestamp = safeSec;
      pendingInitialSeekSec = 0;

      attemptToken += 1;
      const myToken = attemptToken;
      recoveredMediaError = false;
      hasPlaybackStarted = false;
      isTransitioning = true;

      setHasError(false);
      setIsLoading(true);
      if (!userPausedRef.current) {
        setIsPlaying(true);
      }

      destroyPlayers();
      video.removeAttribute('src');
      video.load();

      const scheduleNextPrefetch = (
        nextStartSec: number,
        totalDur: number | null,
        controller: AbortController
      ) => {
        if (!isMounted || controller.signal.aborted) return;
        if (totalDur && nextStartSec >= totalDur - 2) {
          nextClientSegment = null;
          return;
        }
        const segLen = 32;
        const p = transcodeChannelClientSide(
          normalizedChannel,
          resolvedVodCandidates,
          nextStartSec,
          segLen,
          totalDur,
          controller.signal
        ).catch(() => null);
        nextClientSegment = { startSec: nextStartSec, promise: p };
      };

      const applyTranscodedSegment = (
        res: ClientTranscodeResult,
        controller: AbortController
      ) => {
        if (!isMounted || myToken !== attemptToken) {
          try {
            URL.revokeObjectURL(res.blobUrl);
          } catch {
            // ignore
          }
          return;
        }
        isTransitioning = false;
        revokeClientBlob();
        activeClientBlobUrl = res.blobUrl;
        currentClientSegmentDuration = res.segmentDurationSec;
        seekBaseOffsetRef.current = res.segmentStartSec;

        if (res.durationSec && res.durationSec > 0) {
          applyKnownDuration(res.durationSec);
        }

        video.src = res.blobUrl;
        video.load();
        safePlayVideo();

        if (res.hasMoreSegments) {
          scheduleNextPrefetch(
            res.segmentStartSec + res.segmentDurationSec,
            res.durationSec || knownVodDurationRef.current,
            controller
          );
        } else {
          nextClientSegment = null;
        }
      };

      // Check if we already prefetched the matching next segment
      if (
        nextClientSegment &&
        Math.abs(nextClientSegment.startSec - safeSec) <= 3 &&
        clientFfmpegAbort &&
        !clientFfmpegAbort.signal.aborted
      ) {
        const activeCtrl = clientFfmpegAbort;
        const prefetchedPromise = nextClientSegment.promise;
        nextClientSegment = null;
        prefetchedPromise.then((res) => {
          if (!isMounted || myToken !== attemptToken) return;
          if (res) {
            applyTranscodedSegment(res, activeCtrl);
          } else {
            // Prefetch failed; run fresh transcode at safeSec
            nextClientSegment = null;
            startClientFfmpegAt(safeSec);
          }
        });
        return;
      }

      abortClientFfmpeg();
      const ctrl = new AbortController();
      clientFfmpegAbort = ctrl;

      // Guard with a stallTimer so Client-Side FFmpeg never leaves the player stuck on loading indefinitely
      stallTimer = window.setTimeout(() => {
        if (!isMounted || myToken !== attemptToken || hasPlaybackStarted) return;
        ctrl.abort();
        isTransitioning = false;
        isClientFfmpegActive = false;
        advanceToNextAttempt(myToken, safeSec);
      }, 24000);

      transcodeChannelClientSide(
        normalizedChannel,
        resolvedVodCandidates,
        safeSec,
        20,
        knownVodDurationRef.current,
        ctrl.signal
      )
        .then((res) => {
          applyTranscodedSegment(res, ctrl);
        })
        .catch(() => {
          if (!isMounted || myToken !== attemptToken || ctrl.signal.aborted) return;
          isTransitioning = false;
          isClientFfmpegActive = false;
          advanceToNextAttempt(myToken, safeSec);
        });
    };

    /**
     * Reconnects or seeks the active stream on static hosts (GitHub Pages) where /api/transcode is unavailable,
     * OR switches to server-side FFmpeg /api/transcode when backend proxy is available.
     */
    const startTranscodeAt = (targetSec: number) => {
      if (!isMounted) return;
      const safeSec = Math.max(0, Math.floor(targetSec));

      // If client-side FFmpeg WASM is already active, seek/resume via client-side FFmpeg WASM!
      if (isClientFfmpegActive) {
        startClientFfmpegAt(safeSec);
        return;
      }

      // If backend transcode server is unavailable (e.g. GitHub Pages static deployment),
      // perform a full client-side stream reload & resume at safeSec so both seek and auto-reconnect work!
      if (!canUseBackendProxy()) {
        clearTimers();
        seekBaseOffsetRef.current = 0;
        lastKnownTimestamp = safeSec;
        pendingInitialSeekSec = safeSec > 1 ? safeSec : 0;
        setHasError(false);
        setIsLoading(true);
        if (!userPausedRef.current) {
          setIsPlaying(true);
        }

        // If the device is currently offline, wait and retry automatically without failing attempts
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          reconnectTimer = window.setTimeout(() => {
            if (isMounted) startTranscodeAt(safeSec);
          }, 2500);
          return;
        }

        const activeAttempt = attempts[currentAttemptIdx];
        if (activeAttempt?.mode === 'hls' && hls && reconnectRetries <= 2) {
          const tokenNow = attemptToken;
          try {
            hls.stopLoad();
            hls.startLoad(safeSec > 1 ? safeSec : -1);
            if (safeSec > 1) {
              video.currentTime = safeSec;
            }
            safePlayVideo();
            stallTimer = window.setTimeout(() => {
              if (!isMounted || tokenNow !== attemptToken) return;
              if (video.readyState < 3 || video.paused) {
                runAttempt(currentAttemptIdx, safeSec, true);
              }
            }, 6500);
            return;
          } catch {
            // Fall through to full runAttempt reload
          }
        }

        // If currently on an .mkv/.avi/.ts attempt and seeking/reconnecting at safeSec > 1,
        // prefer any .mp4 variant in attempts since .mp4 supports fast HTTP Range seeking in browsers
        let targetIdx = currentAttemptIdx < attempts.length ? currentAttemptIdx : 0;
        if (
          safeSec > 1 &&
          activeAttempt &&
          /\.(mkv|avi|ts)(\?|$|#)/i.test(activeAttempt.url)
        ) {
          const mp4Idx = attempts.findIndex(
            (a) =>
              a.mode === 'native' &&
              !a.url.includes('/api/') &&
              /\.(mp4|webm|m4v)(\?|$|#)/i.test(a.url)
          );
          if (mp4Idx !== -1) {
            targetIdx = mp4Idx;
          } else {
            // No .mp4 alternative exists and native .mkv/.avi/.ts cannot seek — use Client-Side FFmpeg WASM!
            startClientFfmpegAt(safeSec);
            return;
          }
        }

        runAttempt(targetIdx, safeSec, true);
        return;
      }

      clearTimers();
      seekBaseOffsetRef.current = safeSec;
      lastKnownTimestamp = safeSec;
      pendingInitialSeekSec = 0;

      const transcodeIdx = attempts.findIndex((a) => a.url.includes('/api/transcode'));
      if (transcodeIdx !== -1) {
        currentAttemptIdx = transcodeIdx;
      }

      attemptToken += 1;
      const myToken = attemptToken;
      recoveredMediaError = false;
      hasPlaybackStarted = false;
      isTransitioning = true;

      setHasError(false);
      setIsLoading(true);
      setIsPlaying(true);
      userPausedRef.current = false;

      destroyPlayers();
      video.removeAttribute('src');
      video.load();

      transitionTimer = window.setTimeout(() => {
        if (!isMounted || myToken !== attemptToken) return;
        isTransitioning = false;

        stallTimer = window.setTimeout(() => {
          if (!isMounted || myToken !== attemptToken || hasPlaybackStarted) return;
          // If transcode stalled, try direct/native fallback if available
          const directFallbackIdx = attempts.findIndex(
            (a) => a.isDirect && a.mode === 'native'
          );
          if (directFallbackIdx !== -1 && reconnectRetries >= 1) {
            runAttempt(directFallbackIdx, safeSec, true);
            return;
          }
          if (reconnectRetries < 3) {
            reconnectRetries += 1;
            startTranscodeAt(safeSec);
          } else {
            triggerStreamError();
          }
        }, 18000);

        const seekParam = !isLiveStream && safeSec > 0 ? `&ss=${safeSec}` : '';
        video.src = `${transcodeFullUrl}${seekParam}&_rc=${Date.now()}`;
        video.load();
        safePlayVideo();

        // Also refresh probe duration once FFmpeg has parsed the input header
        window.setTimeout(() => {
          if (isMounted && myToken === attemptToken) {
            requestProbeDuration();
          }
        }, 1500);
      }, 45);
    };

    const advanceToNextAttempt = (fromToken: number, resumeSec = lastKnownTimestamp) => {
      if (!isMounted || fromToken !== attemptToken) return;
      let nextIdx = currentAttemptIdx + 1;
      // Skip backend /api/proxy and /api/transcode attempts if backend proxy was probed and found unreachable
      while (
        nextIdx < attempts.length &&
        !canUseBackendProxy() &&
        (attempts[nextIdx].url.includes('/api/proxy') ||
          attempts[nextIdx].url.includes('/api/transcode') ||
          attempts[nextIdx].url.startsWith('/api/'))
      ) {
        nextIdx += 1;
      }
      runAttempt(nextIdx, resumeSec);
    };

    const jumpToTranscodeOrNext = (fromToken: number) => {
      if (!isMounted || fromToken !== attemptToken) return;
      if (!canUseBackendProxy()) {
        // On static hosts (GitHub Pages), if audio is playing without video (e.g. HEVC / mp4v / MPEG-2),
        // check if there is another native .mp4 derivative (e.g. Archive.org .ia.mp4); otherwise launch Client-Side FFmpeg WASM!
        const nextMp4Idx = attempts.findIndex(
          (a, i) =>
            i > currentAttemptIdx &&
            a.mode === 'native' &&
            !a.url.includes('/api/') &&
            /\.(mp4|webm|m4v)(\?|$|#)/i.test(a.url)
        );
        if (nextMp4Idx !== -1) {
          runAttempt(nextMp4Idx, lastKnownTimestamp);
          return;
        }
        startClientFfmpegAt(lastKnownTimestamp);
        return;
      }
      // On backend: FFmpeg transcode immediately converts any unsupported codec (HEVC, MPEG-2, VC-1, VP9, DTS, AC3) to H.264 + AAC
      const currentPos =
        isLiveStream
          ? 0
          : lastKnownTimestamp > 0.5
          ? lastKnownTimestamp
          : video && !isNaN(video.currentTime) && video.currentTime > 0.05
          ? video.currentTime
          : 0;
      startTranscodeAt(currentPos);
    };

    const runAttempt = (idx: number, resumeAtSec = 0, isReconnectReload = false) => {
      if (!isMounted) return;
      clearTimers();

      if (idx >= attempts.length) {
        // Ultimate FFmpeg Transcode Auto-Fallback:
        // If all standard MSE/native attempts failed and FFmpeg transcode was not yet attempted,
        // automatically route the stream through FFmpeg (H.264 + AAC) before giving up!
        if (canUseBackendProxy() && transcodeFullUrl) {
          const hasTriedTranscode = attempts.some(
            (a, aIdx) => aIdx <= currentAttemptIdx && a.url.includes('/api/transcode')
          );
          if (!hasTriedTranscode) {
            attempts.push({ mode: 'native', url: transcodeFullUrl, isDirect: false });
            runAttempt(attempts.length - 1, resumeAtSec);
            return;
          }
        }

        // Before giving up permanently when playback had already started or when device is offline,
        // retry the first valid attempt so temporary Wi-Fi / mobile data drops auto-recover!
        if (
          (typeof navigator !== 'undefined' && navigator.onLine === false) ||
          ((hasPlaybackStarted || lastKnownTimestamp > 1) && reconnectRetries < 6)
        ) {
          reconnectRetries += 1;
          let firstValidIdx = 0;
          while (
            firstValidIdx < attempts.length &&
            !canUseBackendProxy() &&
            (attempts[firstValidIdx].url.includes('/api/proxy') ||
              attempts[firstValidIdx].url.includes('/api/transcode') ||
              attempts[firstValidIdx].url.startsWith('/api/'))
          ) {
            firstValidIdx += 1;
          }
          if (firstValidIdx < attempts.length) {
            reconnectTimer = window.setTimeout(() => {
              if (isMounted) {
                runAttempt(firstValidIdx, lastKnownTimestamp, true);
              }
            }, 2200);
            return;
          }
        }
        triggerStreamError();
        return;
      }

      currentAttemptIdx = idx;
      attemptToken += 1;
      const myToken = attemptToken;
      const attempt = attempts[idx];
      recoveredMediaError = false;
      hasPlaybackStarted = false;
      pendingInitialSeekSec = resumeAtSec > 1 ? resumeAtSec : 0;
      if (resumeAtSec > 1) {
        lastKnownTimestamp = resumeAtSec;
      }
      let preStartNetworkErrors = 0;

      if (attempt.mode === 'client-ffmpeg') {
        startClientFfmpegAt(pendingInitialSeekSec || lastKnownTimestamp);
        return;
      }

      if (attempt.url.includes('/api/transcode') && pendingInitialSeekSec > 0) {
        startTranscodeAt(pendingInitialSeekSec);
        return;
      }

      isClientFfmpegActive = false;
      abortClientFfmpeg();
      revokeClientBlob();
      seekBaseOffsetRef.current = 0;

      // Guard against asynchronous error events fired by detaching previous media sources
      isTransitioning = true;
      destroyPlayers();
      video.removeAttribute('src');
      video.load();

      transitionTimer = window.setTimeout(() => {
        if (!isMounted || myToken !== attemptToken) return;
        isTransitioning = false;

        // Allow 9s for direct VOD attempts and 7.5s for live direct attempts before trying proxy/fallback
        const timeoutMs = attempt.isDirect
          ? isVodChannel
            ? 9000
            : 7500
          : attempt.url.includes('/api/transcode')
          ? 18000
          : 11000;
        stallTimer = window.setTimeout(() => {
          if (!isMounted || myToken !== attemptToken || hasPlaybackStarted) return;
          advanceToNextAttempt(myToken, pendingInitialSeekSec || lastKnownTimestamp);
        }, timeoutMs);

        if (attempt.mode === 'hls' && Hls.isSupported()) {
          hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            backBufferLength: 60,
            startPosition: pendingInitialSeekSec > 0 ? pendingInitialSeekSec : -1,
            manifestLoadingTimeOut: attempt.isDirect ? 7500 : 10000,
            manifestLoadingMaxRetry: attempt.isDirect ? 1 : 2,
            levelLoadingTimeOut: attempt.isDirect ? 7500 : 10000,
            levelLoadingMaxRetry: attempt.isDirect ? 1 : 2,
            fragLoadingTimeOut: attempt.isDirect ? 9000 : 12000,
            fragLoadingMaxRetry: attempt.isDirect ? 2 : 3,
            loader: createSmartHlsLoaderClass(normalizedChannel, userAgent),
          });
          hls.loadSource(attempt.url);
          hls.attachMedia(video);

          hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
            if (!isMounted || myToken !== attemptToken) return;
            const levels = Array.isArray(data?.levels) ? data.levels : [];
            const isLevelUnsupportedOrAudioOnly = (lvl: {
              videoCodec?: string;
              width?: number;
              height?: number;
              attrs?: { CODECS?: string; RESOLUTION?: string };
            }) => {
              const codecs = `${lvl.videoCodec || ''} ${lvl.attrs?.CODECS || ''}`.toLowerCase();
              if (/hev1|hvc1|hevc|mp4v|mpeg2/i.test(codecs)) return true;
              // Detect audio-only variant streams (e.g. mp4a.40.2 with no avc1/vp9/av01 and no resolution)
              const hasAudioCodec = /mp4a|aac|ac-3|ec-3|opus|vorbis|mp3/i.test(codecs);
              const hasVideoCodec = /avc1|vp09|vp9|av01|theora/i.test(codecs);
              const hasDimensions =
                (lvl.width && lvl.width > 0) ||
                (lvl.height && lvl.height > 0) ||
                Boolean(lvl.attrs?.RESOLUTION);
              if (hasAudioCodec && !hasVideoCodec && !hasDimensions && levels.length > 1) {
                return true;
              }
              return false;
            };

            if (levels.length > 0 && levels.every(isLevelUnsupportedOrAudioOnly)) {
              jumpToTranscodeOrNext(myToken);
              return;
            }

            // If some levels are H.264/AVC and others are HEVC or audio-only, lock to the best H.264 video level
            // so the browser never shows a black screen with audio only!
            if (hls && levels.length > 1 && levels.some(isLevelUnsupportedOrAudioOnly)) {
              const supportedIndices: number[] = [];
              levels.forEach((lvl, idx) => {
                if (!isLevelUnsupportedOrAudioOnly(lvl)) {
                  supportedIndices.push(idx);
                }
              });
              if (supportedIndices.length > 0) {
                const bestSupportedIdx = supportedIndices[supportedIndices.length - 1];
                hls.currentLevel = bestSupportedIdx;
                hls.loadLevel = bestSupportedIdx;
              }
            }

            if (pendingInitialSeekSec > 0) {
              try {
                video.currentTime = pendingInitialSeekSec;
              } catch {
                // ignore
              }
              pendingInitialSeekSec = 0;
            }
            safePlayVideo();
          });

          hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
            if (!isMounted || myToken !== attemptToken) return;
            const live = Boolean(data.details.live);
            setIsLiveStream(live);
            if (
              !live &&
              Number.isFinite(data.details.totalduration) &&
              data.details.totalduration > 0
            ) {
              applyKnownDuration(data.details.totalduration);
            }
          });

          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!isMounted || myToken !== attemptToken) return;
            // Fast fallback if network/CORS/segment error happens before playback has even started
            if (!hasPlaybackStarted && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              preStartNetworkErrors += 1;
              if (attempt.isDirect || data.fatal || preStartNetworkErrors >= 2) {
                advanceToNextAttempt(myToken, pendingInitialSeekSec || lastKnownTimestamp);
                return;
              }
            }
            if (data.fatal) {
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMediaError) {
                recoveredMediaError = true;
                hls?.recoverMediaError();
              } else if ((hasPlaybackStarted || lastKnownTimestamp > 1) && reconnectRetries < 6) {
                reconnectRetries += 1;
                const savedTime = lastKnownTimestamp;
                setHasError(false);
                setIsLoading(true);
                if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
                reconnectTimer = window.setTimeout(() => {
                  if (!isMounted || myToken !== attemptToken) return;
                  if (attempt.isDirect && canUseBackendProxy()) {
                    const proxyHlsIdx = attempts.findIndex(
                      (a, i) => i > currentAttemptIdx && a.mode === 'hls' && !a.isDirect
                    );
                    if (proxyHlsIdx !== -1) {
                      runAttempt(proxyHlsIdx, savedTime);
                      return;
                    }
                  }
                  if (reconnectRetries <= 3 && hls) {
                    hls.startLoad(savedTime > 1 ? savedTime : -1);
                    safePlayVideo();
                  } else {
                    startTranscodeAt(savedTime);
                  }
                }, 1200);
              } else {
                advanceToNextAttempt(myToken, lastKnownTimestamp);
              }
            }
          });
        } else if (attempt.mode === 'mpegts' && mpegts.isSupported()) {
          const isFlv = /\.flv(\?|$|#|&)/i.test(cleanUrl);
          try {
            const m = mpegts as unknown as { LoggingControl?: Record<string, boolean> };
            if (m?.LoggingControl) {
              m.LoggingControl.enableAll = false;
              m.LoggingControl.enableError = false;
              m.LoggingControl.enableWarn = false;
            }
          } catch {
            // ignore
          }

          mpegtsPlayer = mpegts.createPlayer(
            {
              type: isFlv ? 'flv' : 'mpegts',
              isLive: !isVodChannel,
              url: attempt.url,
            },
            {
              enableWorker: false, // Prevents async worker race conditions
              enableStashBuffer: isVodChannel,
              stashInitialSize: isVodChannel ? 384 * 1024 : 128 * 1024,
              lazyLoad: false,
              autoCleanupSourceBuffer: !isVodChannel,
              liveBufferLatencyChasing: false, // Critical: Disable latency chasing so streams never speed up into fast forward
              liveBufferLatencyMaxLatency: 0,
              liveBufferLatencyMinRemain: 0,
            }
          );
          mpegtsPlayer.attachMediaElement(video);
          mpegtsPlayer.load();
          safePlayVideo();

          mpegtsPlayer.on(mpegts.Events.ERROR, () => {
            if (!isMounted || myToken !== attemptToken) return;
            try {
              mpegtsPlayer?.pause();
              mpegtsPlayer?.unload();
              mpegtsPlayer?.detachMediaElement();
              mpegtsPlayer?.destroy();
            } catch {
              // ignore
            }
            mpegtsPlayer = null;

            if (hasPlaybackStarted && reconnectRetries < 2) {
              reconnectRetries += 1;
              setIsLoading(true);
              reconnectTimer = window.setTimeout(() => {
                if (!isMounted || myToken !== attemptToken) return;
                runAttempt(currentAttemptIdx, lastKnownTimestamp, true);
              }, 1000);
              return;
            }
            destroyPlayers();
            advanceToNextAttempt(myToken, lastKnownTimestamp);
          });
        } else {
          // Native HTML5 <video> playback:
          // Use W3C Media Fragment (#t=seconds) when resuming/reconnecting at an offset so the browser
          // opens a fresh HTTP Range request without corrupting CORS proxy URLs or signed query strings!
          const cleanBaseUrl = attempt.url.split('#')[0];
          const srcWithFragment =
            pendingInitialSeekSec > 1
              ? `${cleanBaseUrl}#t=${Math.floor(pendingInitialSeekSec)}`
              : isReconnectReload && attempt.url.includes('/api/proxy')
              ? `${cleanBaseUrl}${cleanBaseUrl.includes('?') ? '&' : '?'}_rc=${Date.now()}`
              : cleanBaseUrl;
          video.src = srcWithFragment;
          video.load();
          if (attempt.url.includes('/api/transcode')) {
            window.setTimeout(() => {
              if (isMounted && myToken === attemptToken) {
                requestProbeDuration();
              }
            }, 1200);
          }
          safePlayVideo();
        }
      }, 45);
    };

    const performSeek = (targetSec: number) => {
      if (!isMounted) return;
      clearSeekFallbackTimer();
      clearWaitingWatchdog();

      const safeTarget = Math.max(0, targetSec);
      lastKnownTimestamp = safeTarget;
      reconnectRetries = 0;
      userPausedRef.current = false;
      setHasError(false);
      setIsPlaying(true);

      const activeAttempt = attempts[currentAttemptIdx];
      const currentSrc = video.src || activeAttempt?.url || '';
      const isCurrentlyTranscoding =
        isClientFfmpegActive ||
        currentSrc.includes('/api/transcode') ||
        Boolean(activeAttempt?.url.includes('/api/transcode'));

      // 1. If already playing via FFmpeg transcode (server or client WASM), seek via FFmpeg
      if (isCurrentlyTranscoding) {
        startTranscodeAt(safeTarget);
        return;
      }

      // 2. If playing via mpegts.js, delegate to startTranscodeAt (which handles both backend and static hosts)
      if (activeAttempt?.mode === 'mpegts' && mpegtsPlayer) {
        startTranscodeAt(safeTarget);
        return;
      }

      // 3. If playing via Hls.js on a VOD stream, seek natively within Hls.js first
      if (activeAttempt?.mode === 'hls' && hls) {
        seekBaseOffsetRef.current = 0;
        setIsLoading(true);
        try {
          video.currentTime = safeTarget;
          hls.startLoad(safeTarget);
        } catch {
          startTranscodeAt(safeTarget);
          return;
        }
        safePlayVideo();
        const tokenAtSeek = attemptToken;
        seekFallbackTimer = window.setTimeout(() => {
          seekFallbackTimer = null;
          if (!isMounted || tokenAtSeek !== attemptToken) return;
          if (Math.abs(video.currentTime - safeTarget) > 18 && !video.seeking) {
            startTranscodeAt(safeTarget);
          }
        }, 6000);
        return;
      }

      // 4. Native HTML5 <video> playback (/api/proxy or direct MP4/WebM/MKV on GitHub Pages)
      // If video has not loaded metadata yet or is in an error state when user seeks,
      // store pendingInitialSeekSec and reload/resume at safeTarget!
      if (video.error || video.readyState < 1 || !video.src) {
        pendingInitialSeekSec = safeTarget;
        startTranscodeAt(safeTarget);
        return;
      }

      seekBaseOffsetRef.current = 0;
      pendingInitialSeekSec = 0;

      // Check if safeTarget is already inside the browser's buffered time ranges
      let isTargetBuffered = false;
      try {
        for (let i = 0; i < video.buffered.length; i++) {
          if (
            safeTarget >= video.buffered.start(i) &&
            safeTarget <= video.buffered.end(i)
          ) {
            isTargetBuffered = true;
            break;
          }
        }
      } catch {
        // ignore
      }

      if (!isTargetBuffered) {
        setIsLoading(true);
      }

      try {
        video.currentTime = safeTarget;
      } catch {
        startTranscodeAt(safeTarget);
        return;
      }
      safePlayVideo();

      const tokenAtSeek = attemptToken;
      seekFallbackTimer = window.setTimeout(() => {
        seekFallbackTimer = null;
        if (!isMounted || tokenAtSeek !== attemptToken) return;
        const currentSrcNow = video.src || '';
        if (currentSrcNow.includes('/api/transcode')) return;

        // If the browser snapped currentTime back (e.g. MKV without Cues or upstream ignored Range header),
        // switch to an .mp4 variant (on GitHub Pages) or /api/transcode (on backend) at safeTarget!
        if (!video.seeking && Math.abs(video.currentTime - safeTarget) > 14) {
          startTranscodeAt(safeTarget);
          return;
        }

        // If still stuck seeking after 8.5s, reload stream at safeTarget
        if (video.seeking) {
          seekFallbackTimer = window.setTimeout(() => {
            seekFallbackTimer = null;
            if (!isMounted || tokenAtSeek !== attemptToken) return;
            if (video.seeking || Math.abs(video.currentTime - safeTarget) > 14) {
              startTranscodeAt(safeTarget);
            }
          }, 6000);
        }
      }, 2500);
    };

    playerControlRef.current = { seekTo: performSeek };

    const confirmOrWatchVideoTrack = () => {
      if (!isMounted || isTransitioning) return;
      const activeAttempt = attempts[currentAttemptIdx];
      const currentSrc = video.src || activeAttempt?.url || '';
      const isTranscodeAttempt =
        isClientFfmpegActive ||
        currentSrc.includes('/api/transcode') ||
        Boolean(activeAttempt?.url.includes('/api/transcode'));
      const isStreamingEngine =
        activeAttempt?.mode === 'hls' || activeAttempt?.mode === 'mpegts';
      const hasVideoDimensions = video.videoWidth > 0 && video.videoHeight > 0;
      const isActivelyAdvancing = !video.paused && (video.currentTime > 0.05 || video.readyState >= 2);
      const isEnginePlaying =
        isStreamingEngine && (hasVideoDimensions || video.currentTime > 0.1 || video.readyState >= 3);

      if (hasVideoDimensions || isTranscodeAttempt || isEnginePlaying || (isActivelyAdvancing && hasVideoDimensions)) {
        hasPlaybackStarted = true;
        reconnectRetries = 0;
        clearWaitingWatchdog();
        if (stallTimer !== null) {
          window.clearTimeout(stallTimer);
          stallTimer = null;
        }
        if (hasVideoDimensions && noVideoTimer !== null) {
          window.clearTimeout(noVideoTimer);
          noVideoTimer = null;
        }
        setHasError(false);
        setIsLoading(false);
        if (!userPausedRef.current) {
          setIsPlaying(true);
        }

        // If a native or streaming container plays audio without video dimensions (e.g. HEVC/MPEG-4 Part 2/MPEG-2/VC-1),
        // switch to FFmpeg H.264 transcode so video track is decoded and rendered!
        if (!hasVideoDimensions && !isTranscodeAttempt && noVideoTimer === null) {
          const tokenAtStart = attemptToken;
          const waitMs = isVodChannel ? 4500 : 2000;
          noVideoTimer = window.setTimeout(() => {
            noVideoTimer = null;
            if (!isMounted || isTransitioning || tokenAtStart !== attemptToken) return;
            if (
              (video.videoWidth === 0 || video.videoHeight === 0) &&
              (!video.paused || video.readyState >= 1 || isStreamingEngine)
            ) {
              if (activeAttempt?.mode === 'hls' && hls && hls.levels && hls.levels.length > 1) {
                const altLevelIdx = hls.levels.findIndex(
                  (lvl, idx) =>
                    idx !== hls?.currentLevel &&
                    ((lvl.width && lvl.width > 0) ||
                      /avc1/i.test(`${lvl.videoCodec || ''} ${lvl.attrs?.CODECS || ''}`))
                );
                if (altLevelIdx !== -1) {
                  hls.currentLevel = altLevelIdx;
                  return;
                }
              }
              jumpToTranscodeOrNext(tokenAtStart);
            }
          }, waitMs);
        }
      }
    };

    const handlePlaying = () => {
      if (!isMounted || isTransitioning) return;
      if (video.playbackRate !== 1.0) {
        try {
          video.playbackRate = 1.0;
        } catch {
          // ignore
        }
      }
      clearWaitingWatchdog();
      confirmOrWatchVideoTrack();
    };

    const handleRateChange = () => {
      if (video && video.playbackRate !== 1.0) {
        try {
          video.playbackRate = 1.0;
        } catch {
          // ignore
        }
      }
    };

    const handleResize = () => {
      if (!isMounted || isTransitioning) return;
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        confirmOrWatchVideoTrack();
      }
    };

    const scheduleWaitingReconnectWatchdog = () => {
      if (!isMounted || isTransitioning || !hasPlaybackStarted || userPausedRef.current) return;
      clearWaitingWatchdog();
      const tokenAtWait = attemptToken;
      const timeAtWait = lastKnownTimestamp;
      waitingWatchdogTimer = window.setTimeout(() => {
        waitingWatchdogTimer = null;
        if (!isMounted || isTransitioning || tokenAtWait !== attemptToken || userPausedRef.current) {
          return;
        }
        const nowEffective = seekBaseOffsetRef.current + video.currentTime;
        const isStillStuck = Math.abs(nowEffective - timeAtWait) < 0.4 || video.readyState < 3;
        if (isStillStuck && reconnectRetries < 6) {
          reconnectRetries += 1;
          const savedTime = Math.max(timeAtWait, nowEffective);
          setHasError(false);
          setIsLoading(true);
          const activeAttempt = attempts[currentAttemptIdx];
          if (activeAttempt?.mode === 'hls' && hls && reconnectRetries <= 2) {
            hls.startLoad(savedTime > 1 ? savedTime : -1);
            safePlayVideo();
          } else if (savedTime > 1 || (knownVodDurationRef.current && knownVodDurationRef.current > 0)) {
            startTranscodeAt(savedTime);
          } else {
            runAttempt(currentAttemptIdx, 0);
          }
        }
      }, 9000);
    };

    const handleSeeked = () => {
      if (!isMounted || isTransitioning) return;
      clearSeekFallbackTimer();
      clearWaitingWatchdog();
      if (!video.seeking && video.readyState >= 2) {
        setIsLoading(false);
      }
      if (!userPausedRef.current) {
        safePlayVideo();
      }
    };

    const handleWaiting = () => {
      if (!isMounted || isTransitioning) return;
      setIsLoading(true);
      scheduleWaitingReconnectWatchdog();
    };

    const handleStalled = () => {
      if (!isMounted || isTransitioning || userPausedRef.current) return;
      // Browsers fire 'stalled' whenever network download pauses for ~3s, which happens normally
      // on direct VOD playback on GitHub Pages after a seek or burst buffer fills up!
      // Only enter loading/reconnect watchdog if playback is actually starved of frames.
      if (video.readyState < 3 || video.seeking) {
        setIsLoading(true);
        scheduleWaitingReconnectWatchdog();
      }
    };

    const handleEnded = () => {
      if (!isMounted || isTransitioning) return;
      const effectiveDur = knownVodDurationRef.current || duration || 0;
      const effectiveNow = seekBaseOffsetRef.current + video.currentTime;

      // When playing progressive segments via Client-Side WebAssembly FFmpeg,
      // seamlessly advance to the next segment as soon as the current segment finishes!
      if (isClientFfmpegActive) {
        const nextSegStart =
          seekBaseOffsetRef.current + (video.duration || currentClientSegmentDuration || 28);
        if (!effectiveDur || nextSegStart < effectiveDur - 1.5) {
          startClientFfmpegAt(nextSegStart);
        }
        return;
      }

      // If a VOD stream ended more than 15s before its actual duration,
      // the upstream connection dropped prematurely — automatically reconnect at effectiveNow!
      if (effectiveDur > 30 && effectiveNow < effectiveDur - 15 && reconnectRetries < 6) {
        reconnectRetries += 1;
        setHasError(false);
        setIsLoading(true);
        startTranscodeAt(effectiveNow);
      }
    };

    const handleVideoError = () => {
      if (!isMounted || isTransitioning) return;
      const activeAttempt = attempts[currentAttemptIdx];
      // When Hls.js or mpegts.js is active, safely handle and fallback
      if (activeAttempt?.mode === 'hls' && hls) return;
      if (activeAttempt?.mode === 'mpegts' && mpegtsPlayer) {
        destroyPlayers();
        advanceToNextAttempt(attemptToken, lastKnownTimestamp);
        return;
      }

      const currentSrc = video.src || activeAttempt?.url || '';
      const isTranscode = currentSrc.includes('/api/transcode');

      // If a transcode attempt failed before starting playback, try any remaining direct/native attempt
      if (isTranscode && !hasPlaybackStarted) {
        const nextDirectIdx = attempts.findIndex(
          (a, i) => i > currentAttemptIdx && !a.url.includes('/api/transcode')
        );
        if (nextDirectIdx !== -1) {
          runAttempt(nextDirectIdx, lastKnownTimestamp);
          return;
        }
        const anyDirectIdx = attempts.findIndex((a) => a.isDirect && a.mode === 'native');
        if (anyDirectIdx !== -1 && anyDirectIdx !== currentAttemptIdx && reconnectRetries === 0) {
          reconnectRetries += 1;
          runAttempt(anyDirectIdx, lastKnownTimestamp);
          return;
        }
      }

      if ((hasPlaybackStarted || lastKnownTimestamp > 1) && reconnectRetries < 6) {
        reconnectRetries += 1;
        const savedTime = lastKnownTimestamp;
        setHasError(false);
        setIsLoading(true);
        if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
        const retryDelayMs = Math.min(4000, 900 * reconnectRetries);
        reconnectTimer = window.setTimeout(() => {
          if (!isMounted) return;
          startTranscodeAt(savedTime);
        }, retryDelayMs);
        return;
      }

      advanceToNextAttempt(attemptToken, lastKnownTimestamp);
    };

    const extractFiniteOrSeekableDuration = (): number | null => {
      if (video.duration && Number.isFinite(video.duration) && video.duration > 0) {
        return seekBaseOffsetRef.current + video.duration;
      }
      if (isVodChannel && video.seekable && video.seekable.length > 0) {
        try {
          const seekEnd = video.seekable.end(video.seekable.length - 1);
          if (Number.isFinite(seekEnd) && seekEnd > 30) {
            return seekBaseOffsetRef.current + seekEnd;
          }
        } catch {
          // ignore
        }
      }
      return null;
    };

    const handleTimeUpdate = () => {
      if (isTransitioning) return;
      const effectiveTime = seekBaseOffsetRef.current + video.currentTime;
      if (video.currentTime > 0.2) {
        clearWaitingWatchdog();
      }
      if (!video.seeking && !video.paused && video.readyState >= 2) {
        setIsLoading(false);
        if (video.currentTime > 0.3) {
          confirmOrWatchVideoTrack();
        }
      }
      lastKnownTimestamp = effectiveTime;
      if (!isScrubbingRef.current) {
        setCurrentTime(effectiveTime);
      }
      const detectedDur = extractFiniteOrSeekableDuration();
      if (detectedDur && detectedDur > 0) {
        applyKnownDuration(detectedDur);
      } else if (knownVodDurationRef.current && knownVodDurationRef.current > 0) {
        setIsLiveStream(false);
        setDuration(knownVodDurationRef.current);
      }
    };

    const handleLoadedMetadata = () => {
      if (!isMounted || isTransitioning) return;
      if (
        pendingInitialSeekSec > 0 &&
        !isClientFfmpegActive &&
        !video.src.includes('/api/transcode')
      ) {
        const target = pendingInitialSeekSec;
        pendingInitialSeekSec = 0;
        try {
          if (Math.abs(video.currentTime - target) > 1.5) {
            video.currentTime = target;
          }
        } catch {
          // ignore
        }
      }
      const detectedDur = extractFiniteOrSeekableDuration();
      if (detectedDur && detectedDur > 0) {
        applyKnownDuration(detectedDur);
      } else if (knownVodDurationRef.current && knownVodDurationRef.current > 0) {
        setIsLiveStream(false);
        setDuration(knownVodDurationRef.current);
      } else {
        setIsLiveStream(!isVodChannel);
        if (isVodChannel) {
          requestProbeDuration();
        }
      }
      safePlayVideo();
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        confirmOrWatchVideoTrack();
      }
    };

    const handleDurationChange = () => {
      if (!isMounted || isTransitioning) return;
      const detectedDur = extractFiniteOrSeekableDuration();
      if (detectedDur && detectedDur > 0) {
        applyKnownDuration(detectedDur);
      }
    };

    const handleNetworkOnline = () => {
      if (!isMounted || userPausedRef.current) return;
      reconnectRetries = 0;
      if (hasError || video.error || video.readyState < 3 || video.paused) {
        setHasError(false);
        setIsLoading(true);
        if (lastKnownTimestamp > 1) {
          startTranscodeAt(lastKnownTimestamp);
        } else {
          let firstValidIdx = 0;
          while (
            firstValidIdx < attempts.length &&
            !canUseBackendProxy() &&
            (attempts[firstValidIdx].url.includes('/api/proxy') ||
              attempts[firstValidIdx].url.includes('/api/transcode') ||
              attempts[firstValidIdx].url.startsWith('/api/'))
          ) {
            firstValidIdx += 1;
          }
          runAttempt(firstValidIdx < attempts.length ? firstValidIdx : 0);
        }
      }
    };

    video.addEventListener('playing', handlePlaying);
    video.addEventListener('canplay', handlePlaying);
    video.addEventListener('seeked', handleSeeked);
    video.addEventListener('resize', handleResize);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('stalled', handleStalled);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('error', handleVideoError);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('durationchange', handleDurationChange);
    video.addEventListener('ratechange', handleRateChange);
    window.addEventListener('online', handleNetworkOnline);

    // Start playback (resolving Archive.org / CDN / truncated VOD URLs client-side if needed)
    const isArchiveUrl =
      /^https?:\/\/(?:www\.)?archive\.org\/(?:details|download|stream)\//i.test(cleanUrl) ||
      /^https?:\/\/[^/?#]+\.archive\.org\/(?:[^/?#]+\/)*items\//i.test(cleanUrl);
    const hasDirectVideoExtension = /\.(mp4|mkv|m3u8|ts|webm|avi|mov|m4v|flv|ogg)(\?|$)/i.test(
      cleanUrl
    );
    const isDirectPlayableArchiveMp4 =
      isArchiveUrl &&
      !/\/details\//i.test(cleanUrl) &&
      /\.(mp4|webm|m4v)(\?|$)/i.test(cleanUrl);

    const needsBlockingVodResolution =
      (isArchiveUrl && !isDirectPlayableArchiveMp4) ||
      ((isExplicitNativeVod || isMkvAviOrLegacyContainer) &&
        !hasDirectVideoExtension &&
        !normalizedChannel.xtreamParams &&
        !/drive\.usercontent\.google\.com|drive\.google\.com|pixeldrain\.com|dropboxusercontent\.com/i.test(
          cleanUrl
        ));

    const startPlaybackPipeline = async () => {
      await ensureBackendProbed();
      if (!isMounted) return;

      // Refresh proxyUrl and transcodeFullUrl in case ensureBackendProbed resolved a remote backend URL
      const resolvedBase = getEffectiveApiBaseUrl();
      proxyUrl = buildProxyUrl(normalizedChannel, userAgent, undefined, resolvedBase);
      transcodeFullUrl = buildTranscodeUrl(
        normalizedChannel,
        'full',
        0,
        userAgent,
        undefined,
        resolvedBase
      );
      if (resolvedBase) {
        for (const att of attempts) {
          if (att.url.startsWith('/api/')) {
            att.url = `${resolvedBase}${att.url}`;
          }
        }
      }

      if (needsBlockingVodResolution) {
        const resolvedUrls = await resolveClientSideVodUrls(
          normalizedChannel,
          probeController.signal
        );
        if (!isMounted) return;
        for (const rUrl of resolvedUrls) {
          if (rUrl && !resolvedVodCandidates.includes(rUrl)) {
            resolvedVodCandidates.unshift(rUrl);
          }
          const cachedDur = getCachedClientVodDuration(rUrl);
          if (cachedDur && cachedDur > 0) {
            applyKnownDuration(cachedDur);
          }
        }

        const primaryResolved = resolvedUrls[0];
        if (primaryResolved && primaryResolved !== cleanUrl) {
          proxyUrl = buildProxyUrl(normalizedChannel, userAgent, primaryResolved, resolvedBase);
          transcodeFullUrl = buildTranscodeUrl(
            normalizedChannel,
            'full',
            0,
            userAgent,
            primaryResolved,
            resolvedBase
          );
        }

        for (let i = resolvedUrls.length - 1; i >= 0; i--) {
          const rUrl = resolvedUrls[i];
          if (rUrl) {
            if (canUseBackendProxy()) {
              attempts.unshift({
                mode: 'native',
                url: buildProxyUrl(normalizedChannel, userAgent, rUrl, resolvedBase),
              });
            }
            const safeResolvedList = getHttpsSafeMediaUrls(rUrl, true);
            for (let j = safeResolvedList.length - 1; j >= 0; j--) {
              attempts.unshift({
                mode: 'native',
                url: safeResolvedList[j],
                isDirect: true,
              });
            }
          }
        }
      } else if (isDirectPlayableArchiveMp4) {
        // Direct Archive.org .mp4/.webm: start playing immediately (0ms delay), and enrich duration + .ia.mp4 derivatives in background!
        resolveClientSideVodUrls(normalizedChannel, probeController.signal)
          .then((resolvedUrls) => {
            if (!isMounted) return;
            for (const rUrl of resolvedUrls) {
              if (rUrl && !resolvedVodCandidates.includes(rUrl)) {
                resolvedVodCandidates.push(rUrl);
              }
              const cachedDur = getCachedClientVodDuration(rUrl);
              if (cachedDur && cachedDur > 0) {
                applyKnownDuration(cachedDur);
              }
              if (rUrl && rUrl !== cleanUrl) {
                for (const safeAlt of getHttpsSafeMediaUrls(rUrl, true)) {
                  if (!attempts.some((a) => a.url === safeAlt)) {
                    attempts.splice(currentAttemptIdx + 1, 0, {
                      mode: 'native',
                      url: safeAlt,
                      isDirect: true,
                    });
                  }
                }
              }
            }
          })
          .catch(() => {});
      }

      // On static deployments (e.g. GitHub Pages) with no verified backend proxy,
      // completely purge any /api/proxy or /api/transcode attempts so the player never issues 404s
      if (!canUseBackendProxy()) {
        for (let i = attempts.length - 1; i >= 0; i--) {
          const u = attempts[i].url;
          if (u.includes('/api/proxy') || u.includes('/api/transcode') || u.startsWith('/api/')) {
            attempts.splice(i, 1);
          }
        }
      }

      // Skip initial proxy/transcode attempts if no backend proxy is available
      let firstIdx = 0;
      while (
        firstIdx < attempts.length &&
        !canUseBackendProxy() &&
        (attempts[firstIdx].url.includes('/api/proxy') ||
          attempts[firstIdx].url.includes('/api/transcode') ||
          attempts[firstIdx].url.startsWith('/api/'))
      ) {
        firstIdx += 1;
      }

      runAttempt(firstIdx < attempts.length ? firstIdx : 0);

      // Delay duration probe by 1200ms so native <video> metadata can populate duration first
      // without opening a competing upstream connection on 1-connection-limit VOD servers!
      window.setTimeout(() => {
        if (isMounted && !knownVodDurationRef.current) {
          requestProbeDuration();
        }
      }, 1200);
    };

    startPlaybackPipeline();

    return () => {
      isMounted = false;
      playerControlRef.current = null;
      probeController.abort();
      abortClientFfmpeg();
      revokeClientBlob();
      clearTimers();
      destroyPlayers();
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('canplay', handlePlaying);
      video.removeEventListener('seeked', handleSeeked);
      video.removeEventListener('resize', handleResize);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('stalled', handleStalled);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('error', handleVideoError);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('durationchange', handleDurationChange);
      video.removeEventListener('ratechange', handleRateChange);
      window.removeEventListener('online', handleNetworkOnline);
    };
  }, [channel, streamReloadKey, transcodeMode, accelMode]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (hasError) {
      // Re-trigger stream reload with FFmpeg decoder if error occurred!
      setHasError(false);
      setIsLoading(true);
      if (accelMode !== 'SW') {
        handleSetAccelMode('SW');
      } else {
        setStreamReloadKey((k) => k + 1);
      }
      return;
    }
    if (isPlaying) {
      userPausedRef.current = true;
      video.pause();
      setIsPlaying(false);
    } else {
      userPausedRef.current = false;
      video.play().catch(() => {});
      setIsPlaying(true);
    }
  };

  const seekToTime = (targetTime: number) => {
    const effectiveDuration = knownVodDurationRef.current || duration;
    if (!effectiveDuration || effectiveDuration <= 0) return;
    const clampedTime = Math.min(effectiveDuration, Math.max(0, targetTime));
    setCurrentTime(clampedTime);
    setScrubTime(clampedTime);
    if (playerControlRef.current) {
      playerControlRef.current.seekTo(clampedTime);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    seekToTime(Number(e.target.value));
  };

  const handlePrevChannel = () => {
    if (channels.length <= 1) return;
    const prevIdx = (currentIndex - 1 + channels.length) % channels.length;
    onSelectChannel(channels[prevIdx]);
  };

  const handleNextChannel = () => {
    if (channels.length <= 1) return;
    const nextIdx = (currentIndex + 1) % channels.length;
    onSelectChannel(channels[nextIdx]);
  };

  const handleToggleRotation = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();

    // 1. Ensure fullscreen is active so mobile header and navigation buttons stay hidden
    await requestFullscreenSafe();

    // 2. Toggle target orientation between Vertical and Horizontal
    const nextLandscape = !isLandscape;
    setIsLandscape(nextLandscape);

    // 3. Modern Screen Orientation API (Android Chrome, WebViews, etc.)
    try {
      const orientation =
        screen.orientation ||
        (screen as any).mozOrientation ||
        (screen as any).msOrientation;
      if (orientation && typeof orientation.lock === 'function') {
        if (nextLandscape) {
          await orientation.lock('landscape');
        } else {
          await orientation.lock('portrait');
        }
      }
    } catch {
      // Screen orientation lock may throw if device sensor is locked or on iOS/desktop without sensor.
      // CSS rotation fallback below smoothly handles visual rotation in those cases!
    }

    // 4. On-screen HUD toast feedback
    setRotationHudText(
      nextLandscape
        ? 'Horizontal (Landscape)'
        : `Vertical (Portrait: ${
            portraitBoxShape === 'square-1-1'
              ? 'Square Box 1:1'
              : portraitBoxShape === 'rectangle-4-3'
              ? '4:3 Box'
              : '16:9 Rectangle'
          })`
    );
    if (gestureHudTimeoutRef.current) {
      window.clearTimeout(gestureHudTimeoutRef.current);
    }
    gestureHudTimeoutRef.current = window.setTimeout(() => {
      setRotationHudText(null);
    }, 1300);
  };

  useEffect(() => {
    return () => {
      if (gestureHudTimeoutRef.current) {
        window.clearTimeout(gestureHudTimeoutRef.current);
      }
    };
  }, []);

  // Autofocus active channel in left drawer when opened on Android TV
  useEffect(() => {
    if (showChannelDrawer) {
      const timer = window.setTimeout(() => {
        if (activeDrawerItemRef.current) {
          focusTvElement(activeDrawerItemRef.current, true);
        } else {
          const firstDrawerItem = document.querySelector<HTMLElement>('[data-tv="drawer-channel"]');
          if (firstDrawerItem) {
            focusTvElement(firstDrawerItem, true);
          }
        }
      }, 50);
      return () => window.clearTimeout(timer);
    }
  }, [showChannelDrawer]);

  // Android TV Remote & D-Pad Keyboard Handler for Video Player
  useEffect(() => {
    const handlePlayerRemoteKeyDown = (e: KeyboardEvent) => {
      const {
        isUp,
        isDown,
        isLeft,
        isRight,
        isSelect,
        isBack,
        isChannelUp,
        isChannelDown,
        isPlayPause,
        isRewind,
        isFastForward,
      } = parseRemoteKeyEvent(e);

      // 1. If translucent channel drawer is open:
      if (showChannelDrawer) {
        if (isBack) {
          e.preventDefault();
          e.stopPropagation();
          setShowChannelDrawer(false);
          return;
        }

        const allDrawerItems = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-tv="drawer-channel"], [data-tv="drawer-category"]'
          )
        );
        const active = document.activeElement as HTMLElement | null;
        const idx = allDrawerItems.indexOf(active!);

        if (isDown) {
          e.preventDefault();
          e.stopPropagation();
          const nextIdx = idx < allDrawerItems.length - 1 ? idx + 1 : 0;
          focusTvElement(allDrawerItems[nextIdx], true);
          return;
        }

        if (isUp) {
          e.preventDefault();
          e.stopPropagation();
          const prevIdx = idx > 0 ? idx - 1 : allDrawerItems.length - 1;
          focusTvElement(allDrawerItems[prevIdx], true);
          return;
        }

        if (isSelect) {
          if (active && active !== document.body) {
            e.preventDefault();
            e.stopPropagation();
            active.click();
            return;
          }
        }

        if (isLeft || isRight) {
          e.preventDefault();
          e.stopPropagation();
          setDrawerView((prev) => (prev === 'channels' ? 'categories' : 'channels'));
          return;
        }

        return;
      }

      // 2. If sub-modals are open (settings, more menu):
      if (showPlayerSettings || showMoreMenu) {
        if (isBack) {
          e.preventDefault();
          e.stopPropagation();
          setShowPlayerSettings(false);
          setShowMoreMenu(false);
          return;
        }

        const menuItems = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-tv="player-menu-item"], [data-tv="menu-item"], button:not([disabled]), [tabindex="0"]:not([disabled])'
          )
        );
        const active = document.activeElement as HTMLElement | null;
        const idx = menuItems.indexOf(active!);

        if (isDown) {
          e.preventDefault();
          e.stopPropagation();
          const nextIdx = idx < menuItems.length - 1 ? idx + 1 : 0;
          focusTvElement(menuItems[nextIdx], true);
          return;
        }

        if (isUp) {
          e.preventDefault();
          e.stopPropagation();
          const prevIdx = idx > 0 ? idx - 1 : menuItems.length - 1;
          focusTvElement(menuItems[prevIdx], true);
          return;
        }

        if (isSelect) {
          if (active && active !== document.body) {
            e.preventDefault();
            e.stopPropagation();
            active.click();
            return;
          }
        }

        return;
      }

      // 3. Remote Back button: close player and return to channel list
      if (isBack) {
        e.preventDefault();
        e.stopPropagation();
        handleClosePlayer();
        return;
      }

      // 4. Play/Pause toggle
      if (isPlayPause) {
        e.preventDefault();
        e.stopPropagation();
        togglePlay();
        setShowControls(true);
        return;
      }

      // 5. Channel Up / Down
      if (isChannelUp) {
        e.preventDefault();
        e.stopPropagation();
        handleNextChannel();
        setShowControls(true);
        return;
      }
      if (isChannelDown) {
        e.preventDefault();
        e.stopPropagation();
        handlePrevChannel();
        setShowControls(true);
        return;
      }

      // 6. D-Pad Left / Rewind
      if (isLeft || isRewind) {
        e.preventDefault();
        e.stopPropagation();
        const effDuration = knownVodDurationRef.current || duration;
        if (!isLiveStream && effDuration && effDuration > 0) {
          // VOD Seek backward 10s
          const newTime = Math.max(0, (currentTime || 0) - 10);
          seekToTime(newTime);
          setShowControls(true);
        } else {
          // Live stream: open translucent channel list
          setDrawerCategory('All Channels');
          setDrawerView('channels');
          setShowChannelDrawer(true);
        }
        return;
      }

      // 7. D-Pad Right / FastForward
      if (isRight || isFastForward) {
        e.preventDefault();
        e.stopPropagation();
        const effDuration = knownVodDurationRef.current || duration;
        if (!isLiveStream && effDuration && effDuration > 0) {
          // VOD Seek forward 10s
          const newTime = Math.min(effDuration, (currentTime || 0) + 10);
          seekToTime(newTime);
          setShowControls(true);
        } else {
          // Live stream: switch to next channel
          handleNextChannel();
          setShowControls(true);
        }
        return;
      }

      // 8. D-Pad Up: open translucent channel list (matching standard Android TV IPTV UX)
      if (isUp) {
        e.preventDefault();
        e.stopPropagation();
        setDrawerCategory('All Channels');
        setDrawerView('channels');
        setShowChannelDrawer(true);
        return;
      }

      // 9. D-Pad Down: show controls or switch channel
      if (isDown) {
        e.preventDefault();
        e.stopPropagation();
        if (!showControls) {
          setShowControls(true);
        } else {
          handleNextChannel();
        }
        return;
      }

      // 10. D-Pad Center / OK / Select:
      if (isSelect) {
        e.preventDefault();
        e.stopPropagation();
        if (!showControls) {
          setShowControls(true);
        } else {
          togglePlay();
        }
        return;
      }
    };

    window.addEventListener('keydown', handlePlayerRemoteKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handlePlayerRemoteKeyDown, { capture: true });
    };
  }, [
    showChannelDrawer,
    showPlayerSettings,
    showMoreMenu,
    showControls,
    isPlaying,
    currentTime,
    duration,
    isLiveStream,
    currentIndex,
    channels.length,
  ]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // If not in fullscreen, request fullscreen on mobile tap
    if (
      typeof document !== 'undefined' &&
      !document.fullscreenElement &&
      !(document as any).webkitFullscreenElement
    ) {
      requestFullscreenSafe();
    }
    if (
      showChannelDrawer ||
      showPlayerSettings ||
      showMoreMenu ||
      isScreenLocked
    ) {
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target && target.closest('button, input, [data-seek-bar="true"]')) {
      return;
    }
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const side: 'left' | 'right' =
      e.clientX - rect.left < rect.width / 2 ? 'left' : 'right';

    gestureStateRef.current = {
      active: true,
      moved: false,
      side,
      startY: e.clientY,
      startBrightness: brightness,
      startVolume: volume,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = gestureStateRef.current;
    if (!state.active) return;

    const deltaY = state.startY - e.clientY; // positive when dragging bottom-to-top
    if (!state.moved && Math.abs(deltaY) < 6) {
      return;
    }

    if (!state.moved) {
      state.moved = true;
      setShowControls(false);
    }

    if (gestureHudTimeoutRef.current) {
      window.clearTimeout(gestureHudTimeoutRef.current);
      gestureHudTimeoutRef.current = null;
    }

    const rect = containerRef.current?.getBoundingClientRect();
    const height = rect && rect.height > 0 ? rect.height : window.innerHeight || 400;
    const effectiveRangePx = Math.max(160, height * 0.65);

    if (state.side === 'left') {
      const deltaPercent = (deltaY / effectiveRangePx) * 100;
      const nextBrightness = Math.round(
        Math.min(100, Math.max(0, state.startBrightness + deltaPercent))
      );
      setBrightness(nextBrightness);
      setGestureHud('brightness');
    } else {
      const deltaPercent = (deltaY / effectiveRangePx) * 200;
      const nextVolume = Math.round(
        Math.min(200, Math.max(0, state.startVolume + deltaPercent))
      );
      setVolume(nextVolume);
      setGestureHud('volume');

      if (videoRef.current) {
        videoRef.current.volume = Math.min(1, Math.max(0, nextVolume / 100));
        videoRef.current.muted = nextVolume === 0;
      }
    }
  };

  const handlePointerEnd = () => {
    const state = gestureStateRef.current;
    if (!state.active) return;
    state.active = false;

    if (state.moved) {
      suppressNextClickRef.current = true;
      if (gestureHudTimeoutRef.current) {
        window.clearTimeout(gestureHudTimeoutRef.current);
      }
      gestureHudTimeoutRef.current = window.setTimeout(() => {
        setGestureHud(null);
      }, 1100);
    }
  };

  const effectiveDisplayTime = isScrubbing ? scrubTime : currentTime;
  const progressPercent =
    !isLiveStream && duration && duration > 0
      ? Math.min(100, Math.max(0, (effectiveDisplayTime / duration) * 100))
      : 0;

  const handleClosePlayer = () => {
    exitFullscreenSafe();
    onClose();
  };

  const needCssRotation = isLandscape !== isPhysicalLandscape;
  const videoComputedStyle: React.CSSProperties = isLandscape
    ? needCssRotation
      ? {
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: '100vh',
          height: '100vw',
          maxWidth: 'none',
          maxHeight: 'none',
          transform: `translate(-50%, -50%) rotate(${!isPhysicalLandscape ? '90deg' : '-90deg'}) ${
            videoScale !== 100 ? `scale(${videoScale / 100})` : ''
          }`,
        }
      : videoScale !== 100
      ? { transform: `scale(${videoScale / 100})` }
      : {}
    : videoScale !== 100
    ? { transform: `scale(${videoScale / 100})` }
    : {};

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      data-tv="video-player"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onClick={() => {
        if (suppressNextClickRef.current) {
          suppressNextClickRef.current = false;
          return;
        }
        setShowControls((prev) => !prev);
      }}
      className="fixed inset-0 z-50 bg-black flex flex-col justify-between select-none overflow-hidden touch-none"
    >
      {/* Video Container: Landscape (Full Screen Unchanged) vs Portrait (Centered Aspect Ratio Box) */}
      <div
        className={`absolute inset-0 flex items-center justify-center pointer-events-none transition-all duration-200 ${
          isLandscape ? 'p-0' : 'p-3 sm:p-5'
        }`}
      >
        <div
          className={`pointer-events-auto relative flex items-center justify-center transition-all duration-300 ${
            isLandscape
              ? 'w-full h-full'
              : portraitBoxShape === 'square-1-1'
              ? 'w-[88vw] max-w-[390px] aspect-square rounded-[6px] border border-white/20 shadow-[0_12px_40px_rgba(0,0,0,0.95)] bg-black overflow-hidden'
              : portraitBoxShape === 'rectangle-4-3'
              ? 'w-[92vw] max-w-[440px] aspect-[4/3] rounded-[6px] border border-white/20 shadow-[0_12px_40px_rgba(0,0,0,0.95)] bg-black overflow-hidden'
              : 'w-[94vw] max-w-[480px] aspect-video rounded-[6px] border border-white/20 shadow-[0_12px_40px_rgba(0,0,0,0.95)] bg-black overflow-hidden'
          }`}
          style={
            !isLandscape && needCssRotation
              ? {
                  transform: `rotate(${!isPhysicalLandscape ? '90deg' : '-90deg'}) ${
                    videoScale !== 100 ? `scale(${videoScale / 100})` : ''
                  }`,
                  maxHeight: '75vh',
                  maxWidth: '75vw',
                }
              : undefined
          }
        >
          <video
            ref={videoRef}
            style={videoComputedStyle}
            className={`transition-all duration-200 ${
              isLandscape
                ? `${needCssRotation ? '' : 'absolute inset-0 w-full h-full'} ${
                    aspectRatioIdx === 3
                      ? 'object-fill'
                      : aspectRatioIdx === 1 || aspectRatioIdx === 2
                      ? 'object-cover'
                      : aspectMode === 'fill'
                      ? 'object-fill'
                      : aspectMode === 'cover'
                      ? 'object-cover'
                      : 'object-contain'
                  }`
                : 'w-full h-full object-contain bg-black'
            }`}
            playsInline
            autoPlay
          />

          {/* Quick Portrait Box Shape Switch Pill (Visible in Portrait Mode when Controls are Active) */}
          {!isLandscape && showControls && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                const nextShape: PortraitBoxShape =
                  portraitBoxShape === 'rectangle-16-9'
                    ? 'square-1-1'
                    : portraitBoxShape === 'square-1-1'
                    ? 'rectangle-4-3'
                    : 'rectangle-16-9';
                handleSetPortraitBoxShape(nextShape);
              }}
              className="absolute top-2 right-2 bg-black/75 hover:bg-black/90 active:bg-white/20 backdrop-blur-sm px-2.5 py-1 rounded-[4px] border border-white/30 text-[11px] font-mono text-white shadow-[0_2px_8px_rgba(0,0,0,0.7)] cursor-pointer transition-colors z-10 flex items-center gap-1.5"
              title="Click to switch box: 16:9 Rectangle ↔ 1:1 Square ↔ 4:3 Box"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#5BAAF5]" />
              <span>
                {portraitBoxShape === 'square-1-1'
                  ? '1:1 Square'
                  : portraitBoxShape === 'rectangle-4-3'
                  ? '4:3 Box'
                  : '16:9 Rect'}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Hardware-safe Brightness Dimming Overlay */}
      {brightness < 92 && (
        <div
          className="absolute inset-0 pointer-events-none z-[5]"
          style={{
            backgroundColor: `rgba(0, 0, 0, ${Math.min(0.82, ((92 - brightness) / 92) * 0.82)})`,
          }}
        />
      )}

      {/* =====================================================================
          CENTER LOADING INDICATOR OR ERROR MESSAGE
          Exact Match to Screenshot_20261024-074931_IPTV_abc87829.jpg ("Error playing channel")
         ===================================================================== */}
      {hasError ? (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 px-6">
          <span className="text-[17px] sm:text-[18.5px] font-normal text-white tracking-[0.01em] text-center drop-shadow">
            Error playing channel
          </span>
        </div>
      ) : (
        isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10">
            <svg
              className="w-12 h-12 animate-spin text-[#5BAAF5]"
              viewBox="0 0 50 50"
              aria-hidden="true"
            >
              <circle
                cx="25"
                cy="25"
                r="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="4"
                strokeLinecap="butt"
                strokeDasharray="80 120"
              />
            </svg>
            <span className="mt-2.5 text-[14.5px] font-normal text-[#B0B0B0] tracking-[0.01em]">
              Loading...
            </span>
          </div>
        )
      )}

      {/* =====================================================================
          TOP OVERLAY AREA (Single unified row matching Screenshot_20261024-074931_IPTV_abc87829.jpg)
         ===================================================================== */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`relative z-20 w-full flex items-center justify-between px-2 pt-2 pb-4 bg-gradient-to-b from-black/80 via-black/35 to-transparent transition-opacity duration-200 ${
          (showControls || hasError) && !showPlayerSettings && !showChannelDrawer
            ? 'opacity-100'
            : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Left: Back Arrow + Logo / Pink Initial Badge + Channel Name */}
        <div className="flex items-center gap-2.5 min-w-0 pr-3">
          <button
            onClick={handleClosePlayer}
            className="w-12 h-12 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors shrink-0"
            aria-label="Back"
          >
            <ArrowLeft className="w-6 h-6 stroke-[2] drop-shadow" />
          </button>

          {channel.logo && !logoError ? (
            <div className="w-8 h-8 rounded-[2px] overflow-hidden shrink-0 flex items-center justify-center">
              <img
                src={channel.logo}
                alt={channel.name}
                referrerPolicy="no-referrer"
                onError={() => setLogoError(true)}
                className="w-full h-full object-contain"
              />
            </div>
          ) : (
            <span className="text-[25px] font-normal text-[#E91E63] shrink-0 font-sans leading-none select-none pl-1">
              {channel.name?.trim() ? channel.name.trim().charAt(0).toUpperCase() : 'H'}
            </span>
          )}

          <h2 className="text-[17px] font-normal text-white tracking-normal truncate drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
            {channel.name}
          </h2>
        </div>

        {/* Right: Decoder Badge + Star + Cast + MoreVertical */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleCycleAccelMode}
            className={`h-7 px-2 rounded-[3px] text-[12px] font-semibold tracking-wide transition-all flex items-center gap-1 border cursor-pointer select-none ${
              accelMode === 'SW'
                ? 'bg-white/10 hover:bg-white/20 border-white/25 text-white/90'
                : accelMode === 'HW'
                ? 'bg-white/10 hover:bg-white/20 border-white/25 text-white/90'
                : 'bg-[#1976D2]/85 hover:bg-[#1976D2] border-[#90CAF9]/40 text-white shadow-[0_0_6px_rgba(25,118,210,0.4)]'
            }`}
            title={`Decoder: ${accelMode}. Click to cycle decoders.`}
            aria-label="Toggle Decoder mode"
          >
            <span>{accelMode}</span>
          </button>

          <button
            onClick={() => onToggleFavorite(channel.id)}
            className="w-11 h-11 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
            aria-label="Favorite"
          >
            <Star
              className={`w-[22px] h-[22px] stroke-[2] drop-shadow ${
                isFavorite ? 'fill-[#FFD54F] text-[#FFD54F]' : 'text-white'
              }`}
            />
          </button>

          <button
            onClick={() => {
              if (onOpenCast) {
                onOpenCast();
              }
            }}
            className="w-11 h-11 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
            aria-label="Cast"
          >
            <svg
              viewBox="0 0 24 24"
              className="w-[22px] h-[22px] fill-current drop-shadow"
              aria-hidden="true"
            >
              <path d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z" />
            </svg>
          </button>

          <button
            onClick={() => setShowMoreMenu((prev) => !prev)}
            className="w-11 h-11 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
            aria-label="More options"
          >
            <MoreVertical className="w-[22px] h-[22px] drop-shadow" />
          </button>
        </div>
      </div>

      {/* =====================================================================
          BOTTOM CONTROLS + PROGRESS BAR OVERLAY
          Matches Screenshot_20261024-074931_IPTV_abc87829.jpg
         ===================================================================== */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`relative z-20 w-full flex flex-col bg-gradient-to-t from-black/80 via-black/35 to-transparent pt-6 pb-2.5 transition-opacity duration-200 ${
          (showControls || hasError) && !showPlayerSettings && !showChannelDrawer
            ? 'opacity-100'
            : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Row 1: 5 Evenly Spaced Controls */}
        <div className="w-full grid grid-cols-5 items-center justify-items-center pb-2">
          {/* 1. Hamburger Channel List Button (☰) */}
          <button
            onClick={() => {
              setDrawerCategory('All Channels');
              setDrawerView('channels');
              setShowControls(false);
              setShowChannelDrawer(true);
            }}
            className="w-12 h-12 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
            aria-label="Channel list"
          >
            <svg
              viewBox="0 0 24 24"
              className="w-6 h-6 fill-current drop-shadow"
              aria-hidden="true"
            >
              <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
            </svg>
          </button>

          {/* 2. Previous Channel Button (|◀) */}
          <button
            onClick={handlePrevChannel}
            className="w-12 h-12 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
            aria-label="Previous channel"
          >
            <svg
              viewBox="0 0 24 24"
              className="w-6 h-6 fill-current drop-shadow"
              aria-hidden="true"
            >
              <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
            </svg>
          </button>

          {/* 3. Center Pause (||) / Play (▶) Button */}
          <button
            onClick={togglePlay}
            className="w-14 h-14 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
            aria-label={hasError || isPlaying ? 'Pause' : 'Play'}
          >
            {hasError || isPlaying ? (
              <svg
                viewBox="0 0 24 24"
                className="w-9 h-9 fill-current drop-shadow"
                aria-hidden="true"
              >
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                className="w-9 h-9 fill-current drop-shadow"
                aria-hidden="true"
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          {/* 4. Next Channel Button (▶|) */}
          <button
            onClick={handleNextChannel}
            className="w-12 h-12 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
            aria-label="Next channel"
          >
            <svg
              viewBox="0 0 24 24"
              className="w-6 h-6 fill-current drop-shadow"
              aria-hidden="true"
            >
              <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
            </svg>
          </button>

          {/* 5. Screen Rotation / Aspect Ratio Button */}
          <button
            onClick={handleToggleRotation}
            className="w-12 h-12 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors cursor-pointer"
            aria-label={isLandscape ? 'Switch to Vertical (Portrait)' : 'Switch to Horizontal (Landscape)'}
            title={isLandscape ? 'Switch to Vertical (Portrait)' : 'Switch to Horizontal (Landscape)'}
          >
            <svg
              viewBox="0 0 24 24"
              className="w-6 h-6 fill-current drop-shadow transition-transform duration-200"
              aria-hidden="true"
            >
              <path d="M16.48 2.52c3.27 1.55 5.61 4.72 5.97 8.48h1.5C23.44 4.84 18.29 0 12 0l-.66.03 3.81 3.81 1.33-1.32zm-6.25-.77c-.59-.59-1.54-.59-2.12 0L1.75 8.11c-.59.59-.59 1.54 0 2.12l12.02 12.02c.59.59 1.54.59 2.12 0l6.36-6.36c.59-.59.59-1.54 0-2.12L10.23 1.75zm4.6 19.44L2.81 9.17l6.36-6.36 12.02 12.02-6.36 6.36zm-7.31.29C4.25 19.94 1.91 16.76 1.55 13H.05C.56 19.16 5.71 24 12 24l.66-.03-3.81-3.81-1.33 1.32z" />
            </svg>
          </button>
        </div>

        {/* Row 2: Progress / Live Timeline Bar (Hidden when stream in error state) */}
        {!hasError && (
          <div
            data-seek-bar="true"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerMove={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="w-full px-4 flex items-center gap-3"
          >
            <span className="text-[12.5px] font-medium text-white tabular-nums drop-shadow shrink-0">
              {formatDuration(effectiveDisplayTime)}
            </span>

            <div
              onPointerDown={(e) => {
                e.stopPropagation();
                const effectiveDuration = knownVodDurationRef.current || duration;
                if (isLiveStream || !effectiveDuration || effectiveDuration <= 0) return;
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  // ignore
                }
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio =
                  rect.width > 0
                    ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
                    : 0;
                const nextTime = ratio * effectiveDuration;
                isScrubbingRef.current = true;
                setIsScrubbing(true);
                setScrubTime(nextTime);
              }}
              onPointerMove={(e) => {
                e.stopPropagation();
                if (!isScrubbingRef.current) return;
                const effectiveDuration = knownVodDurationRef.current || duration;
                if (!effectiveDuration || effectiveDuration <= 0) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio =
                  rect.width > 0
                    ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
                    : 0;
                setScrubTime(ratio * effectiveDuration);
              }}
              onPointerUp={(e) => {
                e.stopPropagation();
                if (!isScrubbingRef.current) return;
                try {
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  }
                } catch {
                  // ignore
                }
                const effectiveDuration = knownVodDurationRef.current || duration;
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio =
                  rect.width > 0
                    ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
                    : 0;
                isScrubbingRef.current = false;
                setIsScrubbing(false);
                if (effectiveDuration && effectiveDuration > 0) {
                  seekToTime(ratio * effectiveDuration);
                }
              }}
              onPointerCancel={(e) => {
                e.stopPropagation();
                isScrubbingRef.current = false;
                setIsScrubbing(false);
              }}
              className="relative flex-1 h-7 flex items-center cursor-pointer touch-none"
            >
              {/* Base Track */}
              <div className="w-full h-[3px] bg-white/35 rounded-full overflow-hidden">
                {!isLiveStream && (
                  <div
                    className="h-full bg-[#5BAAF5]"
                    style={{ width: `${progressPercent}%` }}
                  />
                )}
              </div>

              {/* Sky-Blue Circular Thumb (only shown on seekable VOD streams, hidden on LIVE streams as in Screenshot 10) */}
              {!isLiveStream && (
                <div
                  className={`absolute rounded-full bg-[#5BAAF5] shadow pointer-events-none -translate-x-1/2 transition-transform ${
                    isScrubbing ? 'w-4 h-4 scale-110' : 'w-3.5 h-3.5'
                  }`}
                  style={{ left: `${progressPercent}%` }}
                />
              )}
            </div>

            <span className="text-[12.5px] font-medium text-white tabular-nums drop-shadow shrink-0 uppercase">
              {isLiveStream || !duration ? 'LIVE' : formatDuration(duration)}
            </span>
          </div>
        )}
      </div>

      {/* Top-Right Clock ("12:42 PM") shown when Channel Drawer is open, Gesture HUD is active, or Clock setting enabled — Exact Match to 1.jpg & 2.jpg */}
      {(showChannelDrawer ||
        gestureHud !== null ||
        showClockIdx === 2 ||
        (showClockIdx === 1 && showControls)) && (
        <div className="fixed top-1.5 right-3.5 z-30 pointer-events-none">
          <span className="text-[18.5px] font-normal text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
            {clockText}
          </span>
        </div>
      )}

      {/* =====================================================================
          CENTER BRIGHTNESS & VOLUME GESTURE HUD OVERLAY
          Exact Match to 1.jpg ("Brightness 92%") and 2.jpg ("Volume 127%")
         ===================================================================== */}
      {gestureHud !== null && (
        <div className="fixed inset-0 z-30 flex items-center justify-center pointer-events-none">
          <div className="bg-black/45 rounded-[3px] px-2.5 py-2 flex items-center gap-3.5 min-w-[164px] shadow-[0_2px_10px_rgba(0,0,0,0.45)]">
            {/* Left Vertical Progress Bar */}
            <div className="w-[14px] h-[68px] border border-[#A0A0A0]/80 bg-black/75 p-[1px] flex flex-col justify-end overflow-hidden shrink-0">
              {gestureHud === 'brightness' ? (
                <div
                  className="w-full bg-[#72C7F5]"
                  style={{ height: `${brightness}%` }}
                />
              ) : volume <= 100 ? (
                <div
                  className="w-full bg-[#72C7F5]"
                  style={{ height: `${volume}%` }}
                />
              ) : (
                <div className="w-full h-full flex flex-col">
                  <div
                    className="w-full bg-[#72C7F5]"
                    style={{ height: `${200 - volume}%` }}
                  />
                  <div
                    className="w-full bg-[#C82829]"
                    style={{ height: `${volume - 100}%` }}
                  />
                </div>
              )}
            </div>

            {/* Right Centered Two-Line Label + Percentage */}
            <div className="flex-1 flex flex-col items-center justify-center pr-1">
              <span className="text-[21px] font-normal text-white leading-[1.22] tracking-normal drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
                {gestureHud === 'brightness' ? 'Brightness' : 'Volume'}
              </span>
              <span className="text-[21px] font-normal text-white leading-[1.22] tracking-normal drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
                {gestureHud === 'brightness' ? `${brightness}%` : `${volume}%`}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Center Rotation HUD Overlay */}
      {rotationHudText !== null && (
        <div className="fixed inset-0 z-30 flex items-center justify-center pointer-events-none">
          <div className="bg-black/75 backdrop-blur-sm rounded-[4px] px-5 py-3 flex items-center gap-3.5 shadow-[0_4px_16px_rgba(0,0,0,0.65)] border border-white/10">
            <svg viewBox="0 0 24 24" className="w-7 h-7 fill-[#5BAAF5] shrink-0">
              <path d="M16.48 2.52c3.27 1.55 5.61 4.72 5.97 8.48h1.5C23.44 4.84 18.29 0 12 0l-.66.03 3.81 3.81 1.33-1.32zm-6.25-.77c-.59-.59-1.54-.59-2.12 0L1.75 8.11c-.59.59-.59 1.54 0 2.12l12.02 12.02c.59.59 1.54.59 2.12 0l6.36-6.36c.59-.59.59-1.54 0-2.12L10.23 1.75zm4.6 19.44L2.81 9.17l6.36-6.36 12.02 12.02-6.36 6.36zm-7.31.29C4.25 19.94 1.91 16.76 1.55 13H.05C.56 19.16 5.71 24 12 24l.66-.03-3.81-3.81-1.33 1.32z" />
            </svg>
            <span className="text-[17px] font-medium text-white tracking-wide">
              {rotationHudText}
            </span>
          </div>
        </div>
      )}

      {/* =====================================================================
          LEFT TRANSLUCENT CHANNEL LIST OVERLAY IN PLAYER
          Exact Match to Screenshot_20261010-123420_IPTV.jpg
          (Header: "< |LATEST MOVIES|", translucent rows over live video,
           active channel highlighted in semi-transparent sky-blue #3897D3/75
           with bottom progress bar)
         ===================================================================== */}
      {showChannelDrawer && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            setShowChannelDrawer(false);
          }}
          className="fixed inset-0 z-30 bg-transparent flex"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[235px] sm:w-[250px] max-w-[78vw] h-full bg-black/35 flex flex-col select-none"
          >
            {/* Top Category Header Row ("< All Channels") */}
            {drawerView === 'channels' ? (
              <div
                onClick={() => setDrawerView('categories')}
                className="h-[44px] px-3 flex items-center gap-3 border-b border-white/[0.18] cursor-pointer hover:bg-white/10 active:bg-white/15 transition-colors shrink-0"
              >
                <ChevronLeft className="w-5 h-5 text-[#BDBDBD] stroke-[2] shrink-0" />
                <span className="text-[15px] font-normal text-white truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
                  All Channels
                </span>
              </div>
            ) : (
              <div
                onClick={() => setDrawerView('channels')}
                className="h-[44px] px-3 flex items-center gap-3 border-b border-white/[0.18] cursor-pointer hover:bg-white/10 active:bg-white/15 transition-colors shrink-0"
              >
                <ChevronLeft className="w-5 h-5 text-[#BDBDBD] stroke-[2] shrink-0" />
                <span className="text-[15px] font-normal text-white truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
                  All Channels
                </span>
              </div>
            )}

            {/* Scrollable List */}
            <div className="tv-scroll-container flex-1 overflow-y-auto no-scrollbar divide-y divide-white/[0.18]">
              {drawerView === 'channels'
                ? drawerChannels.map((ch) => {
                    const isActive = ch.id === channel.id;
                    const isFavPlaceholder = /\bFAV\b/i.test(ch.name);
                    return (
                      <div
                        key={ch.id}
                        ref={isActive ? activeDrawerItemRef : null}
                        tabIndex={0}
                        role="button"
                        data-tv="drawer-channel"
                        data-channel-id={ch.id}
                        onFocus={(e) => {
                          focusTvElement(e.currentTarget, true);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === 'Select' || (e as any).keyCode === 23) {
                            e.preventDefault();
                            setDrawerCategory('All Channels');
                            setDrawerView('channels');
                            onSelectChannel(ch);
                            setShowChannelDrawer(false);
                          }
                        }}
                        onClick={() => {
                          setDrawerCategory('All Channels');
                          setDrawerView('channels');
                          onSelectChannel(ch);
                          setShowChannelDrawer(false);
                        }}
                        className={`tv-focusable relative h-[64px] px-1.5 flex items-center gap-2.5 cursor-pointer transition-colors ${
                          isActive
                            ? 'bg-[#3897D3]/85 ring-2 ring-white/60'
                            : 'bg-transparent hover:bg-white/10 focus:bg-[#3897D3]/60 focus:ring-2 focus:ring-[#8AD0F8]'
                        }`}
                      >
                        {/* Square Poster / Logo */}
                        {ch.logo ? (
                          <div className="w-[46px] h-[46px] bg-black/40 shrink-0 overflow-hidden flex items-center justify-center">
                            <img
                              src={ch.logo}
                              alt={ch.name}
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover"
                            />
                          </div>
                        ) : isFavPlaceholder ? (
                          <div className="w-[46px] h-[46px] bg-black/35 shrink-0 flex items-center justify-center">
                            <svg
                              viewBox="0 0 24 24"
                              className="w-7 h-7 fill-[#FBC02D]"
                              aria-hidden="true"
                            >
                              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                            </svg>
                          </div>
                        ) : (
                          <div className="w-[46px] h-[46px] bg-[#242424]/80 flex items-center justify-center text-xs text-white shrink-0">
                            {ch.name.slice(0, 3)}
                          </div>
                        )}

                        {/* Channel Title */}
                        <span className="text-[14.5px] font-normal text-white truncate pr-1 drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
                          {ch.name}
                        </span>

                        {/* Bottom Thin Progress Bar on Active Row (matching "Eyes (SOUTH)" in Screenshot) */}
                        {isActive && (
                          <div className="absolute left-[56px] right-2 bottom-1.5 h-[3px] bg-white/30 overflow-hidden">
                            <div
                              className="h-full bg-[#8AD0F8]"
                              style={{
                                width: `${progressPercent > 0 ? progressPercent : 34}%`,
                              }}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })
                : drawerCategories.map((cat) => {
                    const isCatSelected = cat === drawerCategory;
                    return (
                      <div
                        key={cat}
                        tabIndex={0}
                        role="button"
                        data-tv="drawer-category"
                        onFocus={(e) => {
                          focusTvElement(e.currentTarget, true);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === 'Select' || (e as any).keyCode === 23) {
                            e.preventDefault();
                            setDrawerCategory(cat);
                            setDrawerView('channels');
                          }
                        }}
                        onClick={() => {
                          setDrawerCategory(cat);
                          setDrawerView('channels');
                        }}
                        className={`tv-focusable h-[52px] px-3.5 flex items-center cursor-pointer transition-colors ${
                          isCatSelected
                            ? 'bg-[#3897D3]/85 ring-2 ring-white/60'
                            : 'bg-transparent hover:bg-white/10 focus:bg-[#3897D3]/60 focus:ring-2 focus:ring-[#8AD0F8]'
                        }`}
                      >
                        <span className="text-[14.5px] font-normal text-white truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
                          {cat}
                        </span>
                      </div>
                    );
                  })}
            </div>
          </div>
        </div>
      )}

      {/* Top-right 3-dots popup menu inside Player — Exact Match to Screenshot_20261009-204112_IPTV.jpg */}
      {showMoreMenu && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            setShowMoreMenu(false);
            setShowAccelSubmenu(false);
          }}
          className="fixed inset-0 z-30 bg-transparent"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="fixed top-2 right-2.5 w-[202px] bg-[#303030] rounded-[2px] shadow-[0_6px_18px_rgba(0,0,0,0.75)] py-1 text-white border border-white/[0.04]"
          >
            {!showAccelSubmenu ? (
              <>
                {/* 1. HW+ with right triangle arrow */}
                <button
                  type="button"
                  onClick={() => setShowAccelSubmenu(true)}
                  className="w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors flex items-center justify-between"
                >
                  <span className="flex items-center gap-1.5">
                    <span>{accelMode}</span>
                    <span className="text-[11px] text-[#A0A0A0]">
                      {accelMode === 'SW' ? '(Software)' : accelMode === 'HW' ? '(Direct)' : '(Auto)'}
                    </span>
                  </span>
                  <svg
                    viewBox="0 0 24 24"
                    className="w-4 h-4 fill-white shrink-0"
                    aria-hidden="true"
                  >
                    <path d="M10 17l5-5-5-5v10z" />
                  </svg>
                </button>

                {/* 2. Lock screen */}
                <button
                  type="button"
                  onClick={() => {
                    setShowMoreMenu(false);
                    setIsScreenLocked(true);
                    triggerPlayerToast('Screen locked');
                  }}
                  className="w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                >
                  Lock screen
                </button>

                {/* 3. Sleep timer */}
                <button
                  type="button"
                  onClick={() => {
                    setShowMoreMenu(false);
                    triggerPlayerToast('Sleep timer: Off');
                  }}
                  className="w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                >
                  Sleep timer
                </button>

                {/* 4. Picture-in-picture mode */}
                <button
                  type="button"
                  onClick={async () => {
                    setShowMoreMenu(false);
                    try {
                      if (
                        videoRef.current &&
                        'requestPictureInPicture' in videoRef.current
                      ) {
                        await (
                          videoRef.current as HTMLVideoElement & {
                            requestPictureInPicture: () => Promise<unknown>;
                          }
                        ).requestPictureInPicture();
                      } else {
                        triggerPlayerToast('Picture-in-picture mode enabled');
                      }
                    } catch {
                      triggerPlayerToast('Picture-in-picture mode');
                    }
                  }}
                  className="w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                >
                  Picture-in-picture mode
                </button>

                {/* 5. Start recording */}
                <button
                  type="button"
                  onClick={() => {
                    setShowMoreMenu(false);
                    setIsRecording((prev) => {
                      const next = !prev;
                      triggerPlayerToast(
                        next ? 'Recording started' : 'Recording stopped'
                      );
                      return next;
                    });
                  }}
                  className="w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                >
                  {isRecording ? 'Stop recording' : 'Start recording'}
                </button>

                {/* 6. Portrait Box Shape */}
                <button
                  type="button"
                  onClick={() => {
                    const nextShape: PortraitBoxShape =
                      portraitBoxShape === 'rectangle-16-9'
                        ? 'square-1-1'
                        : portraitBoxShape === 'square-1-1'
                        ? 'rectangle-4-3'
                        : 'rectangle-16-9';
                    handleSetPortraitBoxShape(nextShape);
                    setShowMoreMenu(false);
                  }}
                  className="w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors flex items-center justify-between"
                >
                  <span>Portrait Box Shape</span>
                  <span className="text-xs text-[#5BAAF5] font-mono font-medium">
                    {portraitBoxShape === 'square-1-1'
                      ? '1:1 Square'
                      : portraitBoxShape === 'rectangle-4-3'
                      ? '4:3 Box'
                      : '16:9 Rect'}
                  </span>
                </button>

                {/* 7. Settings */}
                <button
                  type="button"
                  onClick={() => {
                    setShowMoreMenu(false);
                    setShowControls(false);
                    setShowPlayerSettings(true);
                  }}
                  className="w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                >
                  Settings
                </button>

                {/* 8. Stalker MAC / Portal Token */}
                <button
                  type="button"
                  onClick={() => {
                    setShowMoreMenu(false);
                    setShowControls(false);
                    openStalkerAuthModal();
                  }}
                  className="w-full px-4 py-3 text-left text-[15.5px] font-normal text-[#5BAAF5] hover:bg-white/10 active:bg-white/15 transition-colors flex items-center justify-between"
                >
                  <span>MAC / Portal Token</span>
                  <span className="text-[10px] bg-[#5BAAF5]/20 text-[#5BAAF5] px-1.5 py-0.5 rounded border border-[#5BAAF5]/40 font-mono">
                    AUTH
                  </span>
                </button>
              </>
            ) : (
              /* Submenu for HW / HW+ / SW acceleration modes */
              <>
                {(['HW+', 'HW', 'SW'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      handleSetAccelMode(mode);
                      setShowAccelSubmenu(false);
                      setShowMoreMenu(false);
                    }}
                    className="w-full px-4 py-3 text-left text-[14.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors flex items-center justify-between"
                  >
                    <div className="flex flex-col">
                      <span className="font-medium text-white">
                        {mode === 'SW'
                          ? 'SW (Software Decoder)'
                          : mode === 'HW'
                          ? 'HW (Hardware Decoder)'
                          : 'HW+ (Smart Auto)'}
                      </span>
                      <span className="text-[11px] text-[#A0A0A0]">
                        {mode === 'SW'
                          ? 'Software decoder for universal playback'
                          : mode === 'HW'
                          ? 'Direct hardware playback'
                          : 'Auto hardware with software fallback'}
                      </span>
                    </div>
                    {accelMode === mode && (
                      <span className="w-2.5 h-2.5 rounded-full bg-[#5BAAF5] shrink-0 ml-2" />
                    )}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          CENTER IN-PLAYER SETTINGS OVERLAY
          Exact Match to Screenshot_20261009-204818_IPTV.jpg
          (Brightness: 65%, Aspect ratio: Best Fit, Scale: 100%, Show clock: Never, RESET)
         ===================================================================== */}
      {showPlayerSettings && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            setShowPlayerSettings(false);
          }}
          className="fixed inset-0 z-40 flex items-center justify-center bg-transparent"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[340px] max-w-[90vw] bg-black/75 px-8 pt-6 pb-5 text-white shadow-2xl"
          >
            {/* 1. Brightness: 65% */}
            <div className="mb-5">
              <p className="text-[13.5px] font-normal text-[#E0E0E0] text-center mb-3">
                Brightness: {brightness}%
              </p>
              <div className="relative w-full h-4 flex items-center">
                <div className="w-full h-[2.5px] bg-white" />
                <div
                  className="absolute w-[13px] h-[13px] rounded-full bg-[#4EA1F3] shadow pointer-events-none -translate-x-1/2"
                  style={{ left: `${brightness}%` }}
                />
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={brightness}
                  onChange={(e) => setBrightness(Number(e.target.value))}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </div>
            </div>

            {/* 2. Aspect ratio: Best Fit */}
            <div className="mb-5">
              <p className="text-[13.5px] font-normal text-[#E0E0E0] text-center mb-3">
                Aspect ratio: {ASPECT_RATIO_LABELS[aspectRatioIdx]}
              </p>
              <div className="relative w-full h-4 flex items-center">
                <div className="w-full h-[2.5px] bg-white" />
                <div
                  className="absolute w-[13px] h-[13px] rounded-full bg-[#4EA1F3] shadow pointer-events-none -translate-x-1/2"
                  style={{
                    left: `${(aspectRatioIdx / (ASPECT_RATIO_LABELS.length - 1)) * 100}%`,
                  }}
                />
                <input
                  type="range"
                  min={0}
                  max={ASPECT_RATIO_LABELS.length - 1}
                  step={1}
                  value={aspectRatioIdx}
                  onChange={(e) => setAspectRatioIdx(Number(e.target.value))}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </div>
            </div>

            {/* 3. Scale: 100% (range 50 to 200 so 100% sits at 1/3 from left as in screenshot) */}
            <div className="mb-5">
              <p className="text-[13.5px] font-normal text-[#E0E0E0] text-center mb-3">
                Scale: {videoScale}%
              </p>
              <div className="relative w-full h-4 flex items-center">
                <div className="w-full h-[2.5px] bg-white" />
                <div
                  className="absolute w-[13px] h-[13px] rounded-full bg-[#4EA1F3] shadow pointer-events-none -translate-x-1/2"
                  style={{
                    left: `${((videoScale - 50) / 150) * 100}%`,
                  }}
                />
                <input
                  type="range"
                  min={50}
                  max={200}
                  step={1}
                  value={videoScale}
                  onChange={(e) => setVideoScale(Number(e.target.value))}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </div>
            </div>

            {/* 4. Show clock: Never */}
            <div className="mb-5">
              <p className="text-[13.5px] font-normal text-[#E0E0E0] text-center mb-3">
                Show clock: {SHOW_CLOCK_LABELS[showClockIdx]}
              </p>
              <div className="relative w-full h-4 flex items-center">
                <div className="w-full h-[2.5px] bg-white" />
                <div
                  className="absolute w-[13px] h-[13px] rounded-full bg-[#4EA1F3] shadow pointer-events-none -translate-x-1/2"
                  style={{
                    left: `${(showClockIdx / (SHOW_CLOCK_LABELS.length - 1)) * 100}%`,
                  }}
                />
                <input
                  type="range"
                  min={0}
                  max={SHOW_CLOCK_LABELS.length - 1}
                  step={1}
                  value={showClockIdx}
                  onChange={(e) => setShowClockIdx(Number(e.target.value))}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </div>
            </div>

            {/* 5. Portrait Box Configuration (केवल पोर्ट्रेट मोड के लिए चौकोर / आयताकार बॉक्स) */}
            <div className="mb-5 pt-3 border-t border-white/10">
              <p className="text-[13.5px] font-normal text-[#E0E0E0] text-center mb-1.5">
                Portrait Box (पोर्ट्रेट बॉक्स)
              </p>
              <p className="text-[11px] text-[#9E9E9E] text-center mb-3">
                केवल पोर्ट्रेट मोड में वीडियो बीच में बॉक्स में रहेगा, पूरी स्क्रीन पर नहीं फैलेगा
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  onClick={() => handleSetPortraitBoxShape('rectangle-16-9')}
                  className={`px-2 py-2 rounded-[3px] text-center transition-colors border cursor-pointer ${
                    portraitBoxShape === 'rectangle-16-9'
                      ? 'bg-[#5BAAF5] text-black border-[#5BAAF5] font-semibold'
                      : 'bg-white/5 text-white/80 border-white/10 hover:bg-white/10'
                  }`}
                >
                  <span className="block text-[12px]">16:9 Rect</span>
                  <span className="block text-[10px] opacity-75">आयताकार</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSetPortraitBoxShape('square-1-1')}
                  className={`px-2 py-2 rounded-[3px] text-center transition-colors border cursor-pointer ${
                    portraitBoxShape === 'square-1-1'
                      ? 'bg-[#5BAAF5] text-black border-[#5BAAF5] font-semibold'
                      : 'bg-white/5 text-white/80 border-white/10 hover:bg-white/10'
                  }`}
                >
                  <span className="block text-[12px]">1:1 Square</span>
                  <span className="block text-[10px] opacity-75">चौकोर</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSetPortraitBoxShape('rectangle-4-3')}
                  className={`px-2 py-2 rounded-[3px] text-center transition-colors border cursor-pointer ${
                    portraitBoxShape === 'rectangle-4-3'
                      ? 'bg-[#5BAAF5] text-black border-[#5BAAF5] font-semibold'
                      : 'bg-white/5 text-white/80 border-white/10 hover:bg-white/10'
                  }`}
                >
                  <span className="block text-[12px]">4:3 Box</span>
                  <span className="block text-[10px] opacity-75">आयताकार</span>
                </button>
              </div>
            </div>

            {/* 6. FFmpeg Transcoding Configuration (सभी चैनल्स को H.264 वीडियो और AAC ऑडियो में ट्रांसकोड करें) */}
            <div className="mb-5 pt-3 border-t border-white/10">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[13.5px] font-normal text-[#E0E0E0]">
                  FFmpeg Transcoding (ट्रांसकोडिंग)
                </p>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#4EA1F3]/20 text-[#5BAAF5] border border-[#5BAAF5]/30">
                  H.264 + AAC
                </span>
              </div>
              <p className="text-[11px] text-[#9E9E9E] mb-3">
                सभी स्ट्रीम्स को सही H.264 वीडियो और AAC ऑडियो में ट्रांसकोड करें ताकि ऑडियो और वीडियो दोनों सुचारू रूप से चलें
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  onClick={() => handleSetTranscodeMode('auto')}
                  className={`px-2 py-2 rounded-[3px] text-center transition-colors border cursor-pointer ${
                    transcodeMode === 'auto'
                      ? 'bg-[#5BAAF5] text-black border-[#5BAAF5] font-semibold'
                      : 'bg-white/5 text-white/80 border-white/10 hover:bg-white/10'
                  }`}
                >
                  <span className="block text-[12px]">Auto (स्मार्ट)</span>
                  <span className="block text-[10px] opacity-75">स्वतः</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSetTranscodeMode('force-all')}
                  className={`px-2 py-2 rounded-[3px] text-center transition-colors border cursor-pointer ${
                    transcodeMode === 'force-all'
                      ? 'bg-[#5BAAF5] text-black border-[#5BAAF5] font-semibold'
                      : 'bg-white/5 text-white/80 border-white/10 hover:bg-white/10'
                  }`}
                >
                  <span className="block text-[12px]">Force FFmpeg</span>
                  <span className="block text-[10px] opacity-75">सभी चैनल्स</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSetTranscodeMode('direct')}
                  className={`px-2 py-2 rounded-[3px] text-center transition-colors border cursor-pointer ${
                    transcodeMode === 'direct'
                      ? 'bg-[#5BAAF5] text-black border-[#5BAAF5] font-semibold'
                      : 'bg-white/5 text-white/80 border-white/10 hover:bg-white/10'
                  }`}
                >
                  <span className="block text-[12px]">Direct Play</span>
                  <span className="block text-[10px] opacity-75">बिना ट्रांसकोड</span>
                </button>
              </div>
            </div>

            {/* 7. Stalker Portal & MAC Authentication Quick Action */}
            <div className="mb-5 pt-3 border-t border-white/10">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[13.5px] font-normal text-[#E0E0E0]">
                  Stalker & MAC Portal Auth
                </p>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#4EA1F3]/20 text-[#5BAAF5] border border-[#5BAAF5]/30">
                  STB MAC / TOKEN
                </span>
              </div>
              <p className="text-[11px] text-[#9E9E9E] mb-2.5">
                स्टॉकर पोर्टल और टोकन प्रमाणीकरण कॉन्फ़िगर करें
              </p>
              <button
                type="button"
                onClick={() => {
                  setShowPlayerSettings(false);
                  openStalkerAuthModal();
                }}
                className="w-full py-2 px-3 rounded-[3px] bg-[#5BAAF5]/20 hover:bg-[#5BAAF5]/30 active:bg-[#5BAAF5]/40 text-[#5BAAF5] border border-[#5BAAF5]/40 text-[12.5px] font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <span>⚙️ Configure Stalker MAC / Token (सेटिंग्स)</span>
              </button>
            </div>

            {/* Bottom-right RESET button */}
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setBrightness(65);
                  setAspectRatioIdx(0);
                  setVideoScale(100);
                  setShowClockIdx(0);
                  handleSetPortraitBoxShape('rectangle-16-9');
                  handleSetTranscodeMode('auto');
                }}
                className="px-2 py-1 text-[13px] font-medium text-white uppercase tracking-wide hover:bg-white/10 active:bg-white/20 rounded transition-colors"
              >
                RESET
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stalker Portal & MAC Authentication Modal */}
      {showStalkerModal && (
        <div
          onClick={() => setShowStalkerModal(false)}
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[520px] max-w-[92vw] bg-[#383838] rounded-[3px] shadow-[0_16px_40px_rgba(0,0,0,0.85)] p-5 text-white border border-white/10"
          >
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <h3 className="text-[17px] font-medium text-white flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-[#5BAAF5]" />
                Stalker Portal & Token Settings (कॉन्फ़िगरेशन)
              </h3>
              <button
                type="button"
                onClick={() => setShowStalkerModal(false)}
                className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10 text-[#CCCCCC]"
              >
                ✕
              </button>
            </div>

            <div className="py-3 space-y-4">
              {/* MAC Address */}
              <div>
                <label className="block text-[12.5px] font-medium text-[#B0B0B0] mb-1">
                  Stalker MAC Address (STB MAC पता)
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={stalkerMacDraft}
                    onChange={(e) => setStalkerMacDraft(e.target.value.toUpperCase())}
                    placeholder="00:1A:79:XX:XX:XX"
                    className="w-full bg-[#242424] text-white text-[15px] font-mono px-3 py-2 rounded-[2px] border border-white/20 focus:border-[#5BAAF5] outline-none"
                  />
                  {stalkerMacDraft && (
                    <button
                      type="button"
                      onClick={() => setStalkerMacDraft('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-[#999] hover:text-white px-1.5 py-0.5"
                    >
                      CLEAR
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <span className="text-[11px] text-[#888]">Presets:</span>
                  {['00:1A:79:00:00:01', '00:1A:79:A1:B2:C3', '00:1A:79:5B:C2:E4'].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setStalkerMacDraft(preset)}
                      className="text-[10.5px] font-mono text-[#5BAAF5] bg-white/5 hover:bg-white/10 px-1.5 py-0.5 rounded"
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              {/* Portal Token */}
              <div>
                <label className="block text-[12.5px] font-medium text-[#B0B0B0] mb-1">
                  Portal / Stream Token (प्रमाणीकरण टोकन)
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={stalkerTokenDraft}
                    onChange={(e) => setStalkerTokenDraft(e.target.value)}
                    placeholder="play_token, wmsAuthSign, or Bearer token..."
                    className="w-full bg-[#242424] text-white text-[14px] px-3 py-2 rounded-[2px] border border-white/20 focus:border-[#5BAAF5] outline-none"
                  />
                  {stalkerTokenDraft && (
                    <button
                      type="button"
                      onClick={() => setStalkerTokenDraft('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-[#999] hover:text-white px-1.5 py-0.5"
                    >
                      CLEAR
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-[#888] mt-1">
                  URL में मौजूद या प्रदाता द्वारा दिया गया टोकन (जैसे ?token=... या wmsAuthSign)
                </p>
              </div>

              {/* STB Device Model */}
              <div>
                <label className="block text-[12.5px] font-medium text-[#B0B0B0] mb-1">
                  STB Emulation Device (सेट-टॉप बॉक्स मॉडल)
                </label>
                <select
                  value={stalkerModelDraft}
                  onChange={(e) => setStalkerModelDraft(e.target.value)}
                  className="w-full bg-[#242424] text-white text-[14px] px-3 py-2 rounded-[2px] border border-white/20 focus:border-[#5BAAF5] outline-none"
                >
                  {STB_MODELS.map((m) => (
                    <option key={m} value={m} className="bg-[#242424] text-white">
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="pt-3 border-t border-white/10 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  setDefaultStalkerAuthSettings({ mac: '', token: '' });
                  setStalkerMacDraft('');
                  setStalkerTokenDraft('');
                  setPlayerToast('Authentication cleared');
                }}
                className="px-3 py-1.5 text-xs text-[#E57373] hover:bg-white/5 rounded font-medium"
              >
                RESET ALL
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowStalkerModal(false)}
                  className="px-3 py-1.5 text-[13px] text-[#B0B0B0] hover:bg-white/10 rounded font-medium"
                >
                  CANCEL
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleSaveStalkerAuth();
                  }}
                  className="px-4 py-1.5 text-[13px] bg-[#5BAAF5] hover:bg-[#4a97dd] text-[#212121] rounded font-semibold transition-colors"
                >
                  SAVE & PLAY (सेव करें)
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Unlock button when screen is locked */}
      {isScreenLocked && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            setIsScreenLocked(false);
            triggerPlayerToast('Screen unlocked');
          }}
          className="fixed top-4 left-4 z-40 w-11 h-11 rounded-full bg-black/60 border border-white/20 flex items-center justify-center text-white cursor-pointer hover:bg-black/80"
          title="Unlock screen"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current">
            <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
          </svg>
        </div>
      )}

      {/* Subtle Toast inside Player */}
      {playerToast && (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-40 bg-[#212121]/90 text-white text-sm px-4 py-2 rounded shadow-lg pointer-events-none">
          {playerToast}
        </div>
      )}
    </div>
  );
};
