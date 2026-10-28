/**
 * Android TV D-Pad Navigation & Focus Management Utility
 * 
 * Provides:
 * 1. Normalized key detection for all Android TV remotes (D-Pad, Center, Back, Media keys, Channel +/-)
 * 2. Instant spatial navigation between Header, Tabs, Categories sidebar, Channel grid/list, Playlists, Modals, Drawer
 * 3. Zero-lag DOM focus movement without heavy React re-renders or getComputedStyle bottlenecks
 * 4. Automatic viewport alignment with zero scroll-lag
 * 5. High-visibility 10-foot TV active focus highlight management
 */

export interface RemoteKeyEvent {
  isUp: boolean;
  isDown: boolean;
  isLeft: boolean;
  isRight: boolean;
  isSelect: boolean;
  isBack: boolean;
  isChannelUp: boolean;
  isChannelDown: boolean;
  isPlayPause: boolean;
  isRewind: boolean;
  isFastForward: boolean;
  isMenu: boolean;
  isInfo: boolean;
  numberKey: number | null;
  originalEvent: KeyboardEvent;
}

/**
 * Checks if the user is currently typing in an input or textarea
 */
export function isTypingInInput(e?: KeyboardEvent): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return false;
  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (active as any).isContentEditable;
}

/**
 * Comprehensive key detection for Android TV, Smart TV remotes, TV boxes, and Air Mice
 */
