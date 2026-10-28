import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  ArrowLeft,
  Menu,
  Plus,
  Check,
  ChevronUp,
  ChevronDown,
  Tv,
  ListMusic,
  Star,
  Settings,
  Search,
  List,
  Trash2,
  MoreVertical,
  Folder,
  X,
} from 'lucide-react';
import {
  Channel,
  Playlist,
  DEFAULT_PLAYER_USER_AGENT,
  parsePlaylistContent,
  SAMPLE_M3U_CONTENT,
  isYouTubeChannelUrl,
  openExternalChannelLink,
  repairAndNormalizeChannel,
  extractUrlAndPipeHeaders,
  normalizeMacAddress,
  buildMacCookieHeader,
  getDefaultStalkerAuthSettings,
  setDefaultStalkerAuthSettings,
  STB_MODELS,
} from './utils/playlistParser';
import { INITIAL_YAARO_PLAYLIST } from './utils/yaaroPlaylist';
import { VideoPlayerModal } from './components/VideoPlayerModal';
import { CastModal } from './components/CastModal';
import { castManager, CastSessionState } from './utils/castManager';
import {
  canUseBackendProxy,
  ensureBackendProbed,
  fetchWithUniversalFallback,
  getEffectiveApiBaseUrl,
  isDirectVodChannel,
  buildChannelProxyUrl,
  isStaticHostEnvironment,
} from './utils/proxyHelper';
import {
  parseRemoteKeyEvent,
  focusTvElement,
  findFirstTvElement,
  findNextSpatialElement,
  isTypingInInput,
} from './utils/tvNavigation';

type ScreenMode =
  | 'playlists'
  | 'add_url'
  | 'xtream_login'
  | 'file_picker'
  | 'channels'
  | 'settings'
  | 'video_player_prefs'
  | 'epg_sources'
  | 'proxy_settings'
  | 'parental_control';
type ChannelsTab =
  | 'FAVORITES'
  | 'HOME'
  | 'ALL_CHANNELS'
  | 'LIVE'
  | 'SERIES'
  | 'VOD'
  | 'CATEGORIES';
type ModalMode = null | 'add_menu' | 'more_menu' | 'epg_add_menu';

const CATCHUP_MODES = [
  'Autodetect',
  'Template',
  'None',
];

const STORAGE_KEY_PLAYLISTS = 'iptv_app_playlists_v5_yaaro';
const STORAGE_KEY_FAVORITES = 'iptv_app_favorites_v5';
const STORAGE_KEY_ACTIVE_PLAYLIST = 'iptv_app_active_playlist_v5';

// Deterministic vibrant colors for channel tile initials (matching 1.mp4 frame 02:13-02:16)
const TILE_INITIAL_COLORS = [
  '#00BCD4', // Cyan
  '#4CAF50', // Green
  '#FFEB3B', // Yellow
  '#FF9800', // Orange
  '#E91E63', // Pink
  '#BA68C8', // Purple
  '#2196F3', // Blue
  '#F44336', // Red
  '#8BC34A', // Light Green
  '#FF5722', // Deep Orange
  '#009688', // Teal
  '#4DD0E1', // Sky Cyan
];

function getTileLetterColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % TILE_INITIAL_COLORS.length;
  return TILE_INITIAL_COLORS[idx];
}

/**
 * Renders a channel logo matching the video / screenshot look,
 * with vibrant initial letter fallback matching 1.mp4 (e.g. "A" in colored outline).
 */
const ChannelTileLogo: React.FC<{ channel: Channel }> = ({ channel }) => {
  const [imgError, setImgError] = useState(false);
  const isFavPlaceholder = /\bFAV\b/i.test(channel.name);

  if (channel.logo && !imgError) {
    return (
      <div className="w-[58px] h-[58px] flex items-center justify-center overflow-hidden shrink-0">
        <img
          src={channel.logo}
          alt={channel.name}
          referrerPolicy="no-referrer"
          onError={() => setImgError(true)}
          className="w-full h-full object-contain"
        />
      </div>
    );
  }

  if (isFavPlaceholder) {
    return (
      <div className="w-[58px] h-[58px] flex items-center justify-center shrink-0">
        <svg viewBox="0 0 24 24" className="w-10 h-10 fill-[#FBC02D]" aria-hidden="true">
          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
        </svg>
      </div>
    );
  }

  // Exact match to 1.mp4 (Frame 02:13 - 02:16): Large single letter in vibrant color
  const firstLetter = (channel.name.trim().charAt(0) || 'A').toUpperCase();
  const letterColor = getTileLetterColor(channel.name);

  return (
    <div className="w-[58px] h-[58px] flex items-center justify-center shrink-0 select-none">
      <span
        style={{ color: letterColor }}
        className="text-[38px] font-sans font-light leading-none drop-shadow-[0_2px_4px_rgba(0,0,0,0.6)]"
      >
        {firstLetter}
      </span>
    </div>
  );
};

export function getDetectedCurrentDeviceName(): string {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'SM-T580';
  }

  const ua = navigator.userAgent || '';
  const platform = (navigator as any).userAgentData?.platform || navigator.platform || '';

  // 1. Android specific model extraction
  const androidModelMatch = ua.match(
    /Android[^;)]*;(?:\s*[^;)]*;)*\s*([A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+)*)\s*(?:Build|[;)])/i
  );
  if (androidModelMatch && androidModelMatch[1]) {
    const raw = androidModelMatch[1].trim();
    if (raw && !/^(?:K|wv|Mobile|en-us|en-gb|Release|Linux|Version|arm_64|x86_64)$/i.test(raw)) {
      if (/^SM-[A-Z0-9]+/i.test(raw)) {
        return `Samsung ${raw}`;
      }
      return raw;
    }
  }

  // Common mobile / TV hardware patterns
  const patterns = [
    /\b(SM-[A-Z0-9]+)\b/i,
    /\b(Pixel\s*[0-9a-zA-Z\s]+)\b/i,
    /\b(Redmi\s*[0-9a-zA-Z\s]+)\b/i,
    /\b(POCO\s*[0-9a-zA-Z\s]+)\b/i,
    /\b(OnePlus\s*[0-9a-zA-Z\s]+)\b/i,
    /\b(Mi\s*[0-9a-zA-Z\s]+)\b/i,
    /\b(Moto\s*[0-9a-zA-Z\s]+)\b/i,
    /\b(AFT[A-Z0-9]+)\b/i,
    /\b(SHIELD\s*Android\s*TV)\b/i,
    /\b(BRAVIA)\b/i,
  ];
  for (const regex of patterns) {
    const m = ua.match(regex);
    if (m && m[1]) {
      const val = m[1].trim();
      if (/^SM-/i.test(val)) return `Samsung ${val}`;
      if (/^AFT/i.test(val)) return `Amazon Fire TV (${val})`;
      return val;
    }
  }

  // 2. Apple devices
  if (/iPad/i.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
    return 'Apple iPad';
  }
  if (/iPhone/i.test(ua)) {
    return 'Apple iPhone';
  }
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) {
    return 'Apple Mac';
  }

  // 3. Smart TVs
  if (/Tizen/i.test(ua)) return 'Samsung Smart TV (Tizen)';
  if (/Web0S/i.test(ua)) return 'LG Smart TV (webOS)';
  if (/Android TV|GoogleTV|SmartTV|AppleTV/i.test(ua)) return 'Android Smart TV';

  // 4. Windows PC
  if (/Win/i.test(platform) || /Windows/i.test(ua)) {
    if (/Windows NT 10.0/i.test(ua)) return 'Windows 11 / 10 PC';
    return 'Windows PC';
  }

  // 5. ChromeOS
  if (/CrOS/i.test(ua)) {
    return 'Chromebook (ChromeOS)';
  }

  // 6. Generic Linux / Android
  if (/Android/i.test(ua)) {
    return 'Android Device';
  }
  if (/Linux/i.test(platform) || /Linux/i.test(ua)) {
    return 'Linux PC';
  }

  return 'Local Web Device';
}

