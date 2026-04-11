/**
 * Twitch / YouTube / Kick embed URLs (same rules as stream sidebar player).
 */
export type BuildStreamEmbedUrlOptions = {
  /**
   * Prefer muted playback so autoplay can start without a prior user gesture
   * (cold navigation with `?focus=1` — browsers block audible autoplay otherwise).
   * Viewers can unmute in the embedded player.
   */
  preferMutedAutoplay?: boolean;
  /**
   * Changes the embed URL so the iframe reloads (e.g. after Pomodoro Start — user gesture
   * lets autoplay with sound succeed on YouTube and others).
   */
  reloadNonce?: number;
};

export function buildStreamEmbedUrl(
  channelLogin: string,
  options?: BuildStreamEmbedUrlOptions,
): string {
  const preferMuted = options?.preferMutedAutoplay === true;
  const nonce = options?.reloadNonce;

  if (channelLogin.startsWith('yt-')) {
    const id = channelLogin.slice(3);
    const q = new URLSearchParams();
    q.set('autoplay', '1');
    q.set('playsinline', '1');
    if (preferMuted) {
      q.set('mute', '1');
    }
    if (nonce !== undefined) {
      q.set('lucent_ap', String(nonce));
    }
    return `https://www.youtube.com/embed/${encodeURIComponent(id)}?${q.toString()}`;
  }

  if (channelLogin.startsWith('kick-')) {
    const slug = channelLogin.slice(5);
    const q = new URLSearchParams();
    q.set('autoplay', 'true');
    if (preferMuted) {
      q.set('muted', 'true');
    }
    if (nonce !== undefined) {
      q.set('lucent_ap', String(nonce));
    }
    return `https://player.kick.com/${encodeURIComponent(slug)}?${q.toString()}`;
  }

  const params = new URLSearchParams();
  params.set('channel', channelLogin);
  params.set('autoplay', 'true');
  params.set('muted', preferMuted ? 'true' : 'false');
  if (nonce !== undefined) {
    params.set('lucent_ap', String(nonce));
  }
  const parents = new Set<string>([
    typeof window !== 'undefined' ? window.location.hostname : 'localhost',
    'localhost',
    '127.0.0.1',
  ]);
  parents.forEach((p) => params.append('parent', p));
  return `https://player.twitch.tv/?${params.toString()}`;
}