export function parseRemoteKeyEvent(e: KeyboardEvent): RemoteKeyEvent {
  const code = e.keyCode || e.which || 0;
  const key = e.key || '';
  const eventCode = e.code || '';

  // D-Pad Up (Key, Event Code, or Android KEYCODE_DPAD_UP 19)
  const isUp =
    key === 'ArrowUp' ||
    key === 'Up' ||
    key === 'UIKeyInputUp' ||
    eventCode === 'ArrowUp' ||
    code === 38 ||
    code === 19;

  // D-Pad Down (Key, Event Code, or Android KEYCODE_DPAD_DOWN 20)
  const isDown =
    key === 'ArrowDown' ||
    key === 'Down' ||
    key === 'UIKeyInputDown' ||
    eventCode === 'ArrowDown' ||
    code === 40 ||
    code === 20;

  // D-Pad Left (Key, Event Code, or Android KEYCODE_DPAD_LEFT 21)
  const isLeft =
    key === 'ArrowLeft' ||
    key === 'Left' ||
    key === 'UIKeyInputLeft' ||
    eventCode === 'ArrowLeft' ||
    code === 37 ||
    code === 21;

  // D-Pad Right (Key, Event Code, or Android KEYCODE_DPAD_RIGHT 22)
  const isRight =
    key === 'ArrowRight' ||
    key === 'Right' ||
    key === 'UIKeyInputRight' ||
    eventCode === 'ArrowRight' ||
    code === 39 ||
    code === 22;

  // Select / Center / OK
  // Note: Android TV remotes send KEYCODE_DPAD_CENTER (23) or KEYCODE_ENTER (66)
  const isSelect =
    key === 'Enter' ||
    key === 'Select' ||
    key === 'Ok' ||
    key === 'OK' ||
    key === 'Accept' ||
    key === 'Spacebar' ||
    key === ' ' ||
    eventCode === 'Enter' ||
    eventCode === 'NumpadEnter' ||
    eventCode === 'Space' ||
    code === 13 ||
    code === 23 || // Android KEYCODE_DPAD_CENTER
    code === 66 || // Android KEYCODE_ENTER
    code === 160 || // Numpad Enter
    code === 108; // Android Keypad Enter

  // Back / Return / Escape
  // Note: Android TV remote Back is KEYCODE_BACK (4), KEYCODE_ESCAPE (111), Escape (27), or Backspace (8) on Air Mice
  const isBack =
    key === 'Escape' ||
    key === 'Esc' ||
    key === 'Back' ||
    key === 'BrowserBack' ||
    key === 'GoBack' ||
    key === 'AndroidBack' ||
    key === 'XF86Back' ||
    eventCode === 'Escape' ||
    eventCode === 'BrowserBack' ||
    code === 27 ||
    code === 4 || // Android KEYCODE_BACK
    code === 111 || // Android KEYCODE_ESCAPE
    code === 166 || // KEYCODE_NAVIGATE_PREVIOUS
    code === 10009 || // Samsung Tizen Back
    code === 461 || // LG webOS Back
    (!isTypingInInput(e) && (key === 'Backspace' || eventCode === 'Backspace' || code === 8));

  // Channel Up / Down
  const isChannelUp =
    key === 'ChannelUp' ||
    key === 'PageUp' ||
    eventCode === 'PageUp' ||
    code === 33 ||
    code === 427 || // Android KEYCODE_CHANNEL_UP
    code === 166;

  const isChannelDown =
    key === 'ChannelDown' ||
    key === 'PageDown' ||
    eventCode === 'PageDown' ||
    code === 34 ||
    code === 428 || // Android KEYCODE_CHANNEL_DOWN
    code === 167;

  // Media Controls
  const isPlayPause =
    key === 'MediaPlayPause' ||
    key === 'PlayPause' ||
    key === 'MediaPlay' ||
    key === 'MediaPause' ||
    key === 'MediaStop' ||
    code === 179 ||
    code === 85 || // Android KEYCODE_MEDIA_PLAY_PAUSE
    code === 126 || // Android KEYCODE_MEDIA_PLAY
    code === 127 || // Android KEYCODE_MEDIA_PAUSE
    code === 86; // Android KEYCODE_MEDIA_STOP

  const isRewind =
    key === 'MediaRewind' ||
    key === 'Rewind' ||
    code === 227 ||
    code === 89; // Android KEYCODE_MEDIA_REWIND

  const isFastForward =
    key === 'MediaFastForward' ||
    key === 'FastForward' ||
    code === 228 ||
    code === 90; // Android KEYCODE_MEDIA_FAST_FORWARD

  // Menu button on remote
  const isMenu =
    key === 'ContextMenu' ||
    key === 'Menu' ||
    eventCode === 'ContextMenu' ||
    code === 82 || // Android KEYCODE_MENU
    code === 93;

  // Info / Guide button
  const isInfo =
    key === 'Info' ||
    key === 'Guide' ||
    code === 165 || // Android KEYCODE_INFO
    code === 457 ||
    code === 172 ||
    code === 458;

  let numberKey: number | null = null;
  if (code >= 48 && code <= 57) {
    numberKey = code - 48;
  } else if (code >= 96 && code <= 105) {
    numberKey = code - 96;
  } else if (/^[0-9]$/.test(key)) {
    numberKey = parseInt(key, 10);
  }

  return {
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
    isMenu,
    isInfo,
    numberKey,
    originalEvent: e,
  };
}

/**
 * Ensures an element is scrolled into view instantly with zero animation lag,
 * essential for rapid D-Pad button repeats on TV remotes.
 * Also adds .tv-active-focus class for guaranteed visual indicator on Android TV WebViews.
 */