export function normalizeSourceUrl(url?: string): string {
  if (!url) return '';
  let clean = url.trim().toLowerCase();
  // Strip pipe headers e.g. |User-Agent=...
  if (clean.includes('|')) {
    clean = clean.split('|')[0].trim();
  }
  // Strip protocol
  clean = clean.replace(/^https?:\/\//i, '');
  // Strip default web ports if present
  clean = clean.replace(/:80(?=\/|$)/, '').replace(/:443(?=\/|$)/, '');
  // Strip trailing slashes
  clean = clean.replace(/\/+$/, '');
  return clean;
}

export function areSourceUrlsEquivalent(url1?: string, url2?: string): boolean {
  if (!url1 || !url2) return false;
  const n1 = normalizeSourceUrl(url1);
  const n2 = normalizeSourceUrl(url2);
  if (!n1 || !n2) return false;
  if (n1 === n2) return true;

  const [base1, query1] = n1.split('?');
  const [base2, query2] = n2.split('?');

  if (base1 === base2) {
    if (!query1 || !query2) return true;
    try {
      const p1 = new URLSearchParams(query1);
      const p2 = new URLSearchParams(query2);
      const u1 = p1.get('username') || p1.get('user');
      const u2 = p2.get('username') || p2.get('user');
      if (u1 && u2) return u1.toLowerCase() === u2.toLowerCase();
      return true;
    } catch {
      return true;
    }
  }

  // Check if one is base server and other is get.php on same host:port
  const host1 = base1.split('/')[0];
  const host2 = base2.split('/')[0];
  if (host1 && host2 && host1 === host2) {
    const path1 = base1.substring(host1.length);
    const path2 = base2.substring(host2.length);
    const isXtreamPath1 = !path1 || path1 === '/get.php' || path1 === '/';
    const isXtreamPath2 = !path2 || path2 === '/get.php' || path2 === '/';
    if (isXtreamPath1 && isXtreamPath2) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if two playlists are duplicates of each other based on:
 * - Same ID
 * - Both being the built-in Yaaro playlist
 * - Equivalent source URLs
 * - Matching Xtream server host + credentials
 * - Matching playlist name
 * - Matching stream channel URLs
 */
export function arePlaylistsMatching(
  p1: Partial<Playlist>,
  p2: Partial<Playlist>
): boolean {
  if (!p1 || !p2) return false;

  // 1. Exact ID match
  if (p1.id && p2.id && p1.id === p2.id) return true;

  // 2. Both are Yaaro Initial Playlist
  const isYaaro1 =
    p1.id === INITIAL_YAARO_PLAYLIST.id ||
    p1.id?.includes('yaaro') ||
    p1.name?.toLowerCase().includes('yaaro');
  const isYaaro2 =
    p2.id === INITIAL_YAARO_PLAYLIST.id ||
    p2.id?.includes('yaaro') ||
    p2.name?.toLowerCase().includes('yaaro');
  if (isYaaro1 && isYaaro2) return true;

  // 3. URLs match / equivalent
  if (p1.sourceUrl && p2.sourceUrl) {
    if (areSourceUrlsEquivalent(p1.sourceUrl, p2.sourceUrl)) {
      return true;
    }
  }

  // 4. Xtream user & server match
  const getXtreamInfo = (pl: Partial<Playlist>) => {
    let user: string | null = null;
    let host: string | null = null;
    const fromChannel = pl.channels?.find((c) => c.xtreamParams?.username);
    if (fromChannel?.xtreamParams?.username) {
      user = fromChannel.xtreamParams.username.toLowerCase();
    }
    if (pl.sourceUrl) {
      const norm = normalizeSourceUrl(pl.sourceUrl);
      host = norm.split('/')[0] || null;
      if (!user && norm.includes('username=')) {
        try {
          const qs = norm.split('?')[1] || '';
          const sp = new URLSearchParams(qs);
          user = sp.get('username')?.toLowerCase() || null;
        } catch {
          // ignore
        }
      }
    }
    return { user, host };
  };

  const x1 = getXtreamInfo(p1);
  const x2 = getXtreamInfo(p2);
  if (x1.host && x2.host && x1.host === x2.host) {
    if (x1.user && x2.user && x1.user === x2.user) {
      return true;
    }
    if (!x1.user || !x2.user) {
      if (
        p1.sourceUrl?.includes('get.php') ||
        p2.sourceUrl?.includes('get.php') ||
        p1.id?.startsWith('pl-xtream-') ||
        p2.id?.startsWith('pl-xtream-')
      ) {
        return true;
      }
    }
  }

  // 5. Matching Playlist Name (case-insensitive, trimmed)
  const name1 = p1.name?.trim().toLowerCase();
  const name2 = p2.name?.trim().toLowerCase();
  if (name1 && name2 && name1 === name2) {
    if (p1.sourceUrl && p2.sourceUrl) {
      const host1 = normalizeSourceUrl(p1.sourceUrl).split('/')[0];
      const host2 = normalizeSourceUrl(p2.sourceUrl).split('/')[0];
      if (host1 && host2 && host1 !== host2) {
        return false;
      }
    }
    return true;
  }

  // 6. Matching channels content (if both have channels and channel URLs match)
  if (
    Array.isArray(p1.channels) &&
    p1.channels.length > 0 &&
    Array.isArray(p2.channels) &&
    p2.channels.length > 0
  ) {
    const c1Urls = p1.channels.slice(0, 5).map((c) => c.url.trim().toLowerCase()).filter(Boolean);
    const c2UrlSet = new Set(p2.channels.map((c) => c.url.trim().toLowerCase()));
    if (c1Urls.length > 0) {
      const matches = c1Urls.filter((u) => c2UrlSet.has(u)).length;
      if (matches >= Math.min(2, c1Urls.length)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Ensures playlists are deduplicated across the entire application.
 * If any playlist matches an existing one, only ONE copy is retained!
 */
export function deduplicatePlaylists(list: Playlist[]): Playlist[] {
  const result: Playlist[] = [];

  for (const pl of list) {
    if (!pl || !pl.id) continue;

    const existingIndex = result.findIndex((item) => arePlaylistsMatching(item, pl));
    if (existingIndex >= 0) {
      const existing = result[existingIndex];
      const channels =
        Array.isArray(pl.channels) && pl.channels.length > 0
          ? pl.channels
          : existing.channels || [];
      result[existingIndex] = {
        ...existing,
        ...pl,
        id: existing.id, // maintain stable existing ID
        channels,
        name: pl.name && pl.name !== 'get.php' ? pl.name : existing.name,
        sourceUrl: pl.sourceUrl || existing.sourceUrl,
        addedAt: Math.min(existing.addedAt || Date.now(), pl.addedAt || Date.now()),
      };
    } else {
      result.push(pl);
    }
  }

  return result;
}

/**
 * Upserts a playlist into a list while strictly guaranteeing no duplicates are created.
 * If the playlist already exists (by URL, name, Xtream user, or channel fingerprint),
 * it updates the existing playlist in-place.
 */
export function upsertPlaylistWithoutDuplicates(
  list: Playlist[],
  playlistToUpsert: Playlist
): Playlist[] {
  let matched = false;
  const updatedList = list.map((item) => {
    if (arePlaylistsMatching(item, playlistToUpsert)) {
      matched = true;
      const channels =
        Array.isArray(playlistToUpsert.channels) && playlistToUpsert.channels.length > 0
          ? playlistToUpsert.channels
          : item.channels || [];
      return {
        ...item,
        ...playlistToUpsert,
        id: item.id, // maintain stable existing ID
        channels,
        name:
          playlistToUpsert.name && playlistToUpsert.name !== 'get.php'
            ? playlistToUpsert.name
            : item.name,
        sourceUrl: playlistToUpsert.sourceUrl || item.sourceUrl,
        addedAt: item.addedAt || playlistToUpsert.addedAt || Date.now(),
      };
    }
    return item;
  });

  const nextList = matched ? updatedList : [...list, playlistToUpsert];
  return deduplicatePlaylists(nextList);
}

export default function App() {
  // Start on the exact "Playlists" screen shown in the user's first screenshot
  const [screen, setScreen] = useState<ScreenMode>('playlists');
  const [channelsTab, setChannelsTab] = useState<ChannelsTab>('HOME');

  const [playlists, setPlaylists] = useState<Playlist[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_PLAYLISTS);
      if (!saved) return [INITIAL_YAARO_PLAYLIST];
      const parsed = JSON.parse(saved) as Playlist[];
      if (!Array.isArray(parsed) || parsed.length === 0) return [INITIAL_YAARO_PLAYLIST];
      
      const mapped = parsed.map((pl) => {
        if (
          pl.id === INITIAL_YAARO_PLAYLIST.id ||
          pl.id.includes('yaaro') ||
          pl.name.toLowerCase().includes('yaaro')
        ) {
          return {
            ...INITIAL_YAARO_PLAYLIST,
            ...pl,
            channels: INITIAL_YAARO_PLAYLIST.channels,
          };
        }
        return {
          ...pl,
          channels: Array.isArray(pl.channels)
            ? pl.channels.map((ch) => repairAndNormalizeChannel(ch))
            : [],
        };
      });

      const deduplicated = deduplicatePlaylists(mapped);

      const hasYaaro = deduplicated.some(
        (pl) =>
          pl.id === INITIAL_YAARO_PLAYLIST.id ||
          pl.id.includes('yaaro') ||
          pl.name.toLowerCase().includes('yaaro')
      );

      const finalPlaylists = hasYaaro ? deduplicated : [INITIAL_YAARO_PLAYLIST, ...deduplicated];
      try {
        localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(finalPlaylists));
      } catch {
        // ignore
      }
      return finalPlaylists;
    } catch {
      return [INITIAL_YAARO_PLAYLIST];
    }
  });
  const [activePlaylistId, setActivePlaylistId] = useState<string | null>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_ACTIVE_PLAYLIST);
      return saved || INITIAL_YAARO_PLAYLIST.id;
    } catch {
      return INITIAL_YAARO_PLAYLIST.id;
    }
  });
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_FAVORITES);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // UI & Popup Menu states
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [parentalControl, setParentalControl] = useState(false);
  const [aboutModalOpen, setAboutModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [openPlaylistMenuId, setOpenPlaylistMenuId] = useState<string | null>(null);
  const [editingPlaylist, setEditingPlaylist] = useState<Playlist | null>(null);
  const [editNameValue, setEditNameValue] = useState('');

  // Add URL Full-Screen Form state (matching Screenshot 3 & 4)
  const [urlInput, setUrlInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [urlFocused, setUrlFocused] = useState(true);
  const [catchupExpanded, setCatchupExpanded] = useState(true);
  const [catchupType, setCatchupType] = useState('Autodetect');
  const [catchupDropdownOpen, setCatchupDropdownOpen] = useState(false);
  const [catchupDays, setCatchupDays] = useState('');

  // Xtream Codes Login Form state (matching Screenshot 5)
  const [xtreamServer, setXtreamServer] = useState('');
  const [xtreamServerFocused, setXtreamServerFocused] = useState(true);
  const [xtreamUsername, setXtreamUsername] = useState('');
  const [xtreamPassword, setXtreamPassword] = useState('');
  const [showXtreamPassword, setShowXtreamPassword] = useState(false);
  const [xtreamName, setXtreamName] = useState('');
  const [xtreamStreamFormat, setXtreamStreamFormat] = useState<'TS' | 'HLS'>('TS');
  const [xtreamFormatDropdownOpen, setXtreamFormatDropdownOpen] = useState(false);
  const [importLiveChannels, setImportLiveChannels] = useState(true);
  const [importSeries, setImportSeries] = useState(true);
  const [importVods, setImportVods] = useState(true);

  const [isLoadingPlaylist, setIsLoadingPlaylist] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Channels View states (default to 'grid' to match Screenshot 6!)
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearchBar, setShowSearchBar] = useState(false);
  const [viewLayout, setViewLayout] = useState<'grid' | 'list'>('grid');
  const [showChannelNumbers, setShowChannelNumbers] = useState(false);
  const [autoOpenChannels, setAutoOpenChannels] = useState(true);
  const [prevScreenBeforeSettings, setPrevScreenBeforeSettings] = useState<ScreenMode>('playlists');

  // Exact Settings states matching 1.jpg, 2.jpg, 3.jpg
  const [useExternalPlayer, setUseExternalPlayer] = useState(false);
  const [externalPlayerName, setExternalPlayerName] = useState('MX Player');
  const [startPage, setStartPage] = useState('All Channels');
  const [categoriesViewMode, setCategoriesViewMode] = useState('List');
  const [showRecentChannels, setShowRecentChannels] = useState(true);
  const [fastScroll, setFastScroll] = useState(false);
  const [optimizeUiForTv, setOptimizeUiForTv] = useState(false);
  const [checkWifiState, setCheckWifiState] = useState(true);
  const [refreshPlaylistFreq, setRefreshPlaylistFreq] = useState('Once per week');
  const [startOnBoot, setStartOnBoot] = useState(false);
  const [autoPlayLastChannel, setAutoPlayLastChannel] = useState(false);
  const [pressBackTwice, setPressBackTwice] = useState(false);
  const [favIdMode, setFavIdMode] = useState('By channel name');
  const [enableCastTranscoding, setEnableCastTranscoding] = useState(true);
  const [appLanguage, setAppLanguage] = useState('System default');
  const [appTheme, setAppTheme] = useState('Dark');
  const [appFontSize, setAppFontSize] = useState('Normal');

  // Video player preferences states matching 1.jpg & 2.jpg
  const [vpScreenOrientation, setVpScreenOrientation] = useState('Auto');
  const [vpAccelMode, setVpAccelMode] = useState('Hardware acceleration (HW+)');
  const [vpAspectRatio, setVpAspectRatio] = useState('Best Fit');
  const [vpAudioLang, setVpAudioLang] = useState('System default');
  const [vpSubtitleLang, setVpSubtitleLang] = useState('Disabled');
  const [vpDpadSwitch, setVpDpadSwitch] = useState(
    'UP - next channel, DOWN - previous channel'
  );
  const [vpAutoHideList, setVpAutoHideList] = useState(false);
  const [vpShowClock, setVpShowClock] = useState('Never');
  const [vpAutoPlayNext, setVpAutoPlayNext] = useState(true);
  const [vpRestoreConn, setVpRestoreConn] = useState(true);
  const [vpVolumeGestures, setVpVolumeGestures] = useState(true);
  const [vpBrightnessGestures, setVpBrightnessGestures] = useState(true);
  const [vpHttpUserAgent, setVpHttpUserAgent] = useState(DEFAULT_PLAYER_USER_AGENT);
  const [vpHttpUserAgentDraft, setVpHttpUserAgentDraft] = useState(DEFAULT_PLAYER_USER_AGENT);
  const [httpUserAgentModalOpen, setHttpUserAgentModalOpen] = useState(false);
  const [epgUrlDraft, setEpgUrlDraft] = useState('');
  const [epgUrlModalOpen, setEpgUrlModalOpen] = useState(false);
  const [useUdpProxy, setUseUdpProxy] = useState(false);
  const [udpProxyModalOpen, setUdpProxyModalOpen] = useState(false);
  const [udpProxyName, setUdpProxyName] = useState('');
  const [udpProxyNameFocused, setUdpProxyNameFocused] = useState(true);
  const [udpProxyHost, setUdpProxyHost] = useState('');
  const [udpProxyPort, setUdpProxyPort] = useState('');
  const [udpProxyType, setUdpProxyType] = useState('UDP-to-HTTP proxy (Windows)');
  const [udpProxyTypeDropdownOpen, setUdpProxyTypeDropdownOpen] = useState(false);
  const [channelsSortMode, setChannelsSortMode] = useState('Default');
  const [moreMenuSortSubmenu, setMoreMenuSortSubmenu] = useState(false);
  const [parentalHideLocked, setParentalHideLocked] = useState(false);
  const [parentalAutolock, setParentalAutolock] = useState(true);

  // Stalker Portal, MAC Address & Token Authentication settings
  const [defaultMacAddress, setDefaultMacAddress] = useState<string>(() => {
    try {
      return localStorage.getItem('iptv_default_mac_address') || '';
    } catch {
      return '';
    }
  });
  const [defaultPortalToken, setDefaultPortalToken] = useState<string>(() => {
    try {
      return localStorage.getItem('iptv_default_portal_token') || '';
    } catch {
      return '';
    }
  });
  const [stbEmulationModel, setStbEmulationModel] = useState<string>(() => {
    try {
      return (
        localStorage.getItem('iptv_stb_emulation_model') ||
        'MAG 250 / 254 (Infomir Ministra)'
      );
    } catch {
      return 'MAG 250 / 254 (Infomir Ministra)';
    }
  });
  const [macSettingsModalOpen, setMacSettingsModalOpen] = useState(false);
  const [tokenSettingsModalOpen, setTokenSettingsModalOpen] = useState(false);
  const [macDraft, setMacDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');

  // Google Cast modal and live session state
  const [castModalOpen, setCastModalOpen] = useState(false);
  const [castSession, setCastSession] = useState<CastSessionState>(castManager.getSessionState());

  useEffect(() => {
    const unsubscribe = castManager.subscribe(() => {
      setCastSession(castManager.getSessionState());
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const handleStalkerAuthChanged = () => {
      try {
        const s = getDefaultStalkerAuthSettings();
        setDefaultMacAddress(s.mac || '');
        setDefaultPortalToken(s.token || '');
        setStbEmulationModel(s.stbModel || 'MAG 250 / 254 (Infomir Ministra)');
      } catch {
        // ignore
      }
    };
    window.addEventListener('iptv-stalker-auth-changed', handleStalkerAuthChanged);
    return () => {
      window.removeEventListener('iptv-stalker-auth-changed', handleStalkerAuthChanged);
    };
  }, []);

  // Active running device detection states
  const [detectedDeviceName, setDetectedDeviceName] = useState<string>(() =>
    getDetectedCurrentDeviceName()
  );
  const [deviceInfoModalOpen, setDeviceInfoModalOpen] = useState(false);
  const [customBackendUrl, setCustomBackendUrl] = useState<string>(() => {
    try {
      return localStorage.getItem('iptv_backend_proxy_url') || '';
    } catch {
      return '';
    }
  });
  const [testingProxy, setTestingProxy] = useState(false);
  const [githubGuideModalOpen, setGithubGuideModalOpen] = useState(false);

  useEffect(() => {
    try {
      const navAny = navigator as any;
      if (navAny?.userAgentData?.getHighEntropyValues) {
        navAny.userAgentData
          .getHighEntropyValues(['model', 'platform'])
          .then((data: any) => {
            if (data?.model && data.model.trim()) {
              const m = data.model.trim();
              setDetectedDeviceName(/^SM-/i.test(m) ? `Samsung ${m}` : m);
            }
          })
          .catch(() => {});
      }
    } catch {
      // ignore
    }
  }, []);

  // Storage Permission Dialog states
  const [storagePermissionGranted, setStoragePermissionGranted] = useState<boolean>(() => {
    try {
      return localStorage.getItem('iptv_storage_permission') === 'granted';
    } catch {
      return false;
    }
  });
  const [showStoragePermissionModal, setShowStoragePermissionModal] = useState(false);
  const [prevScreenBeforeFilePicker, setPrevScreenBeforeFilePicker] =
    useState<ScreenMode>('playlists');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const categoryContentRef = useRef<HTMLDivElement | null>(null);

  const triggerMobileStoragePicker = () => {
    try {
      const input =
        fileInputRef.current ||
        (document.getElementById('iptv-file-input') as HTMLInputElement | null);
      if (input) {
        input.value = '';
        input.click();
      } else {
        const tempInput = document.createElement('input');
        tempInput.type = 'file';
        tempInput.style.position = 'fixed';
        tempInput.style.left = '-9999px';
        tempInput.style.opacity = '0';
        tempInput.onchange = (e) => {
          handleFileChange(e as unknown as React.ChangeEvent<HTMLInputElement>);
          try {
            document.body.removeChild(tempInput);
          } catch {
            // ignore
          }
        };
        document.body.appendChild(tempInput);
        tempInput.click();
      }
    } catch (err) {
      console.error('Failed to trigger mobile storage picker:', err);
    }
  };

  const handleAllowStorage = () => {
    setStoragePermissionGranted(true);
    setShowStoragePermissionModal(false);
    try {
      localStorage.setItem('iptv_storage_permission', 'granted');
    } catch {
      // ignore
    }
    // Directly trigger native mobile file manager to pick files
    triggerMobileStoragePicker();
  };

  const handleSelectFileClick = () => {
    setModalMode(null);
    setDrawerOpen(false);
    triggerMobileStoragePicker();
  };

  const openFilePickerScreen = () => {
    handleSelectFileClick();
  };


  const [settingsDialog, setSettingsDialog] = useState<{
    title: string;
    options: string[];
    value: string;
    onSelect: (val: string) => void;
  } | null>(null);

  // Active playing channel
  const [playingChannel, setPlayingChannel] = useState<Channel | null>(null);

  // Persist playlists safely and ensure duplicates are always cleaned
  useEffect(() => {
    try {
      const clean = deduplicatePlaylists(playlists);
      if (clean.length !== playlists.length) {
        setPlaylists(clean);
        return;
      }
      localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(clean));
    } catch {
      // ignore storage quota errors
    }
  }, [playlists]);

  useEffect(() => {
    try {
      if (activePlaylistId) {
        localStorage.setItem(STORAGE_KEY_ACTIVE_PLAYLIST, activePlaylistId);
      } else {
        localStorage.removeItem(STORAGE_KEY_ACTIVE_PLAYLIST);
      }
    } catch {
      // ignore
    }
  }, [activePlaylistId]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(favorites));
    } catch {
      // ignore
    }
  }, [favorites]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3200);
  };

  const displayedPlaylists = useMemo(() => {
    return deduplicatePlaylists(playlists);
  }, [playlists]);

  const activePlaylist = useMemo(() => {
    if (!displayedPlaylists.length) return null;
    return displayedPlaylists.find((p) => p.id === activePlaylistId) || displayedPlaylists[0];
  }, [displayedPlaylists, activePlaylistId]);

  const categoryCounts = useMemo(() => {
    const map = new Map<string, number>();
    if (!activePlaylist) return [];
    activePlaylist.channels.forEach((ch) => {
      const grp = ch.group || 'General';
      map.set(grp, (map.get(grp) || 0) + 1);
    });
    return Array.from(map.entries()).map(([name, count]) => ({ name, count }));
  }, [activePlaylist]);

  const isXtreamPlaylist = useMemo(() => {
    if (!activePlaylist) return false;
    return (
      activePlaylist.id.startsWith('pl-xtream-') ||
      Boolean(activePlaylist.sourceUrl?.includes('/get.php')) ||
      activePlaylist.channels.some(
        (c) =>
          c.xtreamParams?.streamType === 'live' ||
          c.xtreamParams?.streamType === 'series' ||
          c.xtreamParams?.streamType === 'movie'
      )
    );
  }, [activePlaylist]);

  const filteredChannels = useMemo(() => {
    if (!activePlaylist) return [];
    let list = activePlaylist.channels;

    if (channelsTab === 'FAVORITES') {
      list = list.filter((ch) => favorites.includes(ch.id));
    } else if (channelsTab === 'LIVE') {
      list = list.filter(
        (ch) =>
          ch.xtreamParams?.streamType === 'live' ||
          (!ch.xtreamParams &&
            !isDirectVodChannel(ch) &&
            !/\b(?:movie|vod|series|cinema|films?)\b/i.test(ch.group || '') &&
            !/\/(?:movie|series|vod)\//i.test(ch.url))
      );
    } else if (channelsTab === 'SERIES') {
      list = list.filter(
        (ch) =>
          ch.xtreamParams?.streamType === 'series' ||
          /\bseries\b/i.test(ch.group || '') ||
          /\/series\//i.test(ch.url)
      );
    } else if (channelsTab === 'VOD') {
      list = list.filter(
        (ch) =>
          ch.xtreamParams?.streamType === 'movie' ||
          isDirectVodChannel(ch) ||
          /\b(?:vod|movie|films?|cinema)\b/i.test(ch.group || '') ||
          /\/movie\//i.test(ch.url)
      );
    } else if (channelsTab === 'CATEGORIES') {
      const targetCat = selectedCategory || categoryCounts[0]?.name;
      if (targetCat) {
        list = list.filter((ch) => (ch.group || 'General') === targetCat);
      }
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (ch) =>
          ch.name.toLowerCase().includes(q) ||
          ch.group.toLowerCase().includes(q) ||
          String(ch.number).includes(q)
      );
    }

    if (channelsSortMode === 'By channel name') {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    } else if (channelsSortMode === 'By channel number') {
      list = [...list].sort((a, b) => a.number - b.number);
    }

    return list;
  }, [activePlaylist, channelsTab, selectedCategory, searchQuery, favorites, channelsSortMode]);

  const toggleFavorite = (channelId: string) => {
    setFavorites((prev) =>
      prev.includes(channelId) ? prev.filter((id) => id !== channelId) : [...prev, channelId]
    );
  };

  const handleSelectChannel = (ch: Channel) => {
    if (isYouTubeChannelUrl(ch.url)) {
      openExternalChannelLink(ch.url);
      return;
    }

    // Automatically open in true fullscreen on mobile to hide browser header and navigation buttons
    try {
      if (
        typeof document !== 'undefined' &&
        !document.fullscreenElement &&
        !(document as any).webkitFullscreenElement
      ) {
        const el = document.documentElement;
        if (el.requestFullscreen) {
          el.requestFullscreen({ navigationUI: 'hide' } as any).catch(() => {});
        } else if ((el as any).webkitRequestFullscreen) {
          (el as any).webkitRequestFullscreen();
        }
      }
    } catch {
      // ignore
    }

    // Record last played channel for TV focus restoration
    lastPlayedChannelIdRef.current = ch.id;

    // Only route direct VOD URLs through backend proxy server if a verified backend is actually available.
    // On static deployments (e.g. GitHub Pages), do NOT rewrite the channel URL to /api/proxy (which 404s);
    // pass the clean original URL to the player, which uses browser-native playback and safe HTTPS/CORS bridges.
    if (canUseBackendProxy() && isDirectVodChannel(ch)) {
      const activeUa = vpHttpUserAgent.trim() || DEFAULT_PLAYER_USER_AGENT;
      const proxyUrl = buildChannelProxyUrl(ch, activeUa);
      const proxiedChannel: Channel = {
        ...ch,
        originalUrl: ch.originalUrl || ch.url,
        url: proxyUrl,
        forceProxy: true,
        isProxied: true,
      };
      if (castSession.isConnected) {
        castManager.castMedia({
          title: proxiedChannel.name || 'Live Channel',
          subtitle: proxiedChannel.group || 'Live Stream',
          streamUrl: proxiedChannel.url,
          logoUrl: proxiedChannel.logo,
          isLive: true,
        });
        showToast(`Casting ${proxiedChannel.name} to ${castSession.connectedDevice?.name || 'TV'}`);
      }
      setPlayingChannel(proxiedChannel);
      return;
    }

    let channelToPlay = ch;
    if (!canUseBackendProxy() && ch.url.includes('/api/proxy?url=')) {
      try {
        const match = ch.url.match(/[?&]url=([^&]+)/);
        if (match && match[1]) {
          channelToPlay = {
            ...ch,
            url: decodeURIComponent(match[1]),
          };
        }
      } catch {
        // keep ch
      }
    }

    if (castSession.isConnected) {
      castManager.castMedia({
        title: channelToPlay.name || 'Live Channel',
        subtitle: channelToPlay.group || 'Live Stream',
        streamUrl: channelToPlay.url,
        logoUrl: channelToPlay.logo,
        isLive: true,
      });
      showToast(`Casting ${channelToPlay.name} to ${castSession.connectedDevice?.name || 'TV'}`);
    }

    setPlayingChannel(channelToPlay);
  };

  const lastPlayedChannelIdRef = useRef<string | null>(null);

  // Restore TV focus to the active channel when exiting video player
  useEffect(() => {
    if (!playingChannel && lastPlayedChannelIdRef.current) {
      const channelId = lastPlayedChannelIdRef.current;
      const timer = window.setTimeout(() => {
        const el = document.querySelector<HTMLElement>(`[data-channel-id="${channelId}"]`);
        if (el) {
          focusTvElement(el, true);
        }
      }, 50);
      return () => window.clearTimeout(timer);
    }
  }, [playingChannel]);

  // Auto-focus first meaningful interactive element on Android TV when screens or modals change
  useEffect(() => {
    if (playingChannel) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) {
        const target = findFirstTvElement(document);
        if (target) {
          focusTvElement(target, true);
        }
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [
    screen,
    channelsTab,
    modalMode,
    drawerOpen,
    playingChannel,
    displayedPlaylists.length,
    selectedCategory,
  ]);

  // Global Android TV D-Pad & Remote Navigation Handler
  useEffect(() => {
    const handleTvKeyDown = (e: KeyboardEvent) => {
      // When video player is open, let player modal handle all remote keys
      if (playingChannel) return;

      const activeEl = document.activeElement as HTMLElement | null;
      const isInput = isTypingInInput(e);

      const {
        isUp,
        isDown,
        isLeft,
        isRight,
        isSelect,
        isBack,
        isMenu,
      } = parseRemoteKeyEvent(e);

      // 1. Android TV Remote Menu button (Hamburger / Side menu toggle)
      if (isMenu) {
        e.preventDefault();
        e.stopPropagation();
        setDrawerOpen((prev) => !prev);
        return;
      }

      // 2. Android TV Remote Back / Return button
      if (isBack) {
        if (isInput) {
          e.preventDefault();
          e.stopPropagation();
          activeEl?.blur();
          return;
        }
        if (modalMode) {
          e.preventDefault();
          e.stopPropagation();
          setModalMode(null);
          return;
        }
        if (openPlaylistMenuId) {
          e.preventDefault();
          e.stopPropagation();
          setOpenPlaylistMenuId(null);
          return;
        }
        if (drawerOpen) {
          e.preventDefault();
          e.stopPropagation();
          setDrawerOpen(false);
          return;
        }
        if (showSearchBar && searchQuery) {
          e.preventDefault();
          e.stopPropagation();
          setSearchQuery('');
          return;
        }
        if (showSearchBar) {
          e.preventDefault();
          e.stopPropagation();
          setShowSearchBar(false);
          return;
        }
        if (screen !== 'channels' && screen !== 'playlists') {
          e.preventDefault();
          e.stopPropagation();
          setScreen(playlists.length > 0 ? 'channels' : 'playlists');
          return;
        }
        if (screen === 'channels' && playlists.length > 1) {
          e.preventDefault();
          e.stopPropagation();
          setScreen('playlists');
          return;
        }
      }

      // If user is currently typing in an input field, only permit Up/Down/Enter to leave/submit
      if (isInput) {
        if (isUp || isDown) {
          // Allow D-Pad Up/Down to navigate out of input fields
          const inputsAndBtns = Array.from(
            document.querySelectorAll<HTMLElement>(
              'input:not([disabled]), button:not([disabled]), [tabindex="0"]:not([disabled])'
            )
          );
          const idx = inputsAndBtns.indexOf(activeEl!);
          if (idx !== -1) {
            e.preventDefault();
            if (isDown && idx < inputsAndBtns.length - 1) {
              focusTvElement(inputsAndBtns[idx + 1], true);
            } else if (isUp && idx > 0) {
              focusTvElement(inputsAndBtns[idx - 1], true);
            }
          }
        }
        return;
      }

      // 3. If nothing is focused yet, or focus is on body, lock focus immediately onto screen
      if (
        (isUp || isDown || isLeft || isRight || isSelect) &&
        (!activeEl || activeEl === document.body)
      ) {
        e.preventDefault();
        e.stopPropagation();
        const target = findFirstTvElement(document);
        if (target) {
          focusTvElement(target, true);
        }
        return;
      }

      // 4. Android TV Remote Select / OK / Center Key (KEYCODE_DPAD_CENTER 23 or KEYCODE_ENTER 66)
      if (isSelect) {
        if (activeEl && activeEl !== document.body) {
          e.preventDefault();
          e.stopPropagation();
          activeEl.click();
          return;
        }
      }

      // 5. Android TV D-Pad Directional Navigation (Up, Down, Left, Right)
      if (isUp || isDown || isLeft || isRight) {
        if (!activeEl) return;

        // A. If Navigation Drawer is Open:
        if (drawerOpen) {
          const drawerItems = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-tv="drawer-item"], nav button, nav [role="button"], nav .cursor-pointer'
            )
          ).filter((el) => (el as any).offsetParent !== null);

          const idx = drawerItems.indexOf(activeEl);
          if (idx !== -1) {
            if (isDown) {
              e.preventDefault();
              const nextIdx = idx < drawerItems.length - 1 ? idx + 1 : 0;
              focusTvElement(drawerItems[nextIdx], true);
              return;
            }
            if (isUp) {
              e.preventDefault();
              const prevIdx = idx > 0 ? idx - 1 : drawerItems.length - 1;
              focusTvElement(drawerItems[prevIdx], true);
              return;
            }
            if (isRight) {
              e.preventDefault();
              setDrawerOpen(false);
              const mainTarget = findFirstTvElement(document);
              if (mainTarget) focusTvElement(mainTarget, true);
              return;
            }
          }
          return;
        }

        // B. If Modal or Popup Menu is Open:
        if (modalMode || openPlaylistMenuId) {
          const menuItems = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-tv="menu-item"], .fixed.inset-0.z-50 button, .fixed.inset-0.z-50 [role="button"]'
            )
          ).filter((el) => (el as any).offsetParent !== null);

          const idx = menuItems.indexOf(activeEl);
          if (idx !== -1) {
            if (isDown) {
              e.preventDefault();
              const nextIdx = idx < menuItems.length - 1 ? idx + 1 : 0;
              focusTvElement(menuItems[nextIdx], true);
              return;
            }
            if (isUp) {
              e.preventDefault();
              const prevIdx = idx > 0 ? idx - 1 : menuItems.length - 1;
              focusTvElement(menuItems[prevIdx], true);
              return;
            }
          }
          return;
        }

        const activeTv = activeEl.getAttribute('data-tv');

        // C. From Tabs or Header to Content:
        if (isDown && (activeTv === 'tab' || activeTv === 'header-btn')) {
          e.preventDefault();
          if (screen === 'channels') {
            if (channelsTab === 'CATEGORIES') {
              const catEl =
                document.querySelector<HTMLElement>('[data-tv="category"][data-active="true"]') ||
                document.querySelector<HTMLElement>('[data-tv="category"]');
              if (catEl) {
                focusTvElement(catEl, true);
                return;
              }
            }
            const firstCh = document.querySelector<HTMLElement>('[data-tv="channel"]');
            if (firstCh) {
              focusTvElement(firstCh, true);
              return;
            }
          } else if (screen === 'playlists') {
            const firstPl =
              document.querySelector<HTMLElement>('[data-tv="playlist"]') ||
              document.querySelector<HTMLElement>('[data-tv="add-playlist-btn"]');
            if (firstPl) {
              focusTvElement(firstPl, true);
              return;
            }
          }
        }

        // D. Category sidebar navigation:
        if (activeTv === 'category') {
          const allCats = Array.from(
            document.querySelectorAll<HTMLElement>('[data-tv="category"]')
          );
          const idx = allCats.indexOf(activeEl);

          if (isDown && idx !== -1) {
            e.preventDefault();
            if (idx < allCats.length - 1) {
              focusTvElement(allCats[idx + 1], true);
            }
            return;
          }

          if (isUp && idx !== -1) {
            e.preventDefault();
            if (idx > 0) {
              focusTvElement(allCats[idx - 1], true);
            } else {
              const catTab =
                document.querySelector<HTMLElement>('[data-tv-tab="CATEGORIES"]') ||
                document.querySelector<HTMLElement>('[data-tv="tab"]');
              if (catTab) {
                focusTvElement(catTab, true);
              }
            }
            return;
          }

          if (isRight) {
            e.preventDefault();
            const firstCh =
              categoryContentRef.current?.querySelector<HTMLElement>('[data-tv="channel"]') ||
              document.querySelector<HTMLElement>('[data-tv="channel"]');
            if (firstCh) {
              focusTvElement(firstCh, true);
            }
            return;
          }

          if (isLeft) {
            e.preventDefault();
            const drawerBtn = document.querySelector<HTMLElement>('[data-tv="header-btn"]');
            if (drawerBtn) {
              focusTvElement(drawerBtn, true);
            }
            return;
          }
        }

        // E. Channel Grid / List Navigation (Ultra-Fast O(1) Indexed, Zero-Lag):
        if (activeTv === 'channel') {
          const allChs = Array.from(
            document.querySelectorAll<HTMLElement>('[data-tv="channel"]')
          );
          const idx = allChs.indexOf(activeEl);

          if (idx !== -1) {
            if (viewLayout === 'grid') {
              // Calculate dynamic column count without expensive reflow
              let cols = 1;
              const firstTop = allChs[0]?.offsetTop ?? 0;
              for (let i = 1; i < Math.min(allChs.length, 12); i++) {
                if (allChs[i].offsetTop > firstTop + 8) {
                  cols = i;
                  break;
                }
              }
              if (cols <= 0) cols = 4;

              if (isRight) {
                e.preventDefault();
                if (idx < allChs.length - 1) {
                  focusTvElement(allChs[idx + 1], true);
                }
                return;
              }

              if (isLeft) {
                e.preventDefault();
                if (idx % cols > 0 && idx > 0) {
                  focusTvElement(allChs[idx - 1], true);
                } else if (channelsTab === 'CATEGORIES') {
                  const catEl =
                    document.querySelector<HTMLElement>('[data-tv="category"][data-active="true"]') ||
                    document.querySelector<HTMLElement>('[data-tv="category"]');
                  if (catEl) {
                    focusTvElement(catEl, true);
                  }
                }
                return;
              }

              if (isDown) {
                e.preventDefault();
                const nextIdx = idx + cols;
                if (nextIdx < allChs.length) {
                  focusTvElement(allChs[nextIdx], true);
                } else if (idx < allChs.length - 1) {
                  focusTvElement(allChs[allChs.length - 1], true);
                }
                return;
              }

              if (isUp) {
                e.preventDefault();
                const prevIdx = idx - cols;
                if (prevIdx >= 0) {
                  focusTvElement(allChs[prevIdx], true);
                } else {
                  const activeTab =
                    document.querySelector<HTMLElement>(`[data-tv-tab="${channelsTab}"]`) ||
                    document.querySelector<HTMLElement>('[data-tv="tab"]');
                  if (activeTab) {
                    focusTvElement(activeTab, true);
                  }
                }
                return;
              }
            } else {
              // List layout
              if (isDown) {
                e.preventDefault();
                if (idx < allChs.length - 1) {
                  focusTvElement(allChs[idx + 1], true);
                }
                return;
              }

              if (isUp) {
                e.preventDefault();
                if (idx > 0) {
                  focusTvElement(allChs[idx - 1], true);
                } else {
                  const activeTab =
                    document.querySelector<HTMLElement>(`[data-tv-tab="${channelsTab}"]`) ||
                    document.querySelector<HTMLElement>('[data-tv="tab"]');
                  if (activeTab) {
                    focusTvElement(activeTab, true);
                  }
                }
                return;
              }

              if (isLeft && channelsTab === 'CATEGORIES') {
                e.preventDefault();
                const catEl =
                  document.querySelector<HTMLElement>('[data-tv="category"][data-active="true"]') ||
                  document.querySelector<HTMLElement>('[data-tv="category"]');
                if (catEl) {
                  focusTvElement(catEl, true);
                }
                return;
              }
            }
          }
        }

        // F. Header Tabs Navigation:
        if (activeTv === 'tab') {
          const allTabs = Array.from(
            document.querySelectorAll<HTMLElement>('[data-tv="tab"]')
          );
          const idx = allTabs.indexOf(activeEl);
          if (idx !== -1) {
            if (isRight) {
              e.preventDefault();
              if (idx < allTabs.length - 1) {
                focusTvElement(allTabs[idx + 1], true);
              } else {
                const searchBtn =
                  document.querySelector<HTMLElement>('[data-tv="header-btn"]:not([disabled])');
                if (searchBtn) focusTvElement(searchBtn, true);
              }
              return;
            }
            if (isLeft) {
              e.preventDefault();
              if (idx > 0) {
                focusTvElement(allTabs[idx - 1], true);
              } else {
                const drawerBtn = document.querySelector<HTMLElement>('[data-tv="header-btn"]');
                if (drawerBtn) focusTvElement(drawerBtn, true);
              }
              return;
            }
            if (isDown) {
              e.preventDefault();
              if (channelsTab === 'CATEGORIES') {
                const catEl =
                  document.querySelector<HTMLElement>('[data-tv="category"][data-active="true"]') ||
                  document.querySelector<HTMLElement>('[data-tv="category"]');
                if (catEl) {
                  focusTvElement(catEl, true);
                  return;
                }
              }
              const firstCh = document.querySelector<HTMLElement>('[data-tv="channel"]');
              if (firstCh) {
                focusTvElement(firstCh, true);
                return;
              }
            }
            if (isUp) {
              e.preventDefault();
              const topBtn = document.querySelector<HTMLElement>('[data-tv="header-btn"]');
              if (topBtn) focusTvElement(topBtn, true);
              return;
            }
          }
        }

        // G. Playlist Items Navigation:
        if (activeTv === 'playlist') {
          const allPls = Array.from(
            document.querySelectorAll<HTMLElement>('[data-tv="playlist"]')
          );
          const idx = allPls.indexOf(activeEl);
          if (idx !== -1) {
            if (isDown) {
              e.preventDefault();
              if (idx < allPls.length - 1) {
                focusTvElement(allPls[idx + 1], true);
              } else {
                const addBtn = document.querySelector<HTMLElement>('[data-tv="add-playlist-btn"]');
                if (addBtn) focusTvElement(addBtn, true);
              }
              return;
            }
            if (isUp) {
              e.preventDefault();
              if (idx > 0) {
                focusTvElement(allPls[idx - 1], true);
              } else {
                const topBtn = document.querySelector<HTMLElement>('[data-tv="header-btn"]');
                if (topBtn) focusTvElement(topBtn, true);
              }
              return;
            }
          }
        }

        // H. Header Button Navigation:
        if (activeTv === 'header-btn') {
          const allHeaderBtns = Array.from(
            document.querySelectorAll<HTMLElement>('[data-tv="header-btn"]')
          );
          const idx = allHeaderBtns.indexOf(activeEl);
          if (idx !== -1) {
            if (isRight && idx < allHeaderBtns.length - 1) {
              e.preventDefault();
              focusTvElement(allHeaderBtns[idx + 1], true);
              return;
            }
            if (isLeft && idx > 0) {
              e.preventDefault();
              focusTvElement(allHeaderBtns[idx - 1], true);
              return;
            }
          }
          if (isDown) {
            e.preventDefault();
            if (screen === 'channels') {
              const activeTab =
                document.querySelector<HTMLElement>(`[data-tv-tab="${channelsTab}"]`) ||
                document.querySelector<HTMLElement>('[data-tv="tab"]');
              if (activeTab) {
                focusTvElement(activeTab, true);
                return;
              }
            }
            const firstItem =
              document.querySelector<HTMLElement>('[data-tv="channel"]') ||
              document.querySelector<HTMLElement>('[data-tv="playlist"]') ||
              document.querySelector<HTMLElement>('[data-tv="add-playlist-btn"]');
            if (firstItem) {
              focusTvElement(firstItem, true);
              return;
            }
          }
        }

        // I. 2D Spatial Navigation fallback for any other custom element
        const dir = isUp ? 'up' : isDown ? 'down' : isLeft ? 'left' : 'right';
        const next = findNextSpatialElement(activeEl, dir);
        if (next) {
          e.preventDefault();
          focusTvElement(next, true);
        }
      }
    };

    window.addEventListener('keydown', handleTvKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleTvKeyDown, { capture: true });
    };
  }, [
    playingChannel,
    screen,
    channelsTab,
    modalMode,
    drawerOpen,
    showSearchBar,
    searchQuery,
    playlists.length,
    viewLayout,
    openPlaylistMenuId,
    displayedPlaylists.length,
  ]);

  // Submit Add URL Page (Exact Match to 2.mp4 Video Process)
  const handleAddUrlPlaylist = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmedUrl = urlInput.trim();
    if (!trimmedUrl) {
      showToast('Please input a network URL for your playlist');
      urlInputRef.current?.focus();
      return;
    }

    // In 2.mp4 frame 00:01, when Playlist name is empty, it derives the filename e.g. 'index.m3u'
    const rawUrlFileName =
      decodeURIComponent(trimmedUrl.split('/').pop()?.split('?')[0] || '') ||
      '';
    const derivedName =
      nameInput.trim() ||
      rawUrlFileName ||
      `Playlist ${playlists.length + 1}`;

    const normalizedNew = normalizeSourceUrl(trimmedUrl);
    // Deduplication check: check if a playlist with this URL or name already exists
    const existingPlaylist = playlists.find((p) =>
      arePlaylistsMatching(p, {
        sourceUrl: trimmedUrl,
        name: nameInput.trim() || derivedName,
      })
    );

    const targetId = existingPlaylist ? existingPlaylist.id : `pl-${Date.now()}`;
    const targetName = nameInput.trim() || existingPlaylist?.name || derivedName;

    const tempPlaylist: Playlist = {
      ...(existingPlaylist || {}),
      id: targetId,
      name: targetName,
      sourceUrl: trimmedUrl,
      sourceType: 'url',
      catchupType: catchupType || existingPlaylist?.catchupType,
      catchupDays: catchupDays.trim() || existingPlaylist?.catchupDays || undefined,
      channels: existingPlaylist?.channels || [],
      addedAt: existingPlaylist?.addedAt || Date.now(),
    };

    // Immediately transition to channels screen without duplicating
    setPlaylists((prev) => upsertPlaylistWithoutDuplicates(prev, tempPlaylist));
    setActivePlaylistId(targetId);
    setChannelsTab('ALL_CHANNELS');
    setSelectedCategory(null);
    setScreen('channels');
    setIsLoadingPlaylist(true);
    setLoadError(null);

    try {
      await ensureBackendProbed();
      const apiBase = getEffectiveApiBaseUrl();
      const extractedUrlInfo = extractUrlAndPipeHeaders(trimmedUrl);
      const inputMac =
        extractedUrlInfo.macAddress ||
        normalizeMacAddress(nameInput) ||
        normalizeMacAddress(trimmedUrl);
      if (inputMac && !extractedUrlInfo.macAddress) {
        extractedUrlInfo.macAddress = inputMac;
      }

      const isDirectVodFileUrl =
        /\.(mp4|mkv|webm|avi|mov|m4v|flv|ts|ogg)(\?|$|#|&|\|)/i.test(trimmedUrl) ||
        /drive\.google\.com\/(?:file\/d\/|open\?|uc\?)|drive\.usercontent\.google\.com/i.test(
          trimmedUrl
        ) ||
        /pixeldrain\.com\/(?:u|api\/file)\//i.test(trimmedUrl) ||
        /archive\.org\/(?:details|download)\//i.test(trimmedUrl) ||
        /dropbox\.com|dropboxusercontent\.com/i.test(trimmedUrl) ||
        /\/(movie|series|vod)\//i.test(trimmedUrl) ||
        Boolean(extractedUrlInfo.xtreamParams) ||
        /\/play\/live\.php\b/i.test(trimmedUrl);

      const isStalkerMacPortalUrl =
        Boolean(inputMac) &&
        !/\.(m3u|m3u8|xspf|xml|json)(\?|$|#|&|\|)/i.test(trimmedUrl);

      let parsedChannels: Channel[] = [];

      if (isStalkerMacPortalUrl && inputMac && canUseBackendProxy()) {
        try {
          const res = await fetch(
            `${apiBase}/api/xtream?server=${encodeURIComponent(
              extractedUrlInfo.url
            )}&mac=${encodeURIComponent(inputMac)}`
          );
          if (res.ok) {
            const text = await res.text();
            parsedChannels = parsePlaylistContent(text, extractedUrlInfo.url);
          }
        } catch {
          // fallback to direct or M3U fetch
        }
      }

      if (parsedChannels.length === 0 && isDirectVodFileUrl) {
        const rawFileName =
          decodeURIComponent(extractedUrlInfo.url.split('/').pop()?.split('?')[0] || '') ||
          'Stream';
        const isLive =
          extractedUrlInfo.xtreamParams?.streamType === 'live' ||
          Boolean(inputMac) ||
          /\/play\/live\.php\b/i.test(extractedUrlInfo.url) ||
          /\.(ts|m3u8)(\?|$|#|&)/i.test(extractedUrlInfo.url) ||
          /[?&](?:extension|output)=ts\b/i.test(extractedUrlInfo.url);
        parsedChannels = [
          {
            id: `ch-${Date.now()}`,
            name: nameInput.trim() || rawFileName,
            url: extractedUrlInfo.url,
            group: isLive ? 'Live TV' : 'VOD Movies',
            userAgent: extractedUrlInfo.userAgent,
            referer: extractedUrlInfo.referer,
            cookie: buildMacCookieHeader(inputMac, extractedUrlInfo.cookie),
            macAddress: inputMac,
            authToken: extractedUrlInfo.authToken,
            xtreamParams: extractedUrlInfo.xtreamParams,
            number: 1,
          },
        ];
      } else if (parsedChannels.length === 0) {
        let proxyQuerySuffix = `url=${encodeURIComponent(extractedUrlInfo.url)}`;
        if (extractedUrlInfo.userAgent) {
          proxyQuerySuffix += `&ua=${encodeURIComponent(extractedUrlInfo.userAgent)}`;
        }
        if (extractedUrlInfo.referer) {
          proxyQuerySuffix += `&ref=${encodeURIComponent(extractedUrlInfo.referer)}`;
        }
        if (inputMac) {
          proxyQuerySuffix += `&mac=${encodeURIComponent(inputMac)}`;
        }
        if (extractedUrlInfo.cookie) {
          proxyQuerySuffix += `&cookie=${encodeURIComponent(extractedUrlInfo.cookie)}`;
        }
        if (extractedUrlInfo.authToken) {
          proxyQuerySuffix += `&auth=${encodeURIComponent(extractedUrlInfo.authToken)}`;
        }

        proxyQuerySuffix += '&playlist=1';

        const response = await fetchWithUniversalFallback(
          extractedUrlInfo.url,
          proxyQuerySuffix
        );

        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        const content = await response.text();
        const trimmedContent = content.trim();

        if (
          trimmedContent.includes('#EXTINF:') ||
          trimmedContent.includes('#EXTM3U') ||
          trimmedContent.includes('<playlist') ||
          trimmedContent.includes('<track') ||
          trimmedContent.startsWith('[') ||
          trimmedContent.startsWith('{')
        ) {
          parsedChannels = parsePlaylistContent(content, extractedUrlInfo.url);
        } else if (contentType.startsWith('video/') && !content.includes('#EXT')) {
          parsedChannels = [
            {
              id: `vod-${Date.now()}`,
              name: nameInput.trim() || extractedUrlInfo.url.split('/').pop() || 'VOD Stream',
              url: extractedUrlInfo.url,
              group: Boolean(inputMac) ? 'Live TV' : 'VOD Movies',
              userAgent: extractedUrlInfo.userAgent,
              referer: extractedUrlInfo.referer,
              cookie: buildMacCookieHeader(inputMac, extractedUrlInfo.cookie),
              macAddress: inputMac,
              authToken: extractedUrlInfo.authToken,
              xtreamParams: extractedUrlInfo.xtreamParams,
              number: 1,
            },
          ];
        } else {
          parsedChannels = parsePlaylistContent(content, extractedUrlInfo.url);
        }
      }

      if (inputMac && parsedChannels.length > 0) {
        parsedChannels = parsedChannels.map((c) => ({
          ...c,
          macAddress: c.macAddress || inputMac,
          cookie: buildMacCookieHeader(c.macAddress || inputMac, c.cookie),
        }));
      }

      if (parsedChannels.length === 0) {
        setLoadError('No valid TV channels found in this M3U / XSPF playlist.');
        showToast('No valid TV channels found in this URL');
        setIsLoadingPlaylist(false);
        return;
      }

      const finalizedPlaylist: Playlist = {
        ...tempPlaylist,
        channels: parsedChannels,
        name: targetName,
      };

      setPlaylists((prev) => upsertPlaylistWithoutDuplicates(prev, finalizedPlaylist));
      // Matching 2.mp4 frame 00:33
      showToast(existingPlaylist ? 'Playlist updated' : 'Synchronizing EPG');
    } catch {
      setLoadError(
        'Failed to fetch playlist from URL. Check the URL or try another M3U/XSPF link.'
      );
      showToast('Failed to load playlist from URL');
    } finally {
      setIsLoadingPlaylist(false);
    }
  };

  // Add Playlist via Xtream Codes Login (Exact Match to 1.mp4 Video Process)
  const handleXtreamLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    let cleanServer = xtreamServer.trim().replace(/\/+$/, '');
    if (cleanServer && !/^https?:\/\//i.test(cleanServer)) {
      cleanServer = `http://${cleanServer}`;
    }
    const cleanUser = xtreamUsername.trim();
    const cleanPass = xtreamPassword.trim();
    const userMac = normalizeMacAddress(cleanUser) || normalizeMacAddress(cleanServer);

    if (!cleanServer || (!userMac && (!cleanUser || !cleanPass))) {
      showToast('Please input Xtream Codes credentials or Stalker MAC address');
      return;
    }

    // In 1.mp4 frame 00:04, when Playlist name is empty, it uses 'get.php'
    const derivedName = xtreamName.trim() || 'get.php';
    const normalizedServer = normalizeSourceUrl(cleanServer);

    // Deduplication check: check if an existing Xtream playlist exists with same server & user or same name
    const existingPlaylist = playlists.find((p) => {
      if (
        arePlaylistsMatching(p, {
          sourceUrl: cleanServer,
          name: xtreamName.trim() || derivedName,
        })
      ) {
        return true;
      }
      const matchUrl = areSourceUrlsEquivalent(p.sourceUrl, cleanServer);
      const matchName =
        (xtreamName.trim() && p.name.trim().toLowerCase() === xtreamName.trim().toLowerCase()) ||
        (!xtreamName.trim() && p.name.trim().toLowerCase() === 'get.php');
      const matchXtreamUser = p.channels.some(
        (c) =>
          c.xtreamParams &&
          c.xtreamParams.username.toLowerCase() === cleanUser.toLowerCase()
      );
      return (
        (matchUrl && matchXtreamUser) ||
        (matchUrl && (p.id.startsWith('pl-xtream-') || !p.sourceUrl?.includes('.m3u'))) ||
        matchName
      );
    });

    const targetId = existingPlaylist ? existingPlaylist.id : `pl-xtream-${Date.now()}`;
    const targetName = xtreamName.trim() || existingPlaylist?.name || derivedName;

    const tempPlaylist: Playlist = {
      ...(existingPlaylist || {}),
      id: targetId,
      name: targetName,
      sourceUrl: cleanServer,
      sourceType: 'url',
      channels: existingPlaylist?.channels || [],
      addedAt: existingPlaylist?.addedAt || Date.now(),
    };

    // Immediately transition to channels screen with loading spinner without duplicating
    setPlaylists((prev) => upsertPlaylistWithoutDuplicates(prev, tempPlaylist));
    setActivePlaylistId(targetId);
    setChannelsTab('HOME');
    setSelectedCategory(null);
    setScreen('channels');
    setIsLoadingPlaylist(true);
    setLoadError(null);

    const outputParam = xtreamStreamFormat === 'TS' ? 'ts' : 'm3u8';
    const xtreamM3uUrl = `${cleanServer}/get.php?username=${encodeURIComponent(
      cleanUser
    )}&password=${encodeURIComponent(cleanPass)}&type=m3u_plus&output=${outputParam}`;

    try {
      await ensureBackendProbed();
      const apiBase = getEffectiveApiBaseUrl();
      let xtreamApiResolverUrl = `${apiBase}/api/xtream?server=${encodeURIComponent(
        cleanServer
      )}&username=${encodeURIComponent(cleanUser)}&password=${encodeURIComponent(
        cleanPass
      )}&output=${outputParam}&live=${importLiveChannels ? '1' : '0'}&vod=${
        importVods ? '1' : '0'
      }&series=${importSeries ? '1' : '0'}`;
      if (userMac) {
        xtreamApiResolverUrl += `&mac=${encodeURIComponent(userMac)}`;
      }

      let parsedChannels: Channel[] = [];

      if (canUseBackendProxy()) {
        try {
          const r = await fetch(xtreamApiResolverUrl);
          if (r.ok) {
            const content = await r.text();
            parsedChannels = parsePlaylistContent(content, cleanServer);
          }
        } catch {
          // fall back to universal M3U fetch
        }
      }

      if (parsedChannels.length === 0) {
        try {
          const r = await fetchWithUniversalFallback(
            xtreamM3uUrl,
            `url=${encodeURIComponent(xtreamM3uUrl)}&playlist=1`
          );
          if (r.ok) {
            const content = await r.text();
            parsedChannels = parsePlaylistContent(content, cleanServer);
          }
        } catch {
          // fall back to alt m3u
        }
      }

      if (parsedChannels.length === 0) {
        const altM3uUrl = `${cleanServer}/get.php?username=${encodeURIComponent(
          cleanUser
        )}&password=${encodeURIComponent(cleanPass)}&output=${outputParam}`;
        try {
          const altRes = await fetchWithUniversalFallback(
            altM3uUrl,
            `url=${encodeURIComponent(altM3uUrl)}&playlist=1`
          );
          if (altRes.ok) {
            const altContent = await altRes.text();
            parsedChannels = parsePlaylistContent(altContent, cleanServer);
          }
        } catch {
          // ignore
        }
      }

      if (parsedChannels.length === 0) {
        setLoadError('Invalid Xtream Codes credentials or no channels found on server.');
        showToast('Invalid Xtream Codes credentials');
        setIsLoadingPlaylist(false);
        return;
      }

      if (userMac && parsedChannels.length > 0) {
        parsedChannels = parsedChannels.map((c) => ({
          ...c,
          macAddress: c.macAddress || userMac,
          cookie: buildMacCookieHeader(c.macAddress || userMac, c.cookie),
        }));
      }

      const finalizedPlaylist: Playlist = {
        ...tempPlaylist,
        channels: parsedChannels,
        name: targetName,
      };

      setPlaylists((prev) => upsertPlaylistWithoutDuplicates(prev, finalizedPlaylist));
      // Matching 1.mp4 frame 02:18
      showToast(existingPlaylist ? 'Playlist updated' : 'Synchronizing EPG');
    } catch {
      setLoadError(
        'Could not connect to Xtream Codes server. Verify Server:Port, Login, and Password.'
      );
      showToast('Failed to connect to Xtream server');
    } finally {
      setIsLoadingPlaylist(false);
    }
  };

  // Helper to read text files reliably across Android Chrome, Samsung Internet, and Android WebView content:// URIs
  const readAndroidSafeTextFile = (file: File): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const result = typeof event.target?.result === 'string' ? event.target.result : '';
        if (result && result.trim().length > 0) {
          resolve(result);
          return;
        }
        if (typeof file.text === 'function') {
          file.text().then(resolve).catch(reject);
        } else {
          resolve(result);
        }
      };
      reader.onerror = async () => {
        try {
          if (typeof file.text === 'function') {
            const txt = await file.text();
            resolve(txt);
            return;
          }
          const ab = await new Response(file).arrayBuffer();
          resolve(new TextDecoder('utf-8', { fatal: false }).decode(ab));
        } catch (err) {
          reject(err);
        }
      };
      try {
        reader.readAsText(file, 'UTF-8');
      } catch (err) {
        if (typeof file.text === 'function') {
          file.text().then(resolve).catch(reject);
        } else {
          reject(err);
        }
      }
    });
  };

  // Add Playlist from Local File (.m3u, .m3u8, .xspf, .html, .txt, .json, or local video files on Android)
  // Exact Match to 3.mp4 Video Process Interface
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputEl = e.target;
    const file = inputEl.files?.[0];
    if (!file) return;

    const exactFileName = file.name || 'Playlist';

    // Dismiss any popups or menus immediately
    setModalMode(null);
    setDrawerOpen(false);

    // If user is on EPG sources screen, process as EPG source
    if (screen === 'epg_sources') {
      try {
        const textContent = await readAndroidSafeTextFile(file);
        const trimmed = textContent.replace(/^\uFEFF/, '').trim();
        if (
          trimmed.includes('<tv') ||
          trimmed.includes('<programme') ||
          /\.xml(\.gz)?$/i.test(exactFileName)
        ) {
          showToast(`EPG source loaded: ${exactFileName}`);
          return;
        }
      } catch {
        showToast('Unable to read selected EPG file');
      } finally {
        try {
          inputEl.value = '';
        } catch {}
      }
      return;
    }

    const isBinaryVideoFile =
      /\.(mp4|mkv|webm|avi|mov|m4v|flv)(\?|$)/i.test(exactFileName) ||
      (file.type.startsWith('video/') &&
        !/mpegurl|x-mpegurl/i.test(file.type) &&
        !/\.(m3u|m3u8|txt|html|htm|xspf|xml|json)$/i.test(exactFileName));

    const existingPlaylist = playlists.find(
      (p) =>
        arePlaylistsMatching(p, { name: exactFileName, sourceType: 'file' }) ||
        p.name.trim().toLowerCase() === exactFileName.trim().toLowerCase()
    );
    const targetId = existingPlaylist ? existingPlaylist.id : `pl-${Date.now()}`;

    // ===================================================================
    // EXACT MATCH TO 3.mp4 VIDEO PROCESS:
    // 1. Immediately switch to Channels view
    // 2. Header displays exact file name (e.g. yaaro_playlist.m3u)
    // 3. Row 2 tabs (FAVORITES | ALL CHANNELS | CATEGORIES) hidden while loading
    // 4. Center screen shows circular progress spinner and "Loading..."
    // ===================================================================
    const tempPlaylist: Playlist = {
      ...(existingPlaylist || {}),
      id: targetId,
      name: exactFileName,
      sourceType: 'file',
      channels: existingPlaylist?.channels || [],
      addedAt: existingPlaylist?.addedAt || Date.now(),
    };

    setPlaylists((prev) => upsertPlaylistWithoutDuplicates(prev, tempPlaylist));
    setActivePlaylistId(targetId);
    setSelectedCategory(null);
    setChannelsTab('ALL_CHANNELS');
    setViewLayout('grid');
    setScreen('channels');
    setIsLoadingPlaylist(true);
    setLoadError(null);

    // Natural UI delay matching the loading duration in 3.mp4
    const minLoadingTime = new Promise((resolve) => setTimeout(resolve, 750));

    try {
      if (isBinaryVideoFile && file.size > 256 * 1024) {
        const localBlobUrl = URL.createObjectURL(file);
        const videoChannel: Channel = {
          id: `local-vod-${Date.now()}`,
          name: exactFileName.replace(/\.[^/.]+$/, '') || exactFileName,
          url: localBlobUrl,
          group: 'Local Videos',
          number: 1,
        };
        await minLoadingTime;
        const finalizedPlaylist: Playlist = {
          ...tempPlaylist,
          channels: [videoChannel],
        };
        setPlaylists((prev) => upsertPlaylistWithoutDuplicates(prev, finalizedPlaylist));
        setIsLoadingPlaylist(false);
        showToast(existingPlaylist ? 'Playlist updated' : 'Synchronizing EPG');
        return;
      }

      // Read text file safely across all Android browsers & devices
      const [textContent] = await Promise.all([
        readAndroidSafeTextFile(file),
        minLoadingTime,
      ]);

      const trimmed = textContent.replace(/^\uFEFF/, '').trim();
      if (!trimmed) {
        setLoadError('Selected file is empty');
        showToast('Selected file is empty');
        setIsLoadingPlaylist(false);
        return;
      }

      // 1. Check if this is an exported JSON configuration backup ({ playlists, favorites })
      if (trimmed.startsWith('{')) {
        try {
          const parsedBackup = JSON.parse(trimmed);
          if (Array.isArray(parsedBackup?.playlists) && parsedBackup.playlists.length > 0) {
            setPlaylists(parsedBackup.playlists);
            setActivePlaylistId(parsedBackup.playlists[0].id);
            if (Array.isArray(parsedBackup.favorites)) {
              setFavorites(parsedBackup.favorites);
            }
            setIsLoadingPlaylist(false);
            showToast('Configuration imported successfully');
            return;
          }
        } catch {
          // Not backup JSON, continue to playlist parsing
        }
      }

      // 2. Parse M3U / M3U8 / XSPF / HTML / JSON / TXT channel playlist
      const parsedChannels = parsePlaylistContent(trimmed);

      if (parsedChannels.length === 0) {
        setLoadError('No valid TV channels found in selected file.');
        showToast('No valid TV channels found in selected file');
        setIsLoadingPlaylist(false);
        return;
      }

      const finalizedPlaylist: Playlist = {
        ...tempPlaylist,
        channels: parsedChannels,
      };

      setPlaylists((prev) => upsertPlaylistWithoutDuplicates(prev, finalizedPlaylist));
      setIsLoadingPlaylist(false);
      // Matching 3.mp4: Bottom Material toast "Synchronizing EPG" appears!
      showToast(existingPlaylist ? 'Playlist updated' : 'Synchronizing EPG');
    } catch {
      setLoadError('Unable to read selected file from device storage');
      showToast('Unable to read selected file from device storage');
      setIsLoadingPlaylist(false);
    } finally {
      try {
        inputEl.value = '';
      } catch {}
    }
  };

  const applyLoadedFileContent = (content: string, rawFileName: string) => {
    const trimmed = content.replace(/^\uFEFF/, '').trim();
    if (!trimmed) {
      showToast('Selected file is empty');
      return;
    }
    const parsedChannels = parsePlaylistContent(trimmed);
    if (parsedChannels.length === 0) {
      showToast('No valid TV channels found in selected file');
      return;
    }
    const exactFileName = rawFileName || 'Playlist';
    const existingPlaylist = playlists.find(
      (p) =>
        arePlaylistsMatching(p, { name: exactFileName, sourceType: 'file' }) ||
        p.name.trim().toLowerCase() === exactFileName.trim().toLowerCase()
    );
    const targetId = existingPlaylist ? existingPlaylist.id : `pl-${Date.now()}`;
    const newPlaylist: Playlist = {
      ...(existingPlaylist || {}),
      id: targetId,
      name: exactFileName,
      sourceType: 'file',
      channels: parsedChannels,
      addedAt: existingPlaylist?.addedAt || Date.now(),
    };
    setPlaylists((prev) => upsertPlaylistWithoutDuplicates(prev, newPlaylist));
    setActivePlaylistId(targetId);
    setSelectedCategory(null);
    setChannelsTab('ALL_CHANNELS');
    setViewLayout('grid');
    setModalMode(null);
    setDrawerOpen(false);
    showToast(existingPlaylist ? 'Playlist updated' : 'Synchronizing EPG');
    if (autoOpenChannels) {
      setScreen('channels');
    }
  };

  // Instant Sample Playlist loader
  const handleLoadSamplePlaylist = () => {
    const existingPlaylist = playlists.find(
      (p) =>
        p.sourceType === 'sample' ||
        p.name.trim().toLowerCase() === 'index.html' ||
        p.id.startsWith('pl-sample-')
    );
    const targetId = existingPlaylist ? existingPlaylist.id : `pl-sample-${Date.now()}`;
    const parsedChannels = parsePlaylistContent(SAMPLE_M3U_CONTENT);
    const newPlaylist: Playlist = {
      ...(existingPlaylist || {}),
      id: targetId,
      name: 'index.html',
      sourceType: 'sample',
      channels: parsedChannels,
      addedAt: existingPlaylist?.addedAt || Date.now(),
    };

    setPlaylists((prev) => upsertPlaylistWithoutDuplicates(prev, newPlaylist));
    setActivePlaylistId(targetId);
    setSelectedCategory(null);
    setChannelsTab('ALL_CHANNELS');
    setViewLayout('grid');
    setModalMode(null);

    if (autoOpenChannels) {
      setScreen('channels');
    }
  };

  const handleDeletePlaylist = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = playlists.filter((p) => p.id !== id);
    const clean = deduplicatePlaylists(updated);
    setPlaylists(clean);
    if (activePlaylistId === id) {
      setActivePlaylistId(clean[0]?.id || null);
    }
    showToast('Playlist removed');
  };

  const handleTopLeftIconClick = () => {
    if (screen === 'file_picker') {
      setShowStoragePermissionModal(false);
      setScreen(prevScreenBeforeFilePicker || 'playlists');
      return;
    }
    if (screen === 'channels') {
      // In Channels view, top-left is Hamburger Menu (☰) opening Drawer
      setDrawerOpen(true);
      return;
    }
    if (
      screen === 'video_player_prefs' ||
      screen === 'epg_sources' ||
      screen === 'proxy_settings' ||
      screen === 'parental_control'
    ) {
      setScreen('settings');
      return;
    }
    if (screen === 'settings') {
      setScreen(playlists.length > 0 ? prevScreenBeforeSettings : 'playlists');
      return;
    }
    if (screen === 'add_url' || screen === 'xtream_login') {
      setLoadError(null);
      setScreen('playlists');
      return;
    }
    if (screen === 'playlists') {
      if (playlists.length > 0) {
        setScreen('channels');
      } else {
        setDrawerOpen(true);
      }
    } else {
      setScreen('playlists');
    }
  };

  const getHeaderTitle = () => {
    switch (screen) {
      case 'file_picker':
        return 'File Manager';
      case 'playlists':
        return 'Playlists';
      case 'add_url':
      case 'xtream_login':
        return 'Add URL';
      case 'settings':
        return 'Settings';
      case 'video_player_prefs':
        return 'Video player preferences';
      case 'epg_sources':
        return 'EPG sources';
      case 'proxy_settings':
        return 'Proxy settings';
      case 'parental_control':
        return 'Parental control';
      case 'channels':
      default:
        return activePlaylist?.name || 'IPTV';
    }
  };

  return (
    <div className="h-screen w-full bg-[#303030] text-white flex flex-col font-sans select-none overflow-hidden relative">
      {/* Root File Input for Mobile / Desktop / Android TV */}
      <input
        id="iptv-file-input"
        ref={fileInputRef}
        type="file"
        accept="*/*"
        aria-label="Root file input"
        onChange={handleFileChange}
        style={{
          position: 'fixed',
          top: '-9999px',
          left: '-9999px',
          width: '1px',
          height: '1px',
          opacity: 0,
        }}
        tabIndex={-1}
      />

      {/* =====================================================================
          TOP APP BAR — Exact Material Blue (#215387) from user's screenshots
         ===================================================================== */}
      <header className="shrink-0 z-30 bg-[#215387] shadow-[0_2px_4px_rgba(0,0,0,0.35)]">
        <div className="h-14 px-2 flex items-center justify-between gap-2">
          {/* Left Zone: Custom Logo badge + Hamburger (☰) on Channels screen, Back Arrow (←) on other screens + Title (e.g. get.php) */}
          <div className="flex items-center min-w-0 shrink-0">
            {screen === 'channels' && (
              <div
                className="w-5 h-5 sm:w-6 sm:h-6 rounded-full overflow-hidden flex items-center justify-center shrink-0 shadow-sm mr-1 ml-0.5 select-none bg-black border border-white/20"
                title="Yaaro Ka Yaar"
              >
                <img
                  src="./assets/aistudio/logo_31cfa3bc.png"
                  alt="Logo"
                  className="w-full h-full object-cover"
                />
              </div>
            )}
            <button
              onClick={handleTopLeftIconClick}
              data-tv="header-btn"
              className="tv-focusable tv-nav-btn w-11 h-11 sm:w-12 sm:h-12 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors shrink-0"
              aria-label={screen === 'channels' ? 'Menu' : 'Back'}
            >
              {screen === 'channels' ? (
                <Menu className="w-6 h-6 stroke-[2]" />
              ) : (
                <ArrowLeft className="w-6 h-6 stroke-[2]" />
              )}
            </button>

            <h1
              className={`ml-1.5 sm:ml-2.5 text-[18px] sm:text-[20px] font-medium text-white tracking-normal truncate ${
                screen === 'file_picker'
                  ? 'max-w-[78vw] sm:max-w-[460px]'
                  : 'max-w-[200px] sm:max-w-[340px]'
              }`}
            >
              {getHeaderTitle()}
            </h1>
          </div>

          {/* Center Zone: App Name only on non-channels screens (channels screen stays clean matching 1.mp4) */}
          <div
            className={`flex-1 items-center justify-center min-w-0 px-2 ${
              screen === 'channels' || screen === 'file_picker' ? 'hidden' : 'flex'
            }`}
          >
            <span className="text-[15px] sm:text-[19px] md:text-[21px] font-bold text-white tracking-wide truncate text-center drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)]">
              Yaaro Ka Yaar Iptv HUB
            </span>
          </div>

          {/* Right Zone: Search Bar + Contextual Icons */}
          <div className="flex items-center gap-0.5 shrink-0">
            {screen === 'channels' && showSearchBar && (
              <div className="mr-1 flex items-center">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search channels..."
                  autoFocus
                  className="w-32 sm:w-52 md:w-64 bg-white/10 border-b border-white/80 focus:border-white rounded-t px-2.5 py-1 text-white placeholder-white/65 text-sm sm:text-base outline-none"
                />
              </div>
            )}
            {screen === 'add_url' ? (
              /* Checkmark (✓) on Add URL screen */
              <button
                onClick={() => handleAddUrlPlaylist()}
                disabled={isLoadingPlaylist}
                data-tv="header-btn"
                className="tv-focusable tv-nav-btn w-12 h-12 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 disabled:opacity-50 transition-colors"
                aria-label="Confirm Add URL"
              >
                <Check className="w-6 h-6 stroke-[2]" />
              </button>
            ) : screen === 'xtream_login' ? (
              /* Checkmark (✓) on Xtream Codes Login screen */
              <button
                onClick={() => handleXtreamLogin()}
                disabled={isLoadingPlaylist}
                data-tv="header-btn"
                className="tv-focusable tv-nav-btn w-12 h-12 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 disabled:opacity-50 transition-colors"
                aria-label="Confirm Xtream Login"
              >
                <Check className="w-6 h-6 stroke-[2]" />
              </button>
            ) : screen === 'channels' ? (
              /* EXACT 4 RIGHT ICONS FROM SCREENSHOT 6: Search, 3x3 Grid, Cast, 3-Dots */
              <>
                {/* 1. Search Icon */}
                <button
                  onClick={() => {
                    setShowSearchBar((prev) => !prev);
                    if (showSearchBar) setSearchQuery('');
                  }}
                  data-tv="header-btn"
                  className="tv-focusable tv-nav-btn w-11 h-11 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
                  title="Search"
                >
                  {showSearchBar ? (
                    <X className="w-[22px] h-[22px]" />
                  ) : (
                    <Search className="w-[22px] h-[22px] stroke-[2]" />
                  )}
                </button>

                {/* 2. 3x3 Grid / View Mode Switcher Icon */}
                <button
                  onClick={() => setViewLayout((prev) => (prev === 'grid' ? 'list' : 'grid'))}
                  data-tv="header-btn"
                  className="tv-focusable tv-nav-btn w-11 h-11 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
                  title="Change view mode"
                >
                  {viewLayout === 'grid' ? (
                    /* 3x3 Material Grid Icon matching Screenshot 6 */
                    <svg
                      viewBox="0 0 24 24"
                      className="w-[22px] h-[22px] fill-current"
                      aria-hidden="true"
                    >
                      <path d="M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z" />
                    </svg>
                  ) : (
                    <List className="w-[22px] h-[22px]" />
                  )}
                </button>

                {/* 3. Cast Icon matching Screenshot 6 */}
                <button
                  onClick={() => setCastModalOpen(true)}
                  data-tv="header-btn"
                  className={`tv-focusable tv-nav-btn relative w-11 h-11 rounded-full flex items-center justify-center transition-colors ${
                    castSession.isConnected
                      ? 'text-[#5BAAF5] bg-[#5BAAF5]/15 hover:bg-[#5BAAF5]/25 active:bg-[#5BAAF5]/35'
                      : 'text-white hover:bg-white/10 active:bg-white/20'
                  }`}
                  title={
                    castSession.isConnected
                      ? `Connected to ${castSession.connectedDevice?.name || 'TV'} (Click to manage)`
                      : 'Cast to TV'
                  }
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="w-[22px] h-[22px] fill-current"
                    aria-hidden="true"
                  >
                    <path d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z" />
                  </svg>
                  {castSession.isConnected && (
                    <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[#4CAF50] ring-2 ring-[#212121] animate-pulse" />
                  )}
                </button>

                {/* Three Vertical Dots (⋮) More Options Icon */}
                <button
                  onClick={() => {
                    setMoreMenuSortSubmenu(false);
                    setModalMode('more_menu');
                  }}
                  data-tv="header-btn"
                  className="tv-focusable tv-nav-btn w-11 h-11 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
                  title="More options"
                >
                  <MoreVertical className="w-[22px] h-[22px]" />
                </button>
              </>
            ) : screen === 'playlists' ? (
              /* "+" icon on Playlists screen */
              <button
                onClick={() => {
                  setLoadError(null);
                  setModalMode('add_menu');
                }}
                data-tv="header-btn"
                className="tv-focusable tv-nav-btn w-12 h-12 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
                aria-label="Add playlist"
                title="Add playlist"
              >
                <Plus className="w-6 h-6 stroke-[2]" />
              </button>
            ) : screen === 'epg_sources' ? (
              /* "+" and "⋮" icons on EPG sources screen (matching Screenshot_20261009-212456_IPTV.jpg) */
              <>
                <button
                  onClick={() => {
                    setModalMode('epg_add_menu');
                  }}
                  data-tv="header-btn"
                  className="tv-focusable tv-nav-btn w-11 h-11 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
                  aria-label="New EPG source"
                  title="New EPG source"
                >
                  <Plus className="w-6 h-6 stroke-[2]" />
                </button>
                <button
                  onClick={() => {
                    setModalMode('epg_add_menu');
                  }}
                  data-tv="header-btn"
                  className="tv-focusable tv-nav-btn w-11 h-11 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
                  aria-label="More options"
                  title="More options"
                >
                  <MoreVertical className="w-[22px] h-[22px]" />
                </button>
              </>
            ) : screen === 'proxy_settings' && useUdpProxy ? (
              /* "+" icon on Proxy settings screen when Use proxy is ON (matching Screenshot_20261009-213321_IPTV.jpg) */
              <button
                onClick={() => {
                  setUdpProxyName('');
                  setUdpProxyHost('');
                  setUdpProxyPort('');
                  setUdpProxyNameFocused(true);
                  setUdpProxyTypeDropdownOpen(false);
                  setUdpProxyModalOpen(true);
                }}
                data-tv="header-btn"
                className="tv-focusable tv-nav-btn w-12 h-12 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
                aria-label="New UDP proxy"
                title="New UDP proxy"
              >
                <Plus className="w-6 h-6 stroke-[2]" />
              </button>
            ) : screen === 'file_picker' ? (
              /* Direct Mobile Storage open button in Header */
              <button
                type="button"
                onClick={triggerMobileStoragePicker}
                data-tv="header-btn"
                className="tv-focusable tv-nav-btn h-9 px-2.5 sm:px-3 rounded bg-white/10 hover:bg-white/15 active:bg-white/20 flex items-center gap-1.5 cursor-pointer text-white transition-colors shrink-0"
                title="Open Mobile Storage"
              >
                <Folder className="w-4 h-4 text-[#5BAAF5]" />
                <span className="text-[13px] font-medium hidden sm:inline">Storage</span>
              </button>
            ) : null}
          </div>
        </div>

        {/* ===================================================================
            ROW 2 OF TOP BAR ON CHANNELS SCREEN:
            - If Xtream Playlist: 5 Tabs matching 1.mp4 (FAVORITES | HOME | LIVE | SERIES | VOD)
            - If Standard M3U Playlist: 3 Tabs matching 2.mp4 (FAVORITES | ALL CHANNELS | CATEGORIES)
            (Hidden while loading, matching 1.mp4 & 2.mp4)
           =================================================================== */}
        {screen === 'channels' && !isLoadingPlaylist && (
          isXtreamPlaylist ? (
            <div className="grid grid-cols-5 bg-[#215387] text-center select-none shadow-sm border-t border-black/15">
              <button
                data-tv="tab"
                data-tv-tab="FAVORITES"
                onClick={() => {
                  setChannelsTab('FAVORITES');
                }}
                className={`tv-focusable tv-nav-btn py-3 text-[11.5px] sm:text-[13px] font-medium uppercase tracking-wide border-b-[3px] transition-colors truncate px-0.5 ${
                  channelsTab === 'FAVORITES'
                    ? 'border-white text-white'
                    : 'border-transparent text-white/75 hover:text-white'
                }`}
              >
                FAVORITES
              </button>

              <button
                data-tv="tab"
                data-tv-tab="HOME"
                onClick={() => {
                  setSelectedCategory(null);
                  setChannelsTab('HOME');
                }}
                className={`tv-focusable tv-nav-btn py-3 text-[11.5px] sm:text-[13px] font-medium uppercase tracking-wide border-b-[3px] transition-colors truncate px-0.5 ${
                  channelsTab === 'HOME' || channelsTab === 'ALL_CHANNELS'
                    ? 'border-white text-white'
                    : 'border-transparent text-white/75 hover:text-white'
                }`}
              >
                HOME
              </button>

              <button
                data-tv="tab"
                data-tv-tab="LIVE"
                onClick={() => {
                  setSelectedCategory(null);
                  setChannelsTab('LIVE');
                }}
                className={`tv-focusable tv-nav-btn py-3 text-[11.5px] sm:text-[13px] font-medium uppercase tracking-wide border-b-[3px] transition-colors truncate px-0.5 ${
                  channelsTab === 'LIVE'
                    ? 'border-white text-white'
                    : 'border-transparent text-white/75 hover:text-white'
                }`}
              >
                LIVE
              </button>

              <button
                data-tv="tab"
                data-tv-tab="SERIES"
                onClick={() => {
                  setSelectedCategory(null);
                  setChannelsTab('SERIES');
                }}
                className={`tv-focusable tv-nav-btn py-3 text-[11.5px] sm:text-[13px] font-medium uppercase tracking-wide border-b-[3px] transition-colors truncate px-0.5 ${
                  channelsTab === 'SERIES'
                    ? 'border-white text-white'
                    : 'border-transparent text-white/75 hover:text-white'
                }`}
              >
                SERIES
              </button>

              <button
                data-tv="tab"
                data-tv-tab="VOD"
                onClick={() => {
                  setSelectedCategory(null);
                  setChannelsTab('VOD');
                }}
                className={`tv-focusable tv-nav-btn py-3 text-[11.5px] sm:text-[13px] font-medium uppercase tracking-wide border-b-[3px] transition-colors truncate px-0.5 ${
                  channelsTab === 'VOD'
                    ? 'border-white text-white'
                    : 'border-transparent text-white/75 hover:text-white'
                }`}
              >
                VOD
              </button>
            </div>
          ) : (
            /* Standard M3U Playlist 3-Tabs matching 2.mp4 Frame 00:28 (FAVORITES | ALL CHANNELS | CATEGORIES) */
            <div className="grid grid-cols-3 bg-[#215387] text-center select-none shadow-sm border-t border-black/15">
              <button
                data-tv="tab"
                data-tv-tab="FAVORITES"
                onClick={() => {
                  setChannelsTab('FAVORITES');
                }}
                className={`tv-focusable tv-nav-btn py-3 text-[13px] font-medium uppercase tracking-wide border-b-[3px] transition-colors ${
                  channelsTab === 'FAVORITES'
                    ? 'border-white text-white'
                    : 'border-transparent text-white/75 hover:text-white'
                }`}
              >
                FAVORITES
              </button>

              <button
                data-tv="tab"
                data-tv-tab="ALL_CHANNELS"
                onClick={() => {
                  setSelectedCategory(null);
                  setChannelsTab('ALL_CHANNELS');
                }}
                className={`tv-focusable tv-nav-btn py-3 text-[13px] font-medium uppercase tracking-wide border-b-[3px] transition-colors ${
                  channelsTab === 'ALL_CHANNELS' || channelsTab === 'HOME'
                    ? 'border-white text-white'
                    : 'border-transparent text-white/75 hover:text-white'
                }`}
              >
                ALL CHANNELS
              </button>

              <button
                data-tv="tab"
                data-tv-tab="CATEGORIES"
                onClick={() => {
                  setChannelsTab('CATEGORIES');
                  if (!selectedCategory && categoryCounts.length > 0) {
                    setSelectedCategory(categoryCounts[0].name);
                  }
                }}
                className={`tv-focusable tv-nav-btn py-3 text-[13px] font-medium uppercase tracking-wide border-b-[3px] transition-colors truncate px-2 ${
                  channelsTab === 'CATEGORIES'
                    ? 'border-white text-white'
                    : 'border-transparent text-white/75 hover:text-white'
                }`}
              >
                CATEGORIES
              </button>
            </div>
          )
        )}

        {/* ===================================================================
            ROW 2 OF TOP BAR ON PROXY SETTINGS SCREEN:
            "Use proxy" bar with right toggle switch — Exact Match to Screenshot
           =================================================================== */}
        {screen === 'proxy_settings' && (
          <div
            onClick={() => setUseUdpProxy((prev) => !prev)}
            className="h-14 px-4 bg-[#1E4B7A] border-t border-black/25 flex items-center justify-between cursor-pointer select-none"
          >
            <span className="text-[18px] font-normal text-white">Use proxy</span>

            {/* Material Switch */}
            <div className="relative w-9 h-3.5 flex items-center mr-1">
              <div
                className={`w-8 h-3.5 rounded-full transition-colors ${
                  useUdpProxy ? 'bg-[#3C658C]' : 'bg-black/35'
                }`}
              />
              <div
                className={`absolute w-5 h-5 rounded-full shadow-md transition-transform duration-150 ${
                  useUdpProxy
                    ? 'translate-x-4 bg-[#5BAAF5]'
                    : '-translate-x-0.5 bg-[#BDBDBD]'
                }`}
              />
            </div>
          </div>
        )}
      </header>

      {/* =====================================================================
          EXACT TOP-RIGHT POPUP MENU FROM SCREENSHOT 2
          ("Add URL", "Select File", "Xtream Codes Login")
         ===================================================================== */}
      {modalMode === 'add_menu' && (
        <div
          onClick={() => setModalMode(null)}
          className="fixed inset-0 z-50 bg-transparent"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="fixed top-1.5 right-1 w-[205px] bg-[#303030] rounded-[2px] shadow-[0_5px_15px_rgba(0,0,0,0.65)] py-1 text-white z-50 border border-white/[0.04]"
          >
            <button
              data-tv="menu-item"
              tabIndex={0}
              onClick={() => {
                setLoadError(null);
                setModalMode(null);
                setScreen('add_url');
              }}
              className="tv-focusable w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
            >
              Add URL
            </button>

            <div className="relative w-full">
              <button
                type="button"
                data-tv="menu-item"
                tabIndex={0}
                onClick={() => {
                  triggerMobileStoragePicker();
                }}
                className="tv-focusable w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 focus:bg-white/15 focus:outline-none cursor-pointer transition-colors"
              >
                Select File
              </button>
              <input
                type="file"
                accept="*/*"
                aria-label="Select File"
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-30"
                onClick={(e) => {
                  e.stopPropagation();
                  (e.target as HTMLInputElement).value = '';
                }}
                onChange={(e) => {
                  setModalMode(null);
                  handleFileChange(e);
                }}
              />
            </div>

            <button
              data-tv="menu-item"
              tabIndex={0}
              onClick={() => {
                setLoadError(null);
                setModalMode(null);
                setScreen('xtream_login');
              }}
              className="tv-focusable w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
            >
              Xtream Codes Login
            </button>
          </div>
        </div>
      )}

      {/* =====================================================================
          EXACT TOP-RIGHT POPUP MENU FOR EPG SOURCES
          ("Add URL", "Select File") — Exact Match to Screenshot_20261009-211716_IPTV.jpg
         ===================================================================== */}
      {modalMode === 'epg_add_menu' && (
        <div
          onClick={() => setModalMode(null)}
          className="fixed inset-0 z-50 bg-transparent"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="fixed top-1.5 right-1 w-[196px] bg-[#303030] rounded-[2px] shadow-[0_5px_15px_rgba(0,0,0,0.65)] py-1 text-white z-50 border border-white/[0.04]"
          >
            <button
              data-tv="menu-item"
              tabIndex={0}
              onClick={() => {
                setModalMode(null);
                setEpgUrlDraft('');
                setEpgUrlModalOpen(true);
              }}
              className="tv-focusable w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
            >
              Add URL
            </button>

            <div className="relative w-full">
              <button
                type="button"
                data-tv="menu-item"
                tabIndex={0}
                onClick={() => {
                  triggerMobileStoragePicker();
                }}
                className="tv-focusable w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 focus:bg-white/15 focus:outline-none cursor-pointer transition-colors"
              >
                Select File
              </button>
              <input
                type="file"
                accept="*/*"
                aria-label="Select File"
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-30"
                onClick={(e) => {
                  e.stopPropagation();
                  (e.target as HTMLInputElement).value = '';
                }}
                onChange={(e) => {
                  setModalMode(null);
                  handleFileChange(e);
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          TOP-RIGHT "⋮" MORE MENU ON CHANNELS SCREEN
          Exact Match to Screenshot_20261010-125316_IPTV.jpg ("Refresh", "Sort ▸")
         ===================================================================== */}
      {modalMode === 'more_menu' && (
        <div
          onClick={() => {
            setMoreMenuSortSubmenu(false);
            setModalMode(null);
          }}
          className="fixed inset-0 z-50 bg-transparent"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="fixed top-2 right-2.5 w-[196px] bg-[#303030] rounded-[2px] shadow-[0_6px_18px_rgba(0,0,0,0.75)] py-1 text-white z-50 border border-white/[0.04]"
          >
            {!moreMenuSortSubmenu ? (
              <>
                <button
                  type="button"
                  data-tv="menu-item"
                  tabIndex={0}
                  onClick={async () => {
                    setModalMode(null);
                    if (
                      !activePlaylist ||
                      activePlaylist.id === INITIAL_YAARO_PLAYLIST.id ||
                      activePlaylist.name.toLowerCase().includes('yaaro')
                    ) {
                      setPlaylists((prev) =>
                        prev.map((pl) =>
                          pl.id === activePlaylist?.id || pl.name.toLowerCase().includes('yaaro')
                            ? { ...pl, channels: INITIAL_YAARO_PLAYLIST.channels }
                            : pl
                        )
                      );
                      showToast(`Reloaded all ${INITIAL_YAARO_PLAYLIST.channels.length} channels`);
                      return;
                    }
                    if (activePlaylist?.sourceUrl) {
                      try {
                        const response = await fetchWithUniversalFallback(
                          activePlaylist.sourceUrl,
                          `url=${encodeURIComponent(activePlaylist.sourceUrl)}`
                        );
                        if (response.ok) {
                          const content = await response.text();
                          const parsed = parsePlaylistContent(content);
                          if (parsed.length > 0) {
                            setPlaylists((prev) =>
                              prev.map((pl) =>
                                pl.id === activePlaylist.id
                                  ? { ...pl, channels: parsed }
                                  : pl
                              )
                            );
                          }
                        }
                      } catch {
                        // keep existing channels if offline
                      }
                    }
                    showToast('Playlist refreshed');
                  }}
                  className="tv-focusable w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                >
                  Refresh
                </button>

                <button
                  type="button"
                  data-tv="menu-item"
                  tabIndex={0}
                  onClick={() => {
                    setModalMode(null);
                    setScreen('playlists');
                  }}
                  className="tv-focusable w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                >
                  Playlists
                </button>

                <button
                  type="button"
                  data-tv="menu-item"
                  tabIndex={0}
                  onClick={() => setMoreMenuSortSubmenu(true)}
                  className="tv-focusable w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors flex items-center justify-between"
                >
                  <span>Sort</span>
                  <svg
                    viewBox="0 0 24 24"
                    className="w-4 h-4 fill-white shrink-0"
                    aria-hidden="true"
                  >
                    <path d="M10 17l5-5-5-5v10z" />
                  </svg>
                </button>
              </>
            ) : (
              <>
                {(['Default', 'By channel name', 'By channel number'] as const).map(
                  (mode) => (
                    <button
                      key={mode}
                      type="button"
                      data-tv="menu-item"
                      tabIndex={0}
                      onClick={() => {
                        setChannelsSortMode(mode);
                        setMoreMenuSortSubmenu(false);
                        setModalMode(null);
                      }}
                      className="tv-focusable w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors flex items-center justify-between"
                    >
                      <span>{mode}</span>
                      {channelsSortMode === mode && (
                        <span className="w-2 h-2 rounded-full bg-[#5BAAF5]" />
                      )}
                    </button>
                  )
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          MAIN BODY AREA (#303030 exact match to screenshots)
         ===================================================================== */}
      <main
        className={`flex-1 flex flex-col min-h-0 bg-[#303030] ${
          screen === 'channels' ? 'overflow-hidden' : 'overflow-y-auto'
        }`}
      >
        {/* -------------------------------------------------------------------
            SCREEN: ADD URL (Exact Match to Screenshot 3 & 4)
           ------------------------------------------------------------------- */}
        {screen === 'add_url' && (
          <form
            onSubmit={handleAddUrlPlaylist}
            className="flex-1 flex flex-col px-4 pt-7 pb-10 w-full"
          >
            <p className="text-[14.5px] font-normal text-[#E2E2E2] mb-4">
              Please input a network URL for your playlist
            </p>

            <div className="w-full">
              <label
                htmlFor="playlist-url-input"
                className={`block text-[12px] font-normal transition-colors ${
                  urlFocused || urlInput ? 'text-[#5B9BD5]' : 'text-[#9E9E9E]'
                }`}
              >
                Playlist URL
              </label>
              <input
                id="playlist-url-input"
                ref={urlInputRef}
                type="url"
                value={urlInput}
                onFocus={() => setUrlFocused(true)}
                onBlur={() => setUrlFocused(false)}
                onChange={(e) => setUrlInput(e.target.value)}
                autoFocus
                className={`w-full bg-transparent text-white text-[16px] pt-1 pb-1.5 outline-none transition-colors ${
                  urlFocused
                    ? 'border-b-[2px] border-[#5B9BD5]'
                    : 'border-b border-[#8E8E8E]'
                }`}
              />
            </div>

            <div className="w-full mt-7">
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="Playlist name (optionally)"
                className="w-full bg-transparent text-white placeholder-[#9E9E9E] text-[16px] py-1.5 border-b border-[#8E8E8E] focus:border-b-[2px] focus:border-[#5B9BD5] outline-none transition-colors"
              />
            </div>

            <div className="w-full mt-8">
              <button
                type="button"
                onClick={() => setCatchupExpanded((prev) => !prev)}
                className="w-full flex items-center py-1 text-left focus:outline-none"
              >
                {catchupExpanded ? (
                  <ChevronUp className="w-3.5 h-3.5 text-[#E0E0E0] stroke-[2.5] mr-1.5 shrink-0" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 text-[#E0E0E0] stroke-[2.5] mr-1.5 shrink-0" />
                )}
                <span className="text-[12px] font-semibold tracking-wider text-[#E0E0E0] uppercase shrink-0">
                  CATCHUP
                </span>
                <div className="flex-1 h-[1px] bg-[#8E8E8E] ml-2.5" />
              </button>

              {catchupExpanded && (
                <div className="mt-4 space-y-5">
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setCatchupDropdownOpen((prev) => !prev)}
                      className="w-full flex items-center justify-between py-2 pl-1 pr-2 text-left text-[15.5px] text-white hover:bg-white/[0.03] transition-colors"
                    >
                      <span>{catchupType}</span>
                      <span className="text-[#CCCCCC] text-[11px] leading-none">▼</span>
                    </button>

                    {catchupDropdownOpen && (
                      <>
                        <div
                          onClick={() => setCatchupDropdownOpen(false)}
                          className="fixed inset-0 z-40"
                        />
                        <div className="absolute -left-2 right-7 -top-1 z-50 bg-[#303030] rounded-[2px] shadow-[0_6px_20px_rgba(0,0,0,0.75)] py-1 border border-white/[0.04]">
                          {CATCHUP_MODES.map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => {
                                setCatchupType(mode);
                                setCatchupDropdownOpen(false);
                              }}
                              className="w-full px-3.5 py-3.5 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                            >
                              {mode}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  <div className="w-full">
                    <input
                      type="number"
                      min="0"
                      max="30"
                      value={catchupDays}
                      onChange={(e) => setCatchupDays(e.target.value)}
                      placeholder="Days (optional)"
                      className="w-full bg-transparent text-white placeholder-[#9E9E9E] text-[16px] py-1.5 border-b border-[#8E8E8E] focus:border-b-[2px] focus:border-[#5B9BD5] outline-none transition-colors"
                    />
                  </div>
                </div>
              )}
            </div>

            {loadError && (
              <p className="mt-6 text-xs text-[#EF9A9A] bg-[#B71C1C]/30 px-3 py-2 rounded max-w-lg">
                {loadError}
              </p>
            )}
          </form>
        )}

        {/* -------------------------------------------------------------------
            SCREEN: XTREAM CODES LOGIN (Exact Match to Screenshot 5)
           ------------------------------------------------------------------- */}
        {screen === 'xtream_login' && (
          <form
            onSubmit={handleXtreamLogin}
            className="flex-1 flex flex-col px-4 pt-7 pb-10 w-full"
          >
            <p className="text-[14.5px] font-normal text-[#E2E2E2] mb-4">
              Please input Xtream Codes credentials
            </p>

            <div className="w-full">
              <label
                htmlFor="xtream-server-input"
                className={`block text-[12px] font-normal transition-colors ${
                  xtreamServerFocused || xtreamServer ? 'text-[#5B9BD5]' : 'text-[#9E9E9E]'
                }`}
              >
                Server:Port
              </label>
              <input
                id="xtream-server-input"
                type="text"
                required
                value={xtreamServer}
                onFocus={() => setXtreamServerFocused(true)}
                onBlur={() => setXtreamServerFocused(false)}
                onChange={(e) => setXtreamServer(e.target.value)}
                autoFocus
                className={`w-full bg-transparent text-white text-[16px] pt-1 pb-1.5 outline-none transition-colors ${
                  xtreamServerFocused
                    ? 'border-b-[2px] border-[#5B9BD5]'
                    : 'border-b border-[#8E8E8E]'
                }`}
              />
            </div>

            <div className="w-full mt-7">
              <input
                type="text"
                required
                value={xtreamUsername}
                onChange={(e) => setXtreamUsername(e.target.value)}
                placeholder="Login or MAC address (e.g. 00:1A:79:...)"
                className="w-full bg-transparent text-white placeholder-[#9E9E9E] text-[16px] py-1.5 border-b border-[#8E8E8E] focus:border-b-[2px] focus:border-[#5B9BD5] outline-none transition-colors"
              />
            </div>

            <div className="w-full mt-7 relative flex items-center">
              <input
                type={showXtreamPassword ? 'text' : 'password'}
                required={!normalizeMacAddress(xtreamUsername)}
                value={xtreamPassword}
                onChange={(e) => setXtreamPassword(e.target.value)}
                placeholder={
                  normalizeMacAddress(xtreamUsername)
                    ? 'Password (optional for MAC portal)'
                    : 'Password'
                }
                className="w-full bg-transparent text-white placeholder-[#9E9E9E] text-[16px] py-1.5 pr-9 border-b border-[#8E8E8E] focus:border-b-[2px] focus:border-[#5B9BD5] outline-none transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowXtreamPassword((prev) => !prev)}
                className="absolute right-1.5 bottom-1.5 p-1 text-[#BDBDBD] hover:text-white transition-colors"
                aria-label="Toggle password visibility"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="w-5 h-5 fill-current"
                  aria-hidden="true"
                >
                  <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
                </svg>
              </button>
            </div>

            <div className="w-full mt-7">
              <input
                type="text"
                value={xtreamName}
                onChange={(e) => setXtreamName(e.target.value)}
                placeholder="Playlist name (optionally)"
                className="w-full bg-transparent text-white placeholder-[#9E9E9E] text-[16px] py-1.5 border-b border-[#8E8E8E] focus:border-b-[2px] focus:border-[#5B9BD5] outline-none transition-colors"
              />
            </div>

            <div className="w-full mt-7 relative">
              <div
                onClick={() => setXtreamFormatDropdownOpen((prev) => !prev)}
                className="w-full border border-[#9E9E9E] rounded-[4px] px-3 py-3 text-[15.5px] text-white cursor-pointer relative"
              >
                <span className="absolute -top-2.5 left-2.5 bg-[#303030] px-1.5 text-[12px] text-[#BDBDBD] leading-none">
                  Stream format
                </span>
                <span>{xtreamStreamFormat}</span>
              </div>

              {xtreamFormatDropdownOpen && (
                <>
                  <div
                    onClick={() => setXtreamFormatDropdownOpen(false)}
                    className="fixed inset-0 z-40"
                  />
                  <div className="absolute left-0 right-0 top-12 z-50 bg-[#303030] rounded-[2px] shadow-[0_6px_20px_rgba(0,0,0,0.75)] py-1 border border-white/[0.06]">
                    {(['TS', 'HLS'] as const).map((fmt) => (
                      <button
                        key={fmt}
                        type="button"
                        onClick={() => {
                          setXtreamStreamFormat(fmt);
                          setXtreamFormatDropdownOpen(false);
                        }}
                        className="w-full px-4 py-3 text-left text-[15.5px] text-white hover:bg-white/10 transition-colors"
                      >
                        {fmt}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="w-full mt-5 space-y-3.5">
              <div
                onClick={() => setImportLiveChannels((prev) => !prev)}
                className="flex items-center justify-between cursor-pointer py-0.5"
              >
                <span className="text-[14.5px] font-normal text-white">
                  Import Live Channels
                </span>
                <div className="relative w-9 h-3.5 flex items-center">
                  <div
                    className={`w-8 h-3.5 rounded-full transition-colors ${
                      importLiveChannels ? 'bg-[#3C658C]' : 'bg-[#6E6E6E]'
                    }`}
                  />
                  <div
                    className={`absolute w-5 h-5 rounded-full shadow-md transition-transform duration-150 ${
                      importLiveChannels
                        ? 'translate-x-4 bg-[#5BAAF5]'
                        : '-translate-x-0.5 bg-[#BDBDBD]'
                    }`}
                  />
                </div>
              </div>

              <div
                onClick={() => setImportSeries((prev) => !prev)}
                className="flex items-center justify-between cursor-pointer py-0.5"
              >
                <span className="text-[14.5px] font-normal text-white">
                  Import Series
                </span>
                <div className="relative w-9 h-3.5 flex items-center">
                  <div
                    className={`w-8 h-3.5 rounded-full transition-colors ${
                      importSeries ? 'bg-[#3C658C]' : 'bg-[#6E6E6E]'
                    }`}
                  />
                  <div
                    className={`absolute w-5 h-5 rounded-full shadow-md transition-transform duration-150 ${
                      importSeries
                        ? 'translate-x-4 bg-[#5BAAF5]'
                        : '-translate-x-0.5 bg-[#BDBDBD]'
                    }`}
                  />
                </div>
              </div>

              <div
                onClick={() => setImportVods((prev) => !prev)}
                className="flex items-center justify-between cursor-pointer py-0.5"
              >
                <span className="text-[14.5px] font-normal text-white">
                  Import VODs
                </span>
                <div className="relative w-9 h-3.5 flex items-center">
                  <div
                    className={`w-8 h-3.5 rounded-full transition-colors ${
                      importVods ? 'bg-[#3C658C]' : 'bg-[#6E6E6E]'
                    }`}
                  />
                  <div
                    className={`absolute w-5 h-5 rounded-full shadow-md transition-transform duration-150 ${
                      importVods
                        ? 'translate-x-4 bg-[#5BAAF5]'
                        : '-translate-x-0.5 bg-[#BDBDBD]'
                    }`}
                  />
                </div>
              </div>
            </div>

            {loadError && (
              <p className="mt-6 text-xs text-[#EF9A9A] bg-[#B71C1C]/30 px-3 py-2 rounded max-w-lg">
                {loadError}
              </p>
            )}
          </form>
        )}

        {/* -------------------------------------------------------------------
            SCREEN: PLAYLISTS (Exact Match to Screenshot 1 & Screenshot 12)
           ------------------------------------------------------------------- */}
        {screen === 'playlists' && (
          <>
            {displayedPlaylists.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
                <p className="text-[#B5B5B5] text-[14.5px] font-normal tracking-[0.01em] leading-relaxed">
                  Please contact your IPTV provider to get M3U or XSPF playlist with TV channels
                </p>

                <button
                  data-tv="add-playlist-btn"
                  tabIndex={0}
                  onClick={() => {
                    setLoadError(null);
                    setModalMode('add_menu');
                  }}
                  className="tv-focusable mt-4 flex items-center gap-3 px-4 py-2.5 rounded hover:bg-white/5 active:bg-white/10 transition-colors cursor-pointer"
                >
                  <Plus className="w-6 h-6 text-[#9E9E9E] stroke-[1.75]" />
                  <span className="text-white text-[18px] font-normal tracking-[0.01em]">
                    Add playlist
                  </span>
                </button>
              </div>
            ) : (
              /* EXACT FULL-WIDTH PLAYLISTS LIST FROM SCREENSHOT 12 */
              <div className="w-full flex-1 flex flex-col">
                {/* "CURRENT" Section Header */}
                <div className="w-full px-2 py-1.5 border-b border-white/[0.12]">
                  <span className="text-[11.5px] font-bold tracking-wide text-[#CCCCCC] uppercase">
                    CURRENT
                  </span>
                </div>

                {/* Playlist Rows */}
                <div className="w-full divide-y divide-white/[0.12]">
                  {displayedPlaylists.map((pl) => {
                    const displayPath = pl.sourceUrl
                      ? pl.sourceUrl
                      : `/storage/emulated/0/Download/${pl.name}`;
                    const isMenuOpen = openPlaylistMenuId === pl.id;

                    return (
                      <div
                        key={pl.id}
                        tabIndex={0}
                        role="button"
                        data-tv="playlist"
                        data-playlist-id={pl.id}
                        onFocus={(e) => {
                          focusTvElement(e.currentTarget, true);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === 'Select' || (e as any).keyCode === 23) {
                            e.preventDefault();
                            setActivePlaylistId(pl.id);
                            setSelectedCategory(null);
                            setChannelsTab('ALL_CHANNELS');
                            setScreen('channels');
                          }
                        }}
                        onClick={() => {
                          setActivePlaylistId(pl.id);
                          setSelectedCategory(null);
                          setChannelsTab('ALL_CHANNELS');
                          setScreen('channels');
                        }}
                        className="tv-focusable tv-playlist-item relative w-full flex items-center justify-between px-3 py-3 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
                      >
                        <div className="flex items-center gap-4 min-w-0 flex-1">
                          {/* Material Document / File Icon matching Screenshot 12 */}
                          <svg
                            viewBox="0 0 24 24"
                            className="w-6 h-6 fill-[#BDBDBD] shrink-0"
                            aria-hidden="true"
                          >
                            <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" />
                          </svg>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <h3 className="text-[16px] font-normal text-white truncate leading-snug">
                                {pl.name}
                              </h3>
                              <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-white/10 text-[#5BAAF5]">
                                {pl.channels?.length || 0} channels
                              </span>
                            </div>
                            <p className="text-[13px] font-normal text-[#B5B5B5] truncate leading-snug mt-0.5">
                              {displayPath}
                            </p>
                          </div>
                        </div>

                        {/* Three Vertical Dots (⋮) Button */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenPlaylistMenuId(isMenuOpen ? null : pl.id);
                          }}
                          className="w-10 h-10 rounded-full flex items-center justify-center text-[#CCCCCC] hover:text-white hover:bg-white/10 transition-colors shrink-0"
                          aria-label="Playlist options"
                        >
                          <MoreVertical className="w-5 h-5" />
                        </button>

                        {/* Exact Popup Menu ("Open", "Edit", "Share", "Delete") from Screenshot 12 */}
                        {isMenuOpen && (
                          <>
                            <div
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenPlaylistMenuId(null);
                              }}
                              className="fixed inset-0 z-40 bg-transparent"
                            />
                            <div
                              onClick={(e) => e.stopPropagation()}
                              className="absolute right-1 top-full mt-0.5 w-[220px] bg-[#303030] rounded-[2px] shadow-[0_5px_16px_rgba(0,0,0,0.75)] py-1 text-white z-50 border border-white/[0.05]"
                            >
                              <button
                                type="button"
                                data-tv="menu-item"
                                tabIndex={0}
                                onClick={() => {
                                  setOpenPlaylistMenuId(null);
                                  setActivePlaylistId(pl.id);
                                  setSelectedCategory(null);
                                  setChannelsTab('ALL_CHANNELS');
                                  setScreen('channels');
                                }}
                                className="tv-focusable w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                              >
                                Open
                              </button>

                              <button
                                type="button"
                                data-tv="menu-item"
                                tabIndex={0}
                                onClick={() => {
                                  setOpenPlaylistMenuId(null);
                                  setPlaylists((prev) =>
                                    prev.map((item) =>
                                      item.id === pl.id || item.name.toLowerCase().includes('yaaro')
                                        ? {
                                            ...INITIAL_YAARO_PLAYLIST,
                                            id: item.id,
                                            name: item.name,
                                            channels: INITIAL_YAARO_PLAYLIST.channels,
                                          }
                                        : item
                                    )
                                  );
                                  setActivePlaylistId(pl.id);
                                  showToast(`Reloaded all ${INITIAL_YAARO_PLAYLIST.channels.length} channels`);
                                }}
                                className="tv-focusable w-full px-4 py-3 text-left text-[15.5px] font-normal text-[#5BAAF5] hover:bg-white/10 active:bg-white/15 transition-colors"
                              >
                                Reload all {INITIAL_YAARO_PLAYLIST.channels.length} channels
                              </button>

                              <button
                                type="button"
                                data-tv="menu-item"
                                tabIndex={0}
                                onClick={() => {
                                  setOpenPlaylistMenuId(null);
                                  if (pl.sourceUrl) {
                                    setUrlInput(pl.sourceUrl);
                                    setNameInput(pl.name);
                                    setScreen('add_url');
                                  } else {
                                    setEditingPlaylist(pl);
                                    setEditNameValue(pl.name);
                                  }
                                }}
                                className="tv-focusable w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                              >
                                Edit
                              </button>

                              <button
                                type="button"
                                data-tv="menu-item"
                                tabIndex={0}
                                onClick={() => {
                                  setOpenPlaylistMenuId(null);
                                  if (navigator.share) {
                                    navigator
                                      .share({
                                        title: pl.name,
                                        text: displayPath,
                                      })
                                      .catch(() => {});
                                  } else {
                                    navigator.clipboard?.writeText(displayPath).catch(() => {});
                                    showToast('Playlist path copied');
                                  }
                                }}
                                className="tv-focusable w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                              >
                                Share
                              </button>

                              <button
                                type="button"
                                data-tv="menu-item"
                                tabIndex={0}
                                onClick={(e) => {
                                  setOpenPlaylistMenuId(null);
                                  handleDeletePlaylist(pl.id, e);
                                }}
                                className="tv-focusable w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                              >
                                Delete
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {/* -------------------------------------------------------------------
            SCREEN: CHANNELS (Exact Match to Screenshot 6 & 1.mp4!)
           ------------------------------------------------------------------- */}
        {screen === 'channels' && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[#303030]">
            {isLoadingPlaylist ? (
              /* EXACT LOADING PROCESS INTERFACE FROM 1.mp4 (Frame 00:04 to 02:11) */
              <div className="flex-1 flex flex-col items-center justify-center p-6 select-none bg-[#303030]">
                <div className="relative w-12 h-12 flex items-center justify-center">
                  <div className="w-12 h-12 rounded-full border-[3.5px] border-[#4EA1F3] border-t-transparent animate-spin" />
                </div>
                <p className="mt-4 text-[16px] text-[#E0E0E0] font-normal tracking-wide">
                  Loading...
                </p>
              </div>
            ) : loadError && (!activePlaylist || activePlaylist.channels.length === 0) ? (
              <div className="flex-1 flex flex-col items-center justify-center px-6 text-center bg-[#303030]">
                <div className="w-12 h-12 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center mb-3">
                  <X className="w-6 h-6 stroke-[2]" />
                </div>
                <p className="text-[#FF8A80] text-[15.5px] font-medium mb-1.5 max-w-md leading-normal">
                  {loadError}
                </p>
                <p className="text-xs text-[#9E9E9E] mb-5">
                  {isXtreamPlaylist
                    ? 'Verify Server:Port, Login, and Password, or server connection.'
                    : 'Verify playlist URL, internet connection, or try another link.'}
                </p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => {
                      if (isXtreamPlaylist) {
                        setScreen('xtream_login');
                      } else {
                        if (activePlaylist?.sourceUrl) {
                          setUrlInput(activePlaylist.sourceUrl);
                        }
                        setScreen('add_url');
                      }
                    }}
                    className="px-4 py-2 rounded bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors cursor-pointer"
                  >
                    {isXtreamPlaylist ? 'Edit Credentials' : 'Edit URL'}
                  </button>
                  <button
                    onClick={() => {
                      if (isXtreamPlaylist) {
                        handleXtreamLogin();
                      } else {
                        handleAddUrlPlaylist();
                      }
                    }}
                    className="px-4 py-2 rounded bg-[#215387] hover:bg-[#1B64B1] text-white text-sm font-medium transition-colors cursor-pointer"
                  >
                    Retry Connection
                  </button>
                </div>
              </div>
            ) : !activePlaylist ? (
              <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
                <p className="text-[#B5B5B5] text-[14.5px] font-normal leading-relaxed">
                  Please contact your IPTV provider to get M3U or XSPF playlist with TV channels
                </p>
                <button
                  onClick={() => setModalMode('add_menu')}
                  className="mt-4 flex items-center gap-3 px-4 py-2.5 rounded hover:bg-white/5 active:bg-white/10 transition-colors"
                >
                  <Plus className="w-6 h-6 text-[#9E9E9E] stroke-[1.75]" />
                  <span className="text-white text-[18px] font-normal">Add playlist</span>
                </button>
              </div>
            ) : channelsTab === 'CATEGORIES' ? (
              /* EXACT 2-PANE SPLIT LAYOUT FROM SCREENSHOT 8:
                 Left Column: Fixed Category Sidebar (#424242 inactive, #2E8BC0 active)
                 Right Area: Independently Scrollable Channel Content for Selected Category */
              <div className="flex-1 flex flex-row min-h-0 overflow-hidden">
                {/* Left Sidebar: Fixed on screen, independent scroll if categories overflow */}
                <aside className="tv-scroll-container w-[220px] sm:w-[270px] md:w-[310px] h-full shrink-0 overflow-y-auto overscroll-contain p-2 space-y-2">
                  {categoryCounts.map((cat) => {
                    const activeCatName = selectedCategory || categoryCounts[0]?.name;
                    const isSelected = cat.name === activeCatName;
                    return (
                      <div
                        key={cat.name}
                        tabIndex={0}
                        role="button"
                        data-tv="category"
                        data-active={isSelected ? 'true' : 'false'}
                        data-category-name={cat.name}
                        onFocus={(e) => {
                          focusTvElement(e.currentTarget, true);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === 'Select' || (e as any).keyCode === 23) {
                            e.preventDefault();
                            setSelectedCategory(cat.name);
                            categoryContentRef.current?.scrollTo({ top: 0 });
                          }
                        }}
                        onClick={() => {
                          setSelectedCategory(cat.name);
                          categoryContentRef.current?.scrollTo({ top: 0 });
                        }}
                        className={`tv-focusable tv-category-item rounded-[3px] px-3.5 py-2.5 cursor-pointer transition-colors shadow-[0_1px_2px_rgba(0,0,0,0.3)] ${
                          isSelected
                            ? 'bg-[#2E8BC0] text-white ring-1 ring-white/30'
                            : 'bg-[#424242] hover:bg-[#4A4A4A] text-white'
                        }`}
                      >
                        <h3 className="text-[15.5px] font-normal text-white truncate leading-snug">
                          {cat.name}
                        </h3>
                        <p
                          className={`text-[12.5px] mt-0.5 leading-tight ${
                            isSelected ? 'text-white/85' : 'text-[#B8B8B8]'
                          }`}
                        >
                          {cat.count} {cat.count === 1 ? 'channel' : 'channels'}
                        </p>
                      </div>
                    );
                  })}
                </aside>

                {/* Right Pane: Only this content area scrolls when browsing channels */}
                <div
                  ref={categoryContentRef}
                  className="tv-scroll-container flex-1 h-full overflow-y-auto overscroll-contain px-2 py-2"
                >
                  {viewLayout === 'grid' ? (
                    <div className="w-full grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-9 gap-x-2 gap-y-4">
                      {filteredChannels.map((ch) => (
                        <div
                          key={ch.id}
                          tabIndex={0}
                          role="button"
                          data-tv="channel"
                          data-channel-id={ch.id}
                          onFocus={(e) => {
                            focusTvElement(e.currentTarget, true);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === 'Select' || (e as any).keyCode === 23) {
                              e.preventDefault();
                              handleSelectChannel(ch);
                            }
                          }}
                          onClick={() => handleSelectChannel(ch)}
                          className="tv-focusable tv-channel-card flex flex-col items-center justify-start cursor-pointer px-1 py-1.5 rounded transition-all"
                        >
                          <ChannelTileLogo channel={ch} />
                          <span className="mt-1.5 text-[11.5px] leading-[1.2] text-[#C8C8C8] text-center line-clamp-2 w-full break-words font-normal">
                            {showChannelNumbers ? `${ch.number}. ` : ''}
                            {ch.name}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="w-full divide-y divide-white/[0.07]">
                      {filteredChannels.map((ch) => {
                        const isFav = favorites.includes(ch.id);
                        return (
                          <div
                            key={ch.id}
                            tabIndex={0}
                            role="button"
                            data-tv="channel"
                            data-channel-id={ch.id}
                            onFocus={(e) => {
                              focusTvElement(e.currentTarget, true);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === 'Select' || (e as any).keyCode === 23) {
                                e.preventDefault();
                                handleSelectChannel(ch);
                              }
                            }}
                            onClick={() => handleSelectChannel(ch)}
                            className="tv-focusable tv-channel-card flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.06] active:bg-white/[0.12] cursor-pointer transition-colors rounded"
                          >
                            <div className="flex items-center gap-3.5 min-w-0">
                              <ChannelTileLogo channel={ch} />
                              <div className="min-w-0">
                                <h3 className="text-[15px] font-normal text-white truncate">
                                  {ch.name}
                                </h3>
                                <p className="text-xs text-[#9E9E9E] truncate mt-0.5">
                                  {ch.group}
                                </p>
                              </div>
                            </div>
                            <button
                              tabIndex={-1}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleFavorite(ch.id);
                              }}
                              className="w-10 h-10 rounded-full flex items-center justify-center text-[#9E9E9E] hover:text-white hover:bg-white/10 transition-colors shrink-0"
                            >
                              <Star
                                className={`w-5 h-5 ${
                                  isFav ? 'fill-[#FFD54F] text-[#FFD54F]' : 'text-[#888888]'
                                }`}
                              />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            ) : filteredChannels.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
                <p className="text-[#B5B5B5] text-[14.5px]">
                  {channelsTab === 'FAVORITES'
                    ? 'No favorite channels yet'
                    : 'No channels found'}
                </p>
              </div>
            ) : viewLayout === 'grid' ? (
              /* EXACT DENSE BORDERLESS CHANNEL GRID FROM SCREENSHOT 6 */
              <div className="tv-scroll-container flex-1 overflow-y-auto w-full px-1.5 py-2.5">
                <div className="w-full grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-12 gap-x-1.5 gap-y-3.5">
                  {filteredChannels.map((ch) => (
                    <div
                      key={ch.id}
                      tabIndex={0}
                      role="button"
                      data-tv="channel"
                      data-channel-id={ch.id}
                      onFocus={(e) => {
                        focusTvElement(e.currentTarget, true);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === 'Select' || (e as any).keyCode === 23) {
                          e.preventDefault();
                          handleSelectChannel(ch);
                        }
                      }}
                      onClick={() => handleSelectChannel(ch)}
                      className="tv-focusable tv-channel-card flex flex-col items-center justify-start cursor-pointer px-1 py-1.5 rounded transition-all"
                    >
                      <ChannelTileLogo channel={ch} />
                      <span className="mt-1 text-[11.5px] leading-[1.2] text-[#C8C8C8] text-center line-clamp-2 w-full break-words font-normal">
                        {showChannelNumbers ? `${ch.number}. ` : ''}
                        {ch.name}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              /* Classic List View Option */
              <div className="tv-scroll-container flex-1 overflow-y-auto w-full divide-y divide-white/[0.07]">
                {filteredChannels.map((ch) => {
                  const isFav = favorites.includes(ch.id);
                  return (
                    <div
                      key={ch.id}
                      tabIndex={0}
                      role="button"
                      data-tv="channel"
                      data-channel-id={ch.id}
                      onFocus={(e) => {
                        focusTvElement(e.currentTarget, true);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === 'Select' || (e as any).keyCode === 23) {
                          e.preventDefault();
                          handleSelectChannel(ch);
                        }
                      }}
                      onClick={() => handleSelectChannel(ch)}
                      className="tv-focusable tv-channel-card flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.06] active:bg-white/[0.12] cursor-pointer transition-colors rounded"
                    >
                      <div className="flex items-center gap-3.5 min-w-0">
                        {showChannelNumbers && (
                          <span className="w-7 text-right text-xs font-mono text-[#9E9E9E] tabular-nums shrink-0">
                            {ch.number}
                          </span>
                        )}
                        <ChannelTileLogo channel={ch} />
                        <div className="min-w-0">
                          <h3 className="text-[15px] font-normal text-white truncate">
                            {ch.name}
                          </h3>
                          <p className="text-xs text-[#9E9E9E] truncate mt-0.5">{ch.group}</p>
                        </div>
                      </div>

                      <button
                        tabIndex={-1}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(ch.id);
                        }}
                        className="w-10 h-10 rounded-full flex items-center justify-center text-[#9E9E9E] hover:text-white hover:bg-white/10 transition-colors shrink-0"
                      >
                        <Star
                          className={`w-5 h-5 ${
                            isFav ? 'fill-[#FFD54F] text-[#FFD54F]' : 'text-[#888888]'
                          }`}
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* -------------------------------------------------------------------
            SCREEN: SETTINGS (Exact Match to 1.jpg, 2.jpg, and 3.jpg)
           ------------------------------------------------------------------- */}
        {screen === 'settings' && (
          <div className="w-full flex-1 bg-[#303030] divide-y divide-white/[0.12]">
            {/* 1. Playlists */}
            <div
              onClick={() => setScreen('playlists')}
              className="w-full px-4 py-4 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white">Playlists</p>
            </div>

            {/* 2. Video player preferences */}
            <div
              onClick={() => {
                if (useExternalPlayer) return;
                setScreen('video_player_prefs');
              }}
              className={`w-full px-4 py-4 transition-colors ${
                useExternalPlayer
                  ? 'cursor-default'
                  : 'hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer'
              }`}
            >
              <p
                className={`text-[16px] font-normal ${
                  useExternalPlayer ? 'text-[#757575]' : 'text-white'
                }`}
              >
                Video player preferences
              </p>
            </div>

            {/* 3. Use external video player */}
            <div
              onClick={() => setUseExternalPlayer((prev) => !prev)}
              className="w-full px-4 py-4 flex items-center justify-between hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white">Use external video player</p>
              <div
                className={`w-[18px] h-[18px] rounded-[2px] flex items-center justify-center shrink-0 mr-1 transition-colors ${
                  useExternalPlayer
                    ? 'bg-[#5BAAF5] border-[2px] border-[#5BAAF5]'
                    : 'border-[2px] border-[#9E9E9E] bg-transparent'
                }`}
              >
                {useExternalPlayer && (
                  <Check className="w-3.5 h-3.5 text-[#303030] stroke-[3]" />
                )}
              </div>
            </div>

            {/* 4. External video player */}
            <div
              onClick={() => {
                if (!useExternalPlayer) {
                  setUseExternalPlayer(true);
                }
                setSettingsDialog({
                  title: 'External video player',
                  options: [
                    'MX Player',
                    'BSPlayer',
                    'Daroon Player',
                    'DicePlayer',
                    'GoodPlayer',
                    'RockPlayer Lite',
                    'Vimu',
                    'VLC',
                    'VPlayer',
                    'Wondershare Player',
                    'XMTV Player',
                    'Archos Video Player',
                    'Stick it!',
                    'XPlayer',
                    'System select',
                  ],
                  value: externalPlayerName,
                  onSelect: setExternalPlayerName,
                });
              }}
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p
                className={`text-[16px] font-normal leading-snug ${
                  useExternalPlayer ? 'text-white' : 'text-[#757575]'
                }`}
              >
                External video player
              </p>
              <p
                className={`text-[13.5px] font-normal leading-snug mt-0.5 ${
                  useExternalPlayer ? 'text-[#B5B5B5]' : 'text-[#686868]'
                }`}
              >
                {externalPlayerName}
              </p>
            </div>

            {/* 5. EPG sources */}
            <div
              onClick={() => {
                setScreen('epg_sources');
                setModalMode('epg_add_menu');
              }}
              className="w-full px-4 py-4 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white">EPG sources</p>
            </div>

            {/* 6. EPG time shift */}
            <div
              onClick={() => showToast('EPG time shift: 0 hours')}
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">EPG time shift</p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                Global time shift applied to all EPG data (in hours)
              </p>
            </div>

            {/* 7. Channel icons */}
            <div
              onClick={() => showToast('Channel icons enabled')}
              className="w-full px-4 py-4 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white">Channel icons</p>
            </div>

            {/* 8. UDP proxy settings */}
            <div
              onClick={() => setScreen('proxy_settings')}
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                UDP proxy settings
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                Used for multicast streams only
              </p>
            </div>

            {/* 9. Start page */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'Start page',
                  options: ['All Channels', 'Favorites', 'Categories', 'Playlists'],
                  value: startPage,
                  onSelect: setStartPage,
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">Start page</p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                {startPage}
              </p>
            </div>

            {/* 10. Categories view mode */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'Categories view mode',
                  options: ['List', 'Tabs'],
                  value: categoriesViewMode,
                  onSelect: setCategoriesViewMode,
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                Categories view mode
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                {categoriesViewMode}
              </p>
            </div>

            {/* 11. Recent channels */}
            <div
              onClick={() => setShowRecentChannels((prev) => !prev)}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <div className="pr-4">
                <p className="text-[16px] font-normal text-white leading-snug">Recent channels</p>
                <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                  Show recent channels
                </p>
              </div>
              <div
                className={`w-[18px] h-[18px] rounded-[2px] flex items-center justify-center shrink-0 mr-1 transition-colors ${
                  showRecentChannels
                    ? 'bg-[#5BAAF5] border-[2px] border-[#5BAAF5]'
                    : 'border-[2px] border-[#9E9E9E] bg-transparent'
                }`}
              >
                {showRecentChannels && (
                  <Check className="w-3.5 h-3.5 text-[#303030] stroke-[3]" />
                )}
              </div>
            </div>

            {/* 12. Fast scroll */}
            <div
              onClick={() => setFastScroll((prev) => !prev)}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <div className="pr-4">
                <p className="text-[16px] font-normal text-white leading-snug">Fast scroll</p>
                <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                  Enable fast scrolling for channel list
                </p>
              </div>
              <div
                className={`w-[18px] h-[18px] rounded-[2px] flex items-center justify-center shrink-0 mr-1 transition-colors ${
                  fastScroll
                    ? 'bg-[#5BAAF5] border-[2px] border-[#5BAAF5]'
                    : 'border-[2px] border-[#9E9E9E] bg-transparent'
                }`}
              >
                {fastScroll && (
                  <Check className="w-3.5 h-3.5 text-[#303030] stroke-[3]" />
                )}
              </div>
            </div>

            {/* 13. Optimize UI for TV */}
            <div
              onClick={() => setOptimizeUiForTv((prev) => !prev)}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <div className="pr-4">
                <p className="text-[16px] font-normal text-white leading-snug">
                  Optimize UI for TV
                </p>
                <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                  It&apos;s recommended to enable this option for TV devices and disable for phones and tablets
                </p>
              </div>
              <div
                className={`w-[18px] h-[18px] rounded-[2px] flex items-center justify-center shrink-0 mr-1 transition-colors ${
                  optimizeUiForTv
                    ? 'bg-[#5BAAF5] border-[2px] border-[#5BAAF5]'
                    : 'border-[2px] border-[#9E9E9E] bg-transparent'
                }`}
              >
                {optimizeUiForTv && (
                  <Check className="w-3.5 h-3.5 text-[#303030] stroke-[3]" />
                )}
              </div>
            </div>

            {/* 14. Show channel numbers */}
            <div
              onClick={() => setShowChannelNumbers((prev) => !prev)}
              className="w-full px-4 py-4 flex items-center justify-between hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white">Show channel numbers</p>
              <div
                className={`w-[18px] h-[18px] rounded-[2px] flex items-center justify-center shrink-0 mr-1 transition-colors ${
                  showChannelNumbers
                    ? 'bg-[#5BAAF5] border-[2px] border-[#5BAAF5]'
                    : 'border-[2px] border-[#9E9E9E] bg-transparent'
                }`}
              >
                {showChannelNumbers && (
                  <Check className="w-3.5 h-3.5 text-[#303030] stroke-[3]" />
                )}
              </div>
            </div>

            {/* 15. Check Wi-Fi network state */}
            <div
              onClick={() => setCheckWifiState((prev) => !prev)}
              className="w-full px-4 py-4 flex items-center justify-between hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white">Check Wi-Fi network state</p>
              <div
                className={`w-[18px] h-[18px] rounded-[2px] flex items-center justify-center shrink-0 mr-1 transition-colors ${
                  checkWifiState
                    ? 'bg-[#5BAAF5] border-[2px] border-[#5BAAF5]'
                    : 'border-[2px] border-[#9E9E9E] bg-transparent'
                }`}
              >
                {checkWifiState && (
                  <Check className="w-3.5 h-3.5 text-[#303030] stroke-[3]" />
                )}
              </div>
            </div>

            {/* 16. Refresh playlist when starting the app */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'Refresh playlist when starting the app',
                  options: ['Never', 'Every time', 'Once per day', 'Once per week'],
                  value: refreshPlaylistFreq,
                  onSelect: setRefreshPlaylistFreq,
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                Refresh playlist when starting the app
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                {refreshPlaylistFreq}
              </p>
            </div>

            {/* 17. Start on boot */}
            <div
              onClick={() => setStartOnBoot((prev) => !prev)}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <div className="pr-4">
                <p className="text-[16px] font-normal text-white leading-snug">Start on boot</p>
                <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                  (Available in IPTV Pro) Start app automatically on device boot
                </p>
              </div>
              <div
                className={`w-[18px] h-[18px] rounded-[2px] flex items-center justify-center shrink-0 mr-1 transition-colors ${
                  startOnBoot
                    ? 'bg-[#5BAAF5] border-[2px] border-[#5BAAF5]'
                    : 'border-[2px] border-[#9E9E9E] bg-transparent'
                }`}
              >
                {startOnBoot && (
                  <Check className="w-3.5 h-3.5 text-[#303030] stroke-[3]" />
                )}
              </div>
            </div>

            {/* 18. Auto-play last channel */}
            <div
              onClick={() => setAutoPlayLastChannel((prev) => !prev)}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <div className="pr-4">
                <p className="text-[16px] font-normal text-white leading-snug">
                  Auto-play last channel
                </p>
                <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                  (Available in IPTV Pro) Automatically start the last played channel after launching the app
                </p>
              </div>
              <div
                className={`w-[18px] h-[18px] rounded-[2px] flex items-center justify-center shrink-0 mr-1 transition-colors ${
                  autoPlayLastChannel
                    ? 'bg-[#5BAAF5] border-[2px] border-[#5BAAF5]'
                    : 'border-[2px] border-[#9E9E9E] bg-transparent'
                }`}
              >
                {autoPlayLastChannel && (
                  <Check className="w-3.5 h-3.5 text-[#303030] stroke-[3]" />
                )}
              </div>
            </div>

            {/* 19. Press BACK button twice to exit */}
            <div
              onClick={() => setPressBackTwice((prev) => !prev)}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <div className="pr-4">
                <p className="text-[16px] font-normal text-white leading-snug">
                  Press BACK button twice to exit
                </p>
                <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                  When enabled you&apos;ll need to press BACK button twice (instead of once) to exit the app
                </p>
              </div>
              <div
                className={`w-[18px] h-[18px] rounded-[2px] flex items-center justify-center shrink-0 mr-1 transition-colors ${
                  pressBackTwice
                    ? 'bg-[#5BAAF5] border-[2px] border-[#5BAAF5]'
                    : 'border-[2px] border-[#9E9E9E] bg-transparent'
                }`}
              >
                {pressBackTwice && (
                  <Check className="w-3.5 h-3.5 text-[#303030] stroke-[3]" />
                )}
              </div>
            </div>

            {/* 20. Favorite channels identification mode */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'Favorite channels identification mode',
                  options: ['By channel name', 'By channel URL'],
                  value: favIdMode,
                  onSelect: setFavIdMode,
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                Favorite channels identification mode
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                {favIdMode}
              </p>
            </div>

            {/* 21. Parental control */}
            <div
              onClick={() => setScreen('parental_control')}
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                Parental control
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                PIN code and other parental control settings
              </p>
            </div>

            {/* 22. Access control */}
            <div
              onClick={() => showToast('Access control settings')}
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">Access control</p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                Password and other access control settings
              </p>
            </div>

            {/* 23. Enable cast transcoding */}
            <div
              onClick={() => setEnableCastTranscoding((prev) => !prev)}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <div className="pr-4">
                <p className="text-[16px] font-normal text-white leading-snug">
                  Enable cast transcoding
                </p>
                <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                  Use this device to convert video stream when Chromecast device doesn&apos;t support original format
                </p>
              </div>
              <div
                className={`w-[18px] h-[18px] rounded-[2px] flex items-center justify-center shrink-0 mr-1 transition-colors ${
                  enableCastTranscoding
                    ? 'bg-[#5BAAF5] border-[2px] border-[#5BAAF5]'
                    : 'border-[2px] border-[#9E9E9E] bg-transparent'
                }`}
              >
                {enableCastTranscoding && (
                  <Check className="w-3.5 h-3.5 text-[#303030] stroke-[3]" />
                )}
              </div>
            </div>

            {/* 24. Language */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'Language',
                  options: ['System default', 'English', 'Hindi', 'Spanish', 'Russian'],
                  value: appLanguage,
                  onSelect: setAppLanguage,
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">Language</p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                {appLanguage}
              </p>
            </div>

            {/* 25. Theme */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'Theme',
                  options: ['Dark', 'Black (AMOLED)', 'Light'],
                  value: appTheme,
                  onSelect: setAppTheme,
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">Theme</p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                {appTheme}
              </p>
            </div>

            {/* 26. Font size */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'Font size',
                  options: ['Small', 'Normal', 'Large', 'Extra large'],
                  value: appFontSize,
                  onSelect: setAppFontSize,
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">Font size</p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                {appFontSize}
              </p>
            </div>

            {/* 27. Export configuration */}
            <div
              onClick={() => {
                const dataStr =
                  'data:text/json;charset=utf-8,' +
                  encodeURIComponent(JSON.stringify({ playlists, favorites }, null, 2));
                const a = document.createElement('a');
                a.href = dataStr;
                a.download = 'iptv_backup.json';
                a.click();
                showToast('Configuration exported');
              }}
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                Export configuration
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                Export playlists, EPG sources and UDP proxies
              </p>
            </div>

            {/* 28. Import configuration */}
            <div className="relative w-full">
              <div
                className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
              >
                <p className="text-[16px] font-normal text-white leading-snug">
                  Import configuration
                </p>
                <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                  Import playlists, EPG sources and UDP proxies
                </p>
              </div>
              <input
                type="file"
                accept="*/*"
                aria-label="Import configuration"
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-30"
                onClick={(e) => {
                  e.stopPropagation();
                  (e.target as HTMLInputElement).value = '';
                }}
                onChange={(e) => {
                  handleFileChange(e);
                }}
              />
            </div>

            {/* 29. Ad preferences */}
            <div
              onClick={() => showToast('Personalized ads disabled')}
              className="w-full px-4 py-4 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white">Ad preferences</p>
            </div>
          </div>
        )}

        {/* -------------------------------------------------------------------
            SCREEN: VIDEO PLAYER PREFERENCES (Exact Match to 1.jpg & 2.jpg)
           ------------------------------------------------------------------- */}
        {screen === 'video_player_prefs' && (
          <div className="w-full flex-1 bg-[#303030] divide-y divide-white/[0.12]">
            {/* 1. Screen orientation */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'Screen orientation',
                  options: ['Auto', 'Landscape', 'Portrait', 'Sensor landscape'],
                  value: vpScreenOrientation,
                  onSelect: setVpScreenOrientation,
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                Screen orientation
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                {vpScreenOrientation}
              </p>
            </div>

            {/* 2. Background play / PiP mode */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'Background play / PiP mode',
                  options: ['Disabled', 'Background audio', 'Picture-in-Picture (PiP)'],
                  value: 'Picture-in-Picture (PiP)',
                  onSelect: () => {},
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                Background play / PiP mode
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                Continue playback while using other apps or when your screen is off
              </p>
            </div>

            {/* 3. Default acceleration mode */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'Default acceleration mode',
                  options: [
                    'Hardware acceleration',
                    'Hardware acceleration (HW+)',
                    'Software acceleration',
                  ],
                  value: vpAccelMode,
                  onSelect: setVpAccelMode,
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                Default acceleration mode
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                {vpAccelMode}
              </p>
            </div>

            {/* 4. Default aspect ratio */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'Default aspect ratio',
                  options: [
                    'Best Fit',
                    'Fit Horizontal',
                    'Fit Vertical',
                    'Fill',
                    '16:9',
                    '4:3',
                    'Center',
                  ],
                  value: vpAspectRatio,
                  onSelect: setVpAspectRatio,
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                Default aspect ratio
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                {vpAspectRatio}
              </p>
            </div>

            {/* 5. Preferred audio track language */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'Preferred audio track language',
                  options: [
                    'System default',
                    'English',
                    'Hindi',
                    'Punjabi',
                    'Tamil',
                    'Telugu',
                    'Russian',
                    'Spanish',
                  ],
                  value: vpAudioLang,
                  onSelect: setVpAudioLang,
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                Preferred audio track language
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                {vpAudioLang}
              </p>
            </div>

            {/* 6. Preferred subtitle track language */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'Preferred subtitle track language',
                  options: ['Disabled', 'System default', 'English', 'Hindi', 'Spanish'],
                  value: vpSubtitleLang,
                  onSelect: setVpSubtitleLang,
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                Preferred subtitle track language
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                {vpSubtitleLang}
              </p>
            </div>

            {/* 7. Switch channels by D-pad buttons */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'Switch channels by D-pad buttons',
                  options: [
                    'Disabled',
                    'UP - next channel, DOWN - previous channel',
                    'UP - previous channel, DOWN - next channel',
                  ],
                  value: vpDpadSwitch,
                  onSelect: setVpDpadSwitch,
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                Switch channels by D-pad buttons
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                {vpDpadSwitch}
              </p>
            </div>

            {/* 8. Interface auto hide (in seconds) */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'Interface auto hide (in seconds)',
                  options: ['3', '5', '10', '15', 'Never'],
                  value: '5',
                  onSelect: () => {},
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                Interface auto hide (in seconds)
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                Hide UI controls after the specified amount of time
              </p>
            </div>

            {/* 9. Auto hide channels list */}
            <div
              onClick={() => setVpAutoHideList((prev) => !prev)}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <div className="pr-4">
                <p className="text-[16px] font-normal text-white leading-snug">
                  Auto hide channels list
                </p>
                <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                  Hide channels list after switching the channel
                </p>
              </div>
              <div
                className={`w-[18px] h-[18px] rounded-[2px] flex items-center justify-center shrink-0 mr-1 transition-colors ${
                  vpAutoHideList
                    ? 'bg-[#5BAAF5] border-[2px] border-[#5BAAF5]'
                    : 'border-[2px] border-[#9E9E9E] bg-transparent'
                }`}
              >
                {vpAutoHideList && (
                  <Check className="w-3.5 h-3.5 text-[#303030] stroke-[3]" />
                )}
              </div>
            </div>

            {/* 10. Show clock */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'Show clock',
                  options: ['Never', 'When UI controls are visible', 'Always'],
                  value: vpShowClock,
                  onSelect: setVpShowClock,
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">Show clock</p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                {vpShowClock}
              </p>
            </div>

            {/* 11. Auto play the next track */}
            <div
              onClick={() => setVpAutoPlayNext((prev) => !prev)}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <div className="pr-4">
                <p className="text-[16px] font-normal text-white leading-snug">
                  Auto play the next track
                </p>
                <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                  The next track will start playing when the current track ends
                </p>
              </div>
              <div
                className={`w-[18px] h-[18px] rounded-[2px] flex items-center justify-center shrink-0 mr-1 transition-colors ${
                  vpAutoPlayNext
                    ? 'bg-[#5BAAF5] border-[2px] border-[#5BAAF5]'
                    : 'border-[2px] border-[#9E9E9E] bg-transparent'
                }`}
              >
                {vpAutoPlayNext && (
                  <Check className="w-3.5 h-3.5 text-[#303030] stroke-[3]" />
                )}
              </div>
            </div>

            {/* 12. Restore connection on errors */}
            <div
              onClick={() => setVpRestoreConn((prev) => !prev)}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <div className="pr-4">
                <p className="text-[16px] font-normal text-white leading-snug">
                  Restore connection on errors
                </p>
                <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                  Auto-reconnect to streaming server when connection is closed unexpectedly
                </p>
              </div>
              <div
                className={`w-[18px] h-[18px] rounded-[2px] flex items-center justify-center shrink-0 mr-1 transition-colors ${
                  vpRestoreConn
                    ? 'bg-[#5BAAF5] border-[2px] border-[#5BAAF5]'
                    : 'border-[2px] border-[#9E9E9E] bg-transparent'
                }`}
              >
                {vpRestoreConn && (
                  <Check className="w-3.5 h-3.5 text-[#303030] stroke-[3]" />
                )}
              </div>
            </div>

            {/* 13. HTTP User Agent */}
            <div
              onClick={() => {
                setVpHttpUserAgentDraft(vpHttpUserAgent);
                setHttpUserAgentModalOpen(true);
              }}
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                HTTP User Agent
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                {vpHttpUserAgent.trim() || 'Set custom HTTP User Agent for video streams'}
              </p>
            </div>

            {/* 14. Network buffer size */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'Network buffer size',
                  options: ['Default', '500 ms', '1000 ms', '2000 ms', '5000 ms'],
                  value: 'Default',
                  onSelect: () => {},
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                Network buffer size
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                Buffer size (in ms) for receiving video streams
              </p>
            </div>

            {/* 15. Volume control by gestures */}
            <div
              onClick={() => setVpVolumeGestures((prev) => !prev)}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <div className="pr-4">
                <p className="text-[16px] font-normal text-white leading-snug">
                  Volume control by gestures
                </p>
                <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                  Swipe up/down on the right part of the screen to change volume
                </p>
              </div>
              <div
                className={`w-[18px] h-[18px] rounded-[2px] flex items-center justify-center shrink-0 mr-1 transition-colors ${
                  vpVolumeGestures
                    ? 'bg-[#5BAAF5] border-[2px] border-[#5BAAF5]'
                    : 'border-[2px] border-[#9E9E9E] bg-transparent'
                }`}
              >
                {vpVolumeGestures && (
                  <Check className="w-3.5 h-3.5 text-[#303030] stroke-[3]" />
                )}
              </div>
            </div>

            {/* 16. Brightness control by gestures */}
            <div
              onClick={() => setVpBrightnessGestures((prev) => !prev)}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <div className="pr-4">
                <p className="text-[16px] font-normal text-white leading-snug">
                  Brightness control by gestures
                </p>
                <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                  Swipe up/down on the left part of the screen to change brightness
                </p>
              </div>
              <div
                className={`w-[18px] h-[18px] rounded-[2px] flex items-center justify-center shrink-0 mr-1 transition-colors ${
                  vpBrightnessGestures
                    ? 'bg-[#5BAAF5] border-[2px] border-[#5BAAF5]'
                    : 'border-[2px] border-[#9E9E9E] bg-transparent'
                }`}
              >
                {vpBrightnessGestures && (
                  <Check className="w-3.5 h-3.5 text-[#303030] stroke-[3]" />
                )}
              </div>
            </div>

            {/* Stalker Portal & MAC Authentication Configuration Section */}
            <div className="w-full px-4 pt-4 pb-2 bg-[#252525] border-t border-b border-white/[0.08] flex items-center justify-between">
              <span className="text-[12.5px] font-semibold text-[#5BAAF5] tracking-wide uppercase">
                Stalker Portal & MAC Authentication (स्टॉकर पोर्टल और MAC)
              </span>
              <span className="text-[11px] font-mono text-[#9E9E9E]">STB EMULATION</span>
            </div>

            {/* Default Stalker MAC Address */}
            <div
              onClick={() => {
                setMacDraft(defaultMacAddress);
                setMacSettingsModalOpen(true);
              }}
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                Default Stalker MAC Address
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                {defaultMacAddress ? defaultMacAddress : 'Not configured (e.g. 00:1A:79:XX:XX:XX)'}
              </p>
            </div>

            {/* Default Portal Token / Auth Key */}
            <div
              onClick={() => {
                setTokenDraft(defaultPortalToken);
                setTokenSettingsModalOpen(true);
              }}
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                Default Portal Token / Auth Key
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5 truncate max-w-[85vw]">
                {defaultPortalToken
                  ? defaultPortalToken.length > 30
                    ? `${defaultPortalToken.slice(0, 28)}...`
                    : defaultPortalToken
                  : 'Not configured - used for token-protected streams and portals'}
              </p>
            </div>

            {/* STB Device Emulation */}
            <div
              onClick={() =>
                setSettingsDialog({
                  title: 'STB Emulation Device',
                  options: [
                    'MAG 250 / 254 (Infomir Ministra)',
                    'MAG 322 (Ministra STB)',
                    'MAG 420 (Linux 4.9 STB)',
                    'VLC Player (LibVLC 3.0)',
                    'Standard Chrome / WebPlayer',
                  ],
                  value: stbEmulationModel,
                  onSelect: (val) => {
                    setStbEmulationModel(val);
                    try {
                      localStorage.setItem('iptv_stb_emulation_model', val);
                      setDefaultStalkerAuthSettings({ stbModel: val });
                    } catch {
                      // ignore
                    }
                  },
                })
              }
              className="w-full px-4 py-3.5 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white leading-snug">
                STB Emulation Device
              </p>
              <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                {stbEmulationModel}
              </p>
            </div>
          </div>
        )}

        {/* -------------------------------------------------------------------
            SCREEN: EPG SOURCES (Exact Match to Screenshot_20261009-211716_IPTV.jpg)
           ------------------------------------------------------------------- */}
        {screen === 'epg_sources' && (
          <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
            <button
              type="button"
              onClick={() => setModalMode('epg_add_menu')}
              className="flex items-center gap-2.5 px-4 py-2.5 rounded hover:bg-white/5 active:bg-white/10 transition-colors cursor-pointer"
            >
              <Plus className="w-6 h-6 text-[#9E9E9E] stroke-[1.75]" />
              <span className="text-white text-[14.5px] font-normal tracking-[0.01em]">
                New EPG source
              </span>
            </button>
          </div>
        )}

        {/* -------------------------------------------------------------------
            SCREEN: PROXY SETTINGS (Exact Match + GitHub Pages & Cloudflare Worker Support)
           ------------------------------------------------------------------- */}
        {screen === 'proxy_settings' && (
          <div className="flex-1 flex flex-col items-stretch justify-start overflow-y-auto px-4 py-5 max-w-[800px] mx-auto w-full">
            {/* GitHub Pages / Static Deployment Mode Card */}
            <div className="bg-[#262626] border border-white/10 rounded-[6px] p-4 mb-6 shadow-md text-left">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-[15.5px] font-semibold text-white">
                    GitHub Pages / Static Web Deployment
                  </span>
                  <span
                    className={`text-[11px] font-mono px-2 py-0.5 rounded-full ${
                      isStaticHostEnvironment()
                        ? 'bg-[#4CAF50]/20 text-[#81C784] border border-[#4CAF50]/30'
                        : 'bg-[#5BAAF5]/20 text-[#90CAF9] border border-[#5BAAF5]/30'
                    }`}
                  >
                    {isStaticHostEnvironment() ? '● GitHub Pages Active' : '● Node.js Server'}
                  </span>
                </div>
              </div>

              <p className="text-[13px] text-[#B5B5B5] leading-relaxed mb-3">
                GitHub Pages पर केवल स्टैटिक फाइल्स (HTML/JS) होस्ट होती हैं। ब्राउज़र सुरक्षा (CORS और Mixed Content) के कारण HTTP IPTV लिंक्स को प्ले करने के लिए बिल्ट-इन स्मार्ट HLS प्रॉक्सी ऑटोमैटिकली एक्टिवेट हो जाता है। अत्यधिक स्पीड और 100% अपटाइम के लिए आप नीचे अपना फ्री Cloudflare Worker URL भी दर्ज कर सकते हैं।
              </p>

              <div className="space-y-3">
                <div>
                  <label className="block text-[12px] font-medium text-[#B0B0B0] mb-1">
                    Cloudflare Worker / Custom Proxy URL (वैकल्पिक)
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="url"
                      value={customBackendUrl}
                      onChange={(e) => setCustomBackendUrl(e.target.value)}
                      placeholder="https://my-iptv-proxy.your-name.workers.dev"
                      className="flex-1 bg-[#1a1a1a] border border-white/20 rounded px-3 py-2 text-[14px] text-white focus:outline-none focus:border-[#5BAAF5] font-mono"
                    />
                    <button
                      type="button"
                      disabled={testingProxy}
                      onClick={async () => {
                        const clean = customBackendUrl.trim().replace(/\/+$/, '');
                        if (!clean) {
                          localStorage.removeItem('iptv_backend_proxy_url');
                          setCustomBackendUrl('');
                          showToast('Cleared custom proxy URL (using built-in smart bridges)');
                          return;
                        }
                        if (!/^https?:\/\//i.test(clean)) {
                          showToast('URL must start with https:// or http://');
                          return;
                        }
                        setTestingProxy(true);
                        showToast('Testing proxy connection...');
                        try {
                          const ctrl = new AbortController();
                          const t = setTimeout(() => ctrl.abort(), 3500);
                          const probeRes = await fetch(`${clean}/api/probe`, {
                            signal: ctrl.signal,
                          }).catch(() => null);
                          clearTimeout(t);
                          if (probeRes && probeRes.ok) {
                            localStorage.setItem('iptv_backend_proxy_url', clean);
                            showToast('✓ Proxy connected successfully!');
                          } else {
                            localStorage.setItem('iptv_backend_proxy_url', clean);
                            showToast('Proxy URL saved! (Probe responded without JSON)');
                          }
                        } catch {
                          localStorage.setItem('iptv_backend_proxy_url', clean);
                          showToast('Proxy URL saved!');
                        } finally {
                          setTestingProxy(false);
                        }
                      }}
                      className="px-4 py-2 bg-[#5BAAF5] hover:bg-[#4a97dd] active:bg-[#3583cb] text-[#212121] text-[13px] font-semibold rounded uppercase tracking-wide transition-colors cursor-pointer shrink-0 disabled:opacity-50"
                    >
                      {testingProxy ? 'Testing...' : 'Save & Test'}
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setGithubGuideModalOpen(true)}
                    className="text-[12.5px] font-medium text-[#5BAAF5] hover:underline flex items-center gap-1 cursor-pointer"
                  >
                    <span>📖 1-Click Free Cloudflare Worker Setup Guide (गिटहब गाइड)</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Standard LAN UDP Proxy Section */}
            <div className="text-center pt-2">
              <p className="text-[#B5B5B5] text-[14.5px] font-normal leading-[1.45] max-w-[96%] mx-auto">
                Many Android devices can&apos;t receive UDP multicast streams, it&apos;s recommended to use UDP proxy in order to watch such streams. Even if your device supports multicast, you can get more stable and clear picture with UDP proxy. Please install proxy somewhere in your LAN and provide it&apos;s connection parameters here.
              </p>

              {useUdpProxy && (
                <button
                  type="button"
                  onClick={() => {
                    setUdpProxyName('');
                    setUdpProxyHost('');
                    setUdpProxyPort('');
                    setUdpProxyNameFocused(true);
                    setUdpProxyTypeDropdownOpen(false);
                    setUdpProxyModalOpen(true);
                  }}
                  className="mt-5 mx-auto flex items-center gap-2.5 px-4 py-2.5 rounded hover:bg-white/5 active:bg-white/10 transition-colors cursor-pointer"
                >
                  <Plus className="w-6 h-6 text-[#9E9E9E] stroke-[1.75]" />
                  <span className="text-white text-[14.5px] font-normal tracking-[0.01em]">
                    New UDP proxy
                  </span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* -------------------------------------------------------------------
            SCREEN: PARENTAL CONTROL (Exact Match to Screenshot_20261009-214225_IPTV.jpg)
           ------------------------------------------------------------------- */}
        {screen === 'parental_control' && (
          <div className="w-full flex-1 bg-[#303030] flex flex-col">
            {/* 1. Set PIN code */}
            <div
              onClick={() => showToast('Set PIN code')}
              className="w-full px-4 py-4 border-b border-white/[0.12] hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white">Set PIN code</p>
            </div>

            {/* 2. Hide locked channels */}
            <div
              onClick={() => setParentalHideLocked((prev) => !prev)}
              className="w-full px-4 py-3.5 border-b border-white/[0.12] flex items-center justify-between hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <div className="pr-4">
                <p className="text-[16px] font-normal text-white leading-snug">
                  Hide locked channels
                </p>
                <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                  Don&apos;t show locked channels when parental control enabled
                </p>
              </div>
              <div
                className={`w-[18px] h-[18px] rounded-[2px] flex items-center justify-center shrink-0 mr-1 transition-colors ${
                  parentalHideLocked
                    ? 'bg-[#5BAAF5] border-[2px] border-[#5BAAF5]'
                    : 'border-[2px] border-[#9E9E9E] bg-transparent'
                }`}
              >
                {parentalHideLocked && (
                  <Check className="w-3.5 h-3.5 text-[#303030] stroke-[3]" />
                )}
              </div>
            </div>

            {/* 3. Autolock */}
            <div
              onClick={() => setParentalAutolock((prev) => !prev)}
              className="w-full px-4 py-3.5 border-b border-white/[0.12] flex items-center justify-between hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <div className="pr-4">
                <p className="text-[16px] font-normal text-white leading-snug">Autolock</p>
                <p className="text-[13.5px] font-normal text-[#B5B5B5] leading-snug mt-0.5">
                  Automatically enable parental control on exit from the app
                </p>
              </div>
              <div
                className={`w-[18px] h-[18px] rounded-[2px] flex items-center justify-center shrink-0 mr-1 transition-colors ${
                  parentalAutolock
                    ? 'bg-[#5BAAF5] border-[2px] border-[#5BAAF5]'
                    : 'border-[2px] border-[#9E9E9E] bg-transparent'
                }`}
              >
                {parentalAutolock && (
                  <Check className="w-3.5 h-3.5 text-[#303030] stroke-[3]" />
                )}
              </div>
            </div>

            {/* 4. Locked categories */}
            <div
              onClick={() => showToast('Locked categories')}
              className="w-full px-4 py-4 hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors"
            >
              <p className="text-[16px] font-normal text-white">Locked categories</p>
            </div>
          </div>
        )}

        {/* -------------------------------------------------------------------
            SCREEN: FILE PICKER — Clean Device File Picker (No fake folders)
           ------------------------------------------------------------------- */}
        {screen === 'file_picker' && (
          <div className="w-full flex-1 bg-[#282828] flex flex-col p-4 relative overflow-y-auto">
            <div className="max-w-md mx-auto w-full bg-[#383838] rounded-lg p-6 shadow-md border border-white/10 text-center flex flex-col items-center gap-4 mt-8">
              <div className="w-14 h-14 rounded-full bg-[#5BAAF5]/20 flex items-center justify-center">
                <Folder className="w-7 h-7 text-[#5BAAF5]" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Device File Manager</h3>
                <p className="text-sm text-[#B5B5B5] mt-1">
                  Select your IPTV playlist file (.m3u, .m3u8, .txt, .html) from your phone
                </p>
              </div>
              <button
                type="button"
                onClick={triggerMobileStoragePicker}
                className="w-full py-3 px-4 bg-[#215387] hover:bg-[#1a4470] active:bg-[#14365a] text-white rounded font-medium transition-colors cursor-pointer flex items-center justify-center gap-2"
              >
                <Folder className="w-5 h-5 text-white" />
                <span>Open Mobile File Manager</span>
              </button>
              <button
                type="button"
                onClick={() => setScreen(prevScreenBeforeFilePicker || 'playlists')}
                className="text-sm text-[#B5B5B5] hover:text-white transition-colors cursor-pointer"
              >
                Back to Playlists
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Exact Android Runtime Storage Permission Modal from Screenshot_20261012-180016_Package installer.jpg */}
      {showStoragePermissionModal && (
        <div
          onClick={() => setShowStoragePermissionModal(false)}
          className="fixed inset-0 z-50 bg-black/55 flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[490px] max-w-[92vw] bg-white text-[#212121] rounded-[2px] shadow-[0_11px_15px_-7px_rgba(0,0,0,0.25),0_24px_38px_3px_rgba(0,0,0,0.18),0_9px_46px_8px_rgba(0,0,0,0.14)] px-6 pt-6 pb-3.5"
          >
            <div className="flex items-start gap-4">
              {/* Teal Material Folder Icon (#009688) */}
              <svg
                viewBox="0 0 24 24"
                className="w-7 h-7 fill-[#009688] shrink-0 mt-0.5"
                aria-hidden="true"
              >
                <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
              </svg>
              <p className="text-[16.5px] leading-[1.45] text-[#212121] font-normal">
                Allow <span className="font-bold">IPTV</span> to access photos, media, and
                files on your device?
              </p>
            </div>

            <div className="mt-6 flex items-center justify-end gap-3 pr-1">
              <button
                type="button"
                onClick={() => {
                  setShowStoragePermissionModal(false);
                  showToast('Storage access was denied');
                }}
                className="px-3 py-1.5 text-[14px] font-medium text-[#009688] hover:bg-black/5 active:bg-black/10 rounded uppercase tracking-wider transition-colors cursor-pointer"
              >
                DENY
              </button>
              <button
                type="button"
                onClick={handleAllowStorage}
                className="px-4 py-1.5 text-[14px] font-bold text-[#009688] hover:bg-[#009688]/10 active:bg-[#009688]/20 rounded uppercase tracking-wider transition-colors cursor-pointer select-none"
              >
                ALLOW
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          LEFT MATERIAL NAVIGATION DRAWER — Exact Match to Screenshot 11
         ===================================================================== */}
      {drawerOpen && (
        <div
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-40 bg-black/55 flex"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[280px] sm:w-[320px] max-w-[82vw] bg-[#303030] h-full shadow-[4px_0_16px_rgba(0,0,0,0.6)] flex flex-col"
          >
            {/* Top Header Box (#607D8B Material Blue-Grey) */}
            <div
              tabIndex={0}
              data-tv="drawer-item"
              onClick={() => {
                setDrawerOpen(false);
                setScreen('playlists');
              }}
              className="tv-focusable h-[148px] bg-[#607D8B] px-4 pb-3.5 flex flex-col justify-end cursor-pointer hover:bg-[#587482] transition-colors shrink-0"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[14.5px] font-medium text-white truncate leading-snug">
                    {activePlaylist ? activePlaylist.name : 'Playlists'}
                  </p>
                  <p className="text-[13.5px] font-normal text-white/80 truncate leading-snug mt-0.5">
                    {activePlaylist
                      ? activePlaylist.sourceUrl
                        ? activePlaylist.sourceUrl
                        : `/storage/emulated/0/Download/${activePlaylist.name}`
                      : 'Tap to manage playlists'}
                  </p>
                </div>
                <span className="text-white text-[10px] shrink-0 mr-1">▼</span>
              </div>
            </div>

            {/* Drawer Menu Items */}
            <nav className="py-2 flex-1 overflow-y-auto select-none">
              {/* Playlists item */}
              <button
                type="button"
                data-tv="drawer-item"
                tabIndex={0}
                onClick={() => {
                  setDrawerOpen(false);
                  setScreen('playlists');
                }}
                className="tv-focusable w-full flex items-center gap-7 px-4 py-3.5 text-left hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="w-[22px] h-[22px] fill-[#CCCCCC] shrink-0"
                  aria-hidden="true"
                >
                  <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" />
                </svg>
                <span className="text-[14.5px] font-medium text-white">
                  Playlists
                </span>
              </button>

              {/* 1. Parental control (with toggle switch on the right) */}
              <div
                tabIndex={0}
                role="button"
                data-tv="drawer-item"
                onClick={() => setParentalControl((prev) => !prev)}
                className="tv-focusable w-full flex items-center justify-between px-4 py-3.5 hover:bg-white/[0.06] active:bg-white/[0.1] cursor-pointer transition-colors"
              >
                <div className="flex items-center gap-7">
                  {/* Material People / Two-Users Filled Icon */}
                  <svg
                    viewBox="0 0 24 24"
                    className="w-[22px] h-[22px] fill-[#CCCCCC] shrink-0"
                    aria-hidden="true"
                  >
                    <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
                  </svg>
                  <span className="text-[14.5px] font-medium text-white">
                    Parental control
                  </span>
                </div>

                {/* Material Switch */}
                <div className="relative w-9 h-3.5 flex items-center mr-1">
                  <div
                    className={`w-8 h-3.5 rounded-full transition-colors ${
                      parentalControl ? 'bg-[#3C658C]' : 'bg-[#6E6E6E]'
                    }`}
                  />
                  <div
                    className={`absolute w-5 h-5 rounded-full shadow-md transition-transform duration-150 ${
                      parentalControl
                        ? 'translate-x-4 bg-[#5BAAF5]'
                        : '-translate-x-0.5 bg-[#BDBDBD]'
                    }`}
                  />
                </div>
              </div>

              {/* 2. Device info item (displays active device name and does not open file uploader) */}
              <button
                type="button"
                data-tv="drawer-item"
                tabIndex={0}
                onClick={() => {
                  setDeviceInfoModalOpen(true);
                  showToast(`Running on: ${detectedDeviceName}`);
                }}
                className="tv-focusable w-full flex items-center gap-7 px-4 py-3.5 text-left hover:bg-white/[0.06] active:bg-white/[0.1] focus:bg-white/[0.1] focus:outline-none cursor-pointer transition-colors"
                title={`Running on: ${detectedDeviceName}`}
              >
                {/* Material Devices / Hardware Icon */}
                <svg
                  viewBox="0 0 24 24"
                  className="w-[22px] h-[22px] fill-[#CCCCCC] shrink-0"
                  aria-hidden="true"
                >
                  <path d="M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h14v-3H4V6zm19 2h-6c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V9c0-.55-.45-1-1-1zm-1 9h-4v-7h4v7z" />
                </svg>
                <div className="flex flex-col min-w-0 pr-2">
                  <span className="text-[14.5px] font-medium text-white truncate">
                    Device {detectedDeviceName}
                  </span>
                  <span className="text-[11.5px] text-[#9E9E9E] truncate">
                    Tap to view device details
                  </span>
                </div>
              </button>

              {/* 3. Recent */}
              <button
                type="button"
                data-tv="drawer-item"
                tabIndex={0}
                onClick={() => {
                  setDrawerOpen(false);
                  setChannelsTab('ALL_CHANNELS');
                  setScreen('channels');
                }}
                className="tv-focusable w-full flex items-center gap-7 px-4 py-3.5 text-left hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
              >
                {/* Material Filled Clock Icon */}
                <svg
                  viewBox="0 0 24 24"
                  className="w-[22px] h-[22px] fill-[#CCCCCC] shrink-0"
                  aria-hidden="true"
                >
                  <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" />
                </svg>
                <span className="text-[14.5px] font-medium text-white">
                  Recent
                </span>
              </button>

              {/* 4. Recordings */}
              <button
                type="button"
                data-tv="drawer-item"
                tabIndex={0}
                onClick={() => {
                  setDrawerOpen(false);
                  showToast('No recordings found');
                }}
                className="tv-focusable w-full flex items-center gap-7 px-4 py-3.5 text-left hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
              >
                {/* Material Clapperboard Icon */}
                <svg
                  viewBox="0 0 24 24"
                  className="w-[22px] h-[22px] fill-[#CCCCCC] shrink-0"
                  aria-hidden="true"
                >
                  <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z" />
                </svg>
                <span className="text-[14.5px] font-medium text-white">
                  Recordings
                </span>
              </button>

              {/* 5. Settings */}
              <button
                type="button"
                data-tv="drawer-item"
                tabIndex={0}
                onClick={() => {
                  setPrevScreenBeforeSettings(screen);
                  setDrawerOpen(false);
                  setScreen('settings');
                }}
                className="tv-focusable w-full flex items-center gap-7 px-4 py-3.5 text-left hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
              >
                {/* Material Filled Settings Gear Icon */}
                <svg
                  viewBox="0 0 24 24"
                  className="w-[22px] h-[22px] fill-[#CCCCCC] shrink-0"
                  aria-hidden="true"
                >
                  <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
                </svg>
                <span className="text-[14.5px] font-medium text-white">
                  Settings
                </span>
              </button>

              {/* 6. About */}
              <button
                type="button"
                data-tv="drawer-item"
                tabIndex={0}
                onClick={() => {
                  setDrawerOpen(false);
                  setAboutModalOpen(true);
                }}
                className="tv-focusable w-full flex items-center gap-7 px-4 py-3.5 text-left hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
              >
                {/* Material Filled Info Circle Icon */}
                <svg
                  viewBox="0 0 24 24"
                  className="w-[22px] h-[22px] fill-[#CCCCCC] shrink-0"
                  aria-hidden="true"
                >
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
                </svg>
                <span className="text-[14.5px] font-medium text-white">
                  About
                </span>
              </button>

              {/* Horizontal Divider */}
              <div className="my-2 border-t border-white/10" />

              {/* 7. IPTV Pro */}
              <button
                type="button"
                data-tv="drawer-item"
                tabIndex={0}
                onClick={() => {
                  setDrawerOpen(false);
                  showToast('IPTV Pro features unlocked');
                }}
                className="tv-focusable w-full flex items-center gap-7 px-4 py-3.5 text-left hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
              >
                {/* Material Crown Icon */}
                <svg
                  viewBox="0 0 24 24"
                  className="w-[22px] h-[22px] fill-[#CCCCCC] shrink-0"
                  aria-hidden="true"
                >
                  <path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z" />
                </svg>
                <div className="flex items-center gap-2.5">
                  <span className="text-[14.5px] font-medium text-white">
                    IPTV Pro
                  </span>
                  <span className="text-[10.5px] font-medium tracking-widest uppercase text-white/30 border border-white/10 px-1.5 py-0.5 rounded select-none pointer-events-none">
                    Activated
                  </span>
                </div>
              </button>
            </nav>
          </div>
        </div>
      )}

      {/* Material New UDP Proxy Dialog — Exact Match to Screenshot_20261009-213540_IPTV.jpg */}
      {udpProxyModalOpen && (
        <div
          onClick={() => {
            setUdpProxyTypeDropdownOpen(false);
            setUdpProxyModalOpen(false);
          }}
          className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-4"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              setUdpProxyTypeDropdownOpen(false);
              setUdpProxyModalOpen(false);
            }}
            className="w-[540px] max-w-[90vw] bg-[#424242] rounded-[2px] shadow-[0_12px_32px_rgba(0,0,0,0.65)] px-5 pt-5 pb-4 text-white"
          >
            <h2 className="text-[18.5px] font-medium text-white pl-1.5 mb-2.5">
              New UDP proxy
            </h2>

            {/* 1. Name field with sky-blue floating label and active sky-blue bottom line */}
            <div className="w-full">
              <label
                htmlFor="udp-proxy-name-input"
                className={`block text-[12px] font-normal transition-colors ${
                  udpProxyNameFocused || udpProxyName ? 'text-[#5BAAF5]' : 'text-[#9E9E9E]'
                }`}
              >
                Name
              </label>
              <input
                id="udp-proxy-name-input"
                type="text"
                value={udpProxyName}
                onFocus={() => setUdpProxyNameFocused(true)}
                onBlur={() => setUdpProxyNameFocused(false)}
                onChange={(e) => setUdpProxyName(e.target.value)}
                autoFocus
                className={`w-full bg-transparent text-white text-[16px] pt-1 pb-1.5 outline-none caret-[#5BAAF5] transition-colors ${
                  udpProxyNameFocused
                    ? 'border-b-[2px] border-[#5BAAF5]'
                    : 'border-b border-[#8E8E8E]'
                }`}
              />
            </div>

            {/* 2. IP address or host name */}
            <div className="w-full mt-5">
              <input
                type="text"
                value={udpProxyHost}
                onChange={(e) => setUdpProxyHost(e.target.value)}
                placeholder="IP address or host name"
                className="w-full bg-transparent text-white placeholder-[#9E9E9E] text-[16px] py-1.5 border-b border-[#8E8E8E] focus:border-b-[2px] focus:border-[#5BAAF5] outline-none caret-[#5BAAF5] transition-colors"
              />
            </div>

            {/* 3. Port number */}
            <div className="w-full mt-5">
              <input
                type="text"
                inputMode="numeric"
                value={udpProxyPort}
                onChange={(e) => setUdpProxyPort(e.target.value)}
                placeholder="Port number"
                className="w-full bg-transparent text-white placeholder-[#9E9E9E] text-[16px] py-1.5 border-b border-[#8E8E8E] focus:border-b-[2px] focus:border-[#5BAAF5] outline-none caret-[#5BAAF5] transition-colors"
              />
            </div>

            {/* 4. Proxy type dropdown ("UDP-to-HTTP proxy (Windows)") */}
            <div className="w-full mt-2.5 relative">
              <button
                type="button"
                onClick={() => setUdpProxyTypeDropdownOpen((prev) => !prev)}
                className="w-full flex items-center justify-between py-2 pl-1 pr-3 text-left text-[15.5px] font-normal text-white hover:bg-white/[0.04] transition-colors"
              >
                <span>{udpProxyType}</span>
                <span className="text-[#CCCCCC] text-[10px] leading-none">▼</span>
              </button>

              {udpProxyTypeDropdownOpen && (
                <div className="absolute left-0 right-6 -top-1 z-50 bg-[#303030] rounded-[2px] shadow-[0_6px_20px_rgba(0,0,0,0.75)] py-1 border border-white/[0.04]">
                  {[
                    'UDP-to-HTTP proxy (Windows)',
                    'udpxy (Unix/Linux)',
                  ].map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => {
                        setUdpProxyType(opt);
                        setUdpProxyTypeDropdownOpen(false);
                      }}
                      className="w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Bottom-right CANCEL and OK buttons */}
            <div className="mt-5 flex items-center justify-end gap-4 pr-1">
              <button
                type="button"
                onClick={() => {
                  setUdpProxyTypeDropdownOpen(false);
                  setUdpProxyModalOpen(false);
                }}
                className="px-2.5 py-1.5 text-[13.5px] font-medium text-[#5BAAF5] hover:bg-white/10 active:bg-white/15 rounded uppercase tracking-wide transition-colors"
              >
                CANCEL
              </button>
              <button
                type="submit"
                className="px-2.5 py-1.5 text-[13.5px] font-medium text-[#5BAAF5] hover:bg-white/10 active:bg-white/15 rounded uppercase tracking-wide transition-colors"
              >
                OK
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Material New EPG Source Dialog — Exact Match to Screenshot_20261009-212456_IPTV.jpg */}
      {epgUrlModalOpen && (
        <div
          onClick={() => setEpgUrlModalOpen(false)}
          className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-4"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              setEpgUrlModalOpen(false);
            }}
            className="w-[540px] max-w-[90vw] bg-[#424242] rounded-[2px] shadow-[0_12px_32px_rgba(0,0,0,0.65)] px-5 pt-5 pb-4 text-white"
          >
            <h2 className="text-[18.5px] font-medium text-white pl-1.5 mb-2.5">
              New EPG source
            </h2>

            <p className="text-[13.5px] font-normal text-[#CCCCCC] mb-3">
              Please input a network URL for EPG source
            </p>

            <input
              type="url"
              value={epgUrlDraft}
              onChange={(e) => setEpgUrlDraft(e.target.value)}
              autoFocus
              className="w-full bg-transparent text-white text-[16px] py-1 border-b-[2px] border-[#5BAAF5] outline-none caret-[#5BAAF5]"
            />

            <div className="mt-6 flex items-center justify-end gap-4 pr-1">
              <button
                type="button"
                onClick={() => setEpgUrlModalOpen(false)}
                className="px-2.5 py-1.5 text-[13.5px] font-medium text-[#5BAAF5] hover:bg-white/10 active:bg-white/15 rounded uppercase tracking-wide transition-colors"
              >
                CANCEL
              </button>
              <button
                type="submit"
                className="px-2.5 py-1.5 text-[13.5px] font-medium text-[#5BAAF5] hover:bg-white/10 active:bg-white/15 rounded uppercase tracking-wide transition-colors"
              >
                OK
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Material HTTP User Agent Dialog — Exact Match to Screenshot_20261009-210434_IPTV.jpg */}
      {httpUserAgentModalOpen && (
        <div
          onClick={() => setHttpUserAgentModalOpen(false)}
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              setVpHttpUserAgent(vpHttpUserAgentDraft);
              setHttpUserAgentModalOpen(false);
            }}
            className="w-[540px] max-w-[90vw] bg-[#424242] rounded-[2px] shadow-[0_12px_32px_rgba(0,0,0,0.65)] px-6 pt-5 pb-4 text-white"
          >
            <h2 className="text-[18.5px] font-medium text-white mb-5">
              HTTP User Agent
            </h2>

            <input
              type="text"
              value={vpHttpUserAgentDraft}
              onChange={(e) => setVpHttpUserAgentDraft(e.target.value)}
              autoFocus
              className="w-full bg-transparent text-white text-[16px] py-1 border-b-[2px] border-[#5BAAF5] outline-none caret-[#5BAAF5]"
            />

            <div className="mt-6 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  setVpHttpUserAgent('');
                  setVpHttpUserAgentDraft('');
                  setHttpUserAgentModalOpen(false);
                }}
                className="px-2 py-1.5 text-[13.5px] font-medium text-[#5BAAF5] hover:bg-white/10 active:bg-white/15 rounded uppercase tracking-wide transition-colors"
              >
                RESET
              </button>

              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => setHttpUserAgentModalOpen(false)}
                  className="px-2.5 py-1.5 text-[13.5px] font-medium text-[#5BAAF5] hover:bg-white/10 active:bg-white/15 rounded uppercase tracking-wide transition-colors"
                >
                  CANCEL
                </button>
                <button
                  type="submit"
                  className="px-2.5 py-1.5 text-[13.5px] font-medium text-[#5BAAF5] hover:bg-white/10 active:bg-white/15 rounded uppercase tracking-wide transition-colors"
                >
                  OK
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Material Settings Radio Option Dialog — Exact Match to External video player 1.jpg & 2.jpg */}
      {settingsDialog && (
        <div
          onClick={() => setSettingsDialog(null)}
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[540px] max-w-[90vw] max-h-[86vh] flex flex-col bg-[#424242] rounded-[2px] shadow-[0_12px_32px_rgba(0,0,0,0.65)] text-white"
          >
            <h2 className="text-[19px] font-medium text-white px-6 pt-5 pb-3.5 border-b border-white/[0.08] shrink-0">
              {settingsDialog.title}
            </h2>
            <div className="overflow-y-auto flex-1 py-1.5">
              {settingsDialog.options.map((opt) => {
                const selected = opt === settingsDialog.value;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => {
                      settingsDialog.onSelect(opt);
                      setSettingsDialog(null);
                    }}
                    className="w-full flex items-center gap-5 px-6 py-3 text-left hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
                  >
                    <div
                      className={`w-[20px] h-[20px] rounded-full border-[2px] flex items-center justify-center shrink-0 ${
                        selected ? 'border-[#5BAAF5]' : 'border-[#B0B0B0]'
                      }`}
                    >
                      {selected && (
                        <div className="w-[10px] h-[10px] rounded-full bg-[#5BAAF5]" />
                      )}
                    </div>
                    <span className="text-[16px] font-normal text-white">{opt}</span>
                  </button>
                );
              })}
            </div>
            <div className="px-5 py-2.5 flex justify-end border-t border-white/[0.08] shrink-0">
              <button
                type="button"
                onClick={() => setSettingsDialog(null)}
                className="px-3 py-1.5 text-[13.5px] font-medium text-[#5BAAF5] hover:bg-white/10 active:bg-white/15 rounded uppercase tracking-wide transition-colors"
              >
                CANCEL
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Material Edit Local Playlist Dialog */}
      {editingPlaylist && (
        <div
          onClick={() => setEditingPlaylist(null)}
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              if (editNameValue.trim()) {
                setPlaylists((prev) =>
                  deduplicatePlaylists(
                    prev.map((p) =>
                      p.id === editingPlaylist.id ? { ...p, name: editNameValue.trim() } : p
                    )
                  )
                );
              }
              setEditingPlaylist(null);
            }}
            className="w-full max-w-sm bg-[#424242] rounded-[2px] shadow-2xl p-6 text-white"
          >
            <h2 className="text-lg font-medium text-white mb-4">Edit playlist</h2>
            <input
              type="text"
              value={editNameValue}
              onChange={(e) => setEditNameValue(e.target.value)}
              placeholder="Playlist name"
              autoFocus
              className="w-full bg-transparent text-white placeholder-[#9E9E9E] text-[16px] py-1.5 border-b-[2px] border-[#5B9BD5] outline-none"
            />
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingPlaylist(null)}
                className="px-4 py-2 text-sm font-medium text-[#5BAAF5] hover:bg-white/10 rounded uppercase"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-sm font-medium text-[#5BAAF5] hover:bg-white/10 rounded uppercase"
              >
                OK
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Material About Dialog */}
      {aboutModalOpen && (
        <div
          onClick={() => setAboutModalOpen(false)}
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm bg-[#424242] rounded-[2px] shadow-2xl p-6 text-white"
          >
            <h2 className="text-lg font-medium text-white mb-2">Yaaro Ka Yaar</h2>
            <p className="text-sm text-[#CCCCCC] leading-relaxed">
              Welcome to Yaaro Ka Yaar, your ultimate destination for seamless live TV streaming. Enjoy your favorite channels and stay entertained anytime, anywhere.
            </p>
            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setAboutModalOpen(false)}
                className="px-4 py-2 text-sm font-medium text-[#5BAAF5] hover:bg-white/10 rounded uppercase"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          LIVE HLS VIDEO PLAYER MODAL
         ===================================================================== */}
      {playingChannel && (
        <VideoPlayerModal
          channel={playingChannel}
          channels={filteredChannels.length > 0 ? filteredChannels : [playingChannel]}
          allChannels={activePlaylist ? activePlaylist.channels : [playingChannel]}
          isFavorite={favorites.includes(playingChannel.id)}
          onToggleFavorite={toggleFavorite}
          onSelectChannel={handleSelectChannel}
          onClose={() => setPlayingChannel(null)}
          onOpenCast={() => setCastModalOpen(true)}
          userAgent={vpHttpUserAgent.trim() || DEFAULT_PLAYER_USER_AGENT}
          defaultMacAddress={defaultMacAddress}
          defaultPortalToken={defaultPortalToken}
          stbEmulationModel={stbEmulationModel}
          onOpenSettings={() => {
            setPlayingChannel(null);
            setPrevScreenBeforeSettings('channels');
            setScreen('video_player_prefs');
          }}
        />
      )}

      {/* Material Stalker MAC Address Dialog */}
      {macSettingsModalOpen && (
        <div
          onClick={() => setMacSettingsModalOpen(false)}
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const norm = normalizeMacAddress(macDraft);
              if (norm) {
                setDefaultMacAddress(norm);
                setDefaultStalkerAuthSettings({ mac: norm });
                showToast(`Default MAC set to ${norm}`);
              } else if (!macDraft.trim()) {
                setDefaultMacAddress('');
                setDefaultStalkerAuthSettings({ mac: '' });
                showToast('Default MAC cleared');
              } else {
                showToast('Invalid MAC address format (must be 6 hex bytes)');
                return;
              }
              setMacSettingsModalOpen(false);
            }}
            className="w-[540px] max-w-[90vw] bg-[#424242] rounded-[2px] shadow-[0_12px_32px_rgba(0,0,0,0.65)] px-6 pt-5 pb-4 text-white"
          >
            <h2 className="text-[18.5px] font-medium text-white mb-2">
              Default Stalker MAC Address
            </h2>
            <p className="text-[13px] text-[#B0B0B0] mb-4">
              Enter 12-character STB MAC address (e.g. 00:1A:79:XX:XX:XX) used for Stalker portal authorization
            </p>

            <input
              type="text"
              value={macDraft}
              onChange={(e) => setMacDraft(e.target.value.toUpperCase())}
              placeholder="00:1A:79:XX:XX:XX"
              autoFocus
              className="w-full bg-transparent text-white font-mono text-[16px] py-1 border-b-[2px] border-[#5BAAF5] outline-none caret-[#5BAAF5]"
            />

            <div className="flex items-center gap-1.5 mt-3 flex-wrap">
              <span className="text-[11px] text-[#A0A0A0]">Quick Presets:</span>
              {['00:1A:79:00:00:01', '00:1A:79:A1:B2:C3', '00:1A:79:5B:C2:E4'].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setMacDraft(preset)}
                  className="text-[11px] font-mono text-[#5BAAF5] bg-white/5 hover:bg-white/10 px-2 py-0.5 rounded"
                >
                  {preset}
                </button>
              ))}
            </div>

            <div className="mt-6 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  setDefaultMacAddress('');
                  setDefaultStalkerAuthSettings({ mac: '' });
                  setMacDraft('');
                  setMacSettingsModalOpen(false);
                  showToast('MAC address reset');
                }}
                className="px-2 py-1.5 text-[13.5px] font-medium text-[#E57373] hover:bg-white/10 active:bg-white/15 rounded uppercase tracking-wide transition-colors"
              >
                RESET
              </button>

              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => setMacSettingsModalOpen(false)}
                  className="px-2.5 py-1.5 text-[13.5px] font-medium text-[#5BAAF5] hover:bg-white/10 active:bg-white/15 rounded uppercase tracking-wide transition-colors"
                >
                  CANCEL
                </button>
                <button
                  type="submit"
                  className="px-2.5 py-1.5 text-[13.5px] font-medium text-[#5BAAF5] hover:bg-white/10 active:bg-white/15 rounded uppercase tracking-wide transition-colors"
                >
                  OK
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Material Portal Token Dialog */}
      {tokenSettingsModalOpen && (
        <div
          onClick={() => setTokenSettingsModalOpen(false)}
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const cleanToken = tokenDraft.trim();
              setDefaultPortalToken(cleanToken);
              setDefaultStalkerAuthSettings({ token: cleanToken });
              showToast(cleanToken ? 'Portal token saved' : 'Portal token cleared');
              setTokenSettingsModalOpen(false);
            }}
            className="w-[540px] max-w-[90vw] bg-[#424242] rounded-[2px] shadow-[0_12px_32px_rgba(0,0,0,0.65)] px-6 pt-5 pb-4 text-white"
          >
            <h2 className="text-[18.5px] font-medium text-white mb-2">
              Default Portal Token / Auth Key
            </h2>
            <p className="text-[13px] text-[#B0B0B0] mb-4">
              Enter stream authentication token (e.g. play_token, wmsAuthSign, or portal session key)
            </p>

            <input
              type="text"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              placeholder="Paste token or authorization key here..."
              autoFocus
              className="w-full bg-transparent text-white text-[15px] py-1 border-b-[2px] border-[#5BAAF5] outline-none caret-[#5BAAF5]"
            />

            <div className="mt-6 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  setDefaultPortalToken('');
                  setDefaultStalkerAuthSettings({ token: '' });
                  setTokenDraft('');
                  setTokenSettingsModalOpen(false);
                  showToast('Portal token reset');
                }}
                className="px-2 py-1.5 text-[13.5px] font-medium text-[#E57373] hover:bg-white/10 active:bg-white/15 rounded uppercase tracking-wide transition-colors"
              >
                RESET
              </button>

              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => setTokenSettingsModalOpen(false)}
                  className="px-2.5 py-1.5 text-[13.5px] font-medium text-[#5BAAF5] hover:bg-white/10 active:bg-white/15 rounded uppercase tracking-wide transition-colors"
                >
                  CANCEL
                </button>
                <button
                  type="submit"
                  className="px-2.5 py-1.5 text-[13.5px] font-medium text-[#5BAAF5] hover:bg-white/10 active:bg-white/15 rounded uppercase tracking-wide transition-colors"
                >
                  OK
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Material Device Info Dialog */}
      {deviceInfoModalOpen && (
        <div
          onClick={() => setDeviceInfoModalOpen(false)}
          className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-4 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[480px] max-w-[90vw] bg-[#424242] rounded-[3px] shadow-[0_12px_32px_rgba(0,0,0,0.7)] p-6 text-white border border-white/10"
          >
            <div className="flex items-center gap-3 mb-4 pb-3 border-b border-white/10">
              <svg viewBox="0 0 24 24" className="w-7 h-7 fill-[#5BAAF5] shrink-0">
                <path d="M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h14v-3H4V6zm19 2h-6c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V9c0-.55-.45-1-1-1zm-1 9h-4v-7h4v7z" />
              </svg>
              <div>
                <h3 className="text-[18px] font-medium text-white leading-tight">
                  Device Information
                </h3>
                <p className="text-[12px] text-[#A0A0A0]">
                  डिटेक्ट किया गया वर्तमान डिवाइस
                </p>
              </div>
            </div>

            <div className="space-y-3 py-1 text-[14px]">
              <div className="flex items-center justify-between py-1.5 border-b border-white/5">
                <span className="text-[#B0B0B0]">Device Model:</span>
                <span className="font-semibold text-white">{detectedDeviceName}</span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-white/5">
                <span className="text-[#B0B0B0]">Platform / OS:</span>
                <span className="text-[#E0E0E0]">
                  {(navigator as any).userAgentData?.platform || navigator.platform || 'Web Standard'}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-white/5">
                <span className="text-[#B0B0B0]">Screen Resolution:</span>
                <span className="text-[#E0E0E0]">
                  {typeof window !== 'undefined' ? `${window.screen.width} × ${window.screen.height} px` : '1920 × 1080 px'}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-white/5">
                <span className="text-[#B0B0B0]">Touch Support:</span>
                <span className="text-[#E0E0E0]">
                  {typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0 ? `Yes (${navigator.maxTouchPoints} points)` : 'No (Mouse / Remote)'}
                </span>
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => setDeviceInfoModalOpen(false)}
                className="px-4 py-1.5 text-[13.5px] font-medium bg-[#5BAAF5] hover:bg-[#4a97dd] text-[#212121] rounded uppercase font-semibold transition-colors cursor-pointer"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* GitHub Pages & Cloudflare Worker Deployment Guide Modal */}
      {githubGuideModalOpen && (
        <div
          onClick={() => setGithubGuideModalOpen(false)}
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-[#262626] border border-white/15 rounded-lg max-w-lg w-full p-5 max-h-[90vh] overflow-y-auto text-left shadow-2xl text-white"
          >
            <div className="flex items-center justify-between pb-3 border-b border-white/10 mb-4">
              <h3 className="text-[17px] font-semibold text-white">
                GitHub Pages पर IPTV चलाने की गाइड
              </h3>
              <button
                type="button"
                onClick={() => setGithubGuideModalOpen(false)}
                className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-[#B0B0B0] hover:text-white transition-colors cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4 text-[13.5px] text-[#CCCCCC] leading-relaxed">
              <div className="bg-[#1f1f1f] p-3 rounded border border-white/10">
                <p className="font-semibold text-[#81C784] mb-1">
                  ✓ बिल्ट-इन स्मार्ट HLS प्रॉक्सी ऑटोमैटिकली एक्टिव है!
                </p>
                <p className="text-[12.5px] text-[#B0B0B0]">
                  आपकी ऐप में अब ऑटोमैटिक M3U8 सेगमेंट री-राइटिंग और CORS ब्रिज शामिल है। ज़्यादातर लाइव HLS चैनल्स GitHub Pages पर सीधे बिना किसी अतिरिक्त सेटअप के प्ले होंगे।
                </p>
              </div>

              <div>
                <h4 className="font-semibold text-white mb-1.5 text-[14px]">
                  100% फुल स्पीड और स्टॉकर MAC पोर्टल्स के लिए (Free Cloudflare Worker):
                </h4>
                <p className="text-[12.5px] text-[#A0A0A0] mb-2">
                  Cloudflare Workers पर हर महीने 30 लाख (100,000/दिन) रिक्वेस्ट्स 100% फ्री मिलती हैं। यह आपके सभी HTTP और पासवर्ड वाले IPTV चैनल्स को HTTPS में बदल देता है।
                </p>
                <ol className="list-decimal pl-5 space-y-1.5 text-[12.5px] text-[#E0E0E0]">
                  <li>
                    <span className="font-medium text-white">workers.cloudflare.com</span> पर फ्री अकाउंट बनाएँ या लॉगिन करें।
                  </li>
                  <li>
                    &quot;Create Application&quot; → &quot;Create Worker&quot; पर क्लिक करके &quot;Deploy&quot; दबाएँ।
                  </li>
                  <li>
                    &quot;Edit code&quot; पर क्लिक करें और नीचे दिए गए बटन से कोड कॉपी करके पेस्ट कर दें।
                  </li>
                  <li>
                    &quot;Save and deploy&quot; पर क्लिक करें और अपना वर्कर URL कॉपी करें (उदा. <code className="text-[#5BAAF5]">https://my-iptv.workers.dev</code>)।
                  </li>
                  <li>
                    ऐप में Settings → Proxy Settings में वह URL पेस्ट करके Save करें।
                  </li>
                </ol>
              </div>

              <div className="pt-2 flex flex-col sm:flex-row items-center gap-2.5">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const res = await fetch('./cloudflare-worker.js');
                      const text = await res.text();
                      await navigator.clipboard.writeText(text);
                      showToast('✓ Cloudflare Worker कोड क्लिपबोर्ड पर कॉपी हो गया!');
                    } catch {
                      showToast('प्रोजेक्ट रूट से cloudflare-worker.js कॉपी करें');
                    }
                  }}
                  className="w-full sm:w-auto px-4 py-2 bg-[#5BAAF5] hover:bg-[#4a97dd] text-[#212121] font-semibold text-[13px] rounded uppercase transition-colors cursor-pointer text-center"
                >
                  Copy Worker Code (कोड कॉपी करें)
                </button>
                <a
                  href="https://workers.cloudflare.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full sm:w-auto px-4 py-2 bg-white/10 hover:bg-white/15 text-white text-[13px] rounded uppercase transition-colors text-center font-medium"
                >
                  Open Cloudflare Workers ↗
                </a>
              </div>
            </div>

            <div className="mt-5 pt-3 border-t border-white/10 flex justify-end">
              <button
                type="button"
                onClick={() => setGithubGuideModalOpen(false)}
                className="px-4 py-1.5 bg-white/10 hover:bg-white/20 text-white rounded text-[13px] font-medium transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Google Cast Device Scanner & Remote Control Dialog */}
      <CastModal
        isOpen={castModalOpen}
        onClose={() => setCastModalOpen(false)}
        activeChannel={playingChannel}
        onSelectChannelToCast={(ch) => handleSelectChannel(ch)}
      />

      {/* Material Snackbar / Toast */}
      {toastMessage && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 bg-[#212121] text-white text-sm px-5 py-3 rounded shadow-lg border border-white/10">
          {toastMessage}
        </div>
      )}
    </div>
  );
}