export function focusTvElement(el: HTMLElement | null, instant = true) {
  if (!el) return;
  try {
    el.focus({ preventScroll: false });
    // Keep visible focus marker on Android TV browsers
    document.querySelectorAll('.tv-active-focus').forEach((item) => {
      if (item !== el) item.classList.remove('tv-active-focus');
    });
    el.classList.add('tv-active-focus');

    if ((el as any).scrollIntoViewIfNeeded) {
      (el as any).scrollIntoViewIfNeeded(false);
    } else {
      el.scrollIntoView({
        behavior: instant ? 'auto' : 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }
  } catch {
    try {
      el.focus();
    } catch {
      // ignore
    }
  }
}

/**
 * Smartly finds the first meaningful focusable TV element on the current screen or modal
 */
export function findFirstTvElement(container: HTMLElement | Document = document): HTMLElement | null {
  // If a modal or drawer is open, prioritize elements inside it:
  const modalOrDrawer =
    document.querySelector<HTMLElement>('[data-tv-modal="true"]') ||
    document.querySelector<HTMLElement>('.fixed.inset-0.z-50') ||
    document.querySelector<HTMLElement>('.fixed.inset-0.z-40');

  if (modalOrDrawer) {
    const inner = modalOrDrawer.querySelector<HTMLElement>(
      '[data-tv="menu-item"], [data-tv="drawer-item"], button:not([disabled]), input:not([disabled]), [tabindex="0"]:not([disabled])'
    );
    if (inner) return inner;
  }

  return (
    container.querySelector<HTMLElement>('[data-tv="channel"]') ||
    container.querySelector<HTMLElement>('[data-tv="category"][data-active="true"]') ||
    container.querySelector<HTMLElement>('[data-tv="category"]') ||
    container.querySelector<HTMLElement>('[data-tv="playlist"]') ||
    container.querySelector<HTMLElement>('[data-tv="tab"][data-active="true"]') ||
    container.querySelector<HTMLElement>('[data-tv="tab"]') ||
    container.querySelector<HTMLElement>('[data-tv="add-playlist-btn"]') ||
    container.querySelector<HTMLElement>('[data-tv="header-btn"]') ||
    container.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled]), [tabindex="0"]:not([disabled])')
  );
}

/**
 * Finds all focusable TV elements without triggering slow getComputedStyle reflows
 */
export function getFocusableTvElements(container: HTMLElement | Document = document): HTMLElement[] {
  const selector = [
    'button:not([disabled])',
    '[tabindex="0"]:not([disabled])',
    'input:not([disabled])',
    'a[href]',
    '[data-tv]',
  ].join(',');

  const nodes = Array.from(container.querySelectorAll<HTMLElement>(selector));
  return nodes.filter((node) => {
    // Fast check: offsetParent === null filters out display:none elements instantly
    if ((node as any).offsetParent === null && node.tagName !== 'BODY') {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

/**
 * Helper to get geometric bounding box centers for spatial navigation fallback
 */
function getCenter(rect: DOMRect) {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

/**
 * 2D spatial navigation fallback when direct layout navigation does not apply
 */
export function findNextSpatialElement(
  current: HTMLElement,
  direction: 'up' | 'down' | 'left' | 'right',
  container: HTMLElement | Document = document
): HTMLElement | null {
  const currentRect = current.getBoundingClientRect();
  const currentCenter = getCenter(currentRect);
  const candidates = getFocusableTvElements(container).filter((el) => el !== current);

  let bestElement: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect();
    const center = getCenter(rect);

    const dx = center.x - currentCenter.x;
    const dy = center.y - currentCenter.y;

    let isPrimaryDirection = false;
    let primaryDist = 0;
    let secondaryDist = 0;

    switch (direction) {
      case 'up':
        isPrimaryDirection = dy < -3;
        primaryDist = -dy;
        secondaryDist = Math.abs(dx);
        break;
      case 'down':
        isPrimaryDirection = dy > 3;
        primaryDist = dy;
        secondaryDist = Math.abs(dx);
        break;
      case 'left':
        isPrimaryDirection = dx < -3;
        primaryDist = -dx;
        secondaryDist = Math.abs(dy);
        break;
      case 'right':
        isPrimaryDirection = dx > 3;
        primaryDist = dx;
        secondaryDist = Math.abs(dy);
        break;
    }

    if (!isPrimaryDirection) continue;

    // Heavily penalize perpendicular deviation to keep directional tracking true
    const score = primaryDist + secondaryDist * 2.5;

    if (score < bestScore) {
      bestScore = score;
      bestElement = candidate;
    }
  }

  return bestElement;
}
