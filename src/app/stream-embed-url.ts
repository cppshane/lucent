/**
 * Twitch / YouTube / Kick embed URLs (same rules as stream sidebar player).
 */
export type BuildStreamEmbedUrlOptions = {
  /**
   * Prefer muted playback so autoplay can start without a prior user gesture
   * (cold navigation with `?focus=1` — browsers block audible autoplay otherwise).
   */
  preferMutedAutoplay?: boolean;
  /**
   * When `true`, main stream audio is allowed (embed unmuted when policy allows).
   * When `false`, embed is muted. **Omit** for sidebar embeds — defaults to unmuted.
   */
  streamAudioOn?: boolean;
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
  const streamAudioUnmuted =
    options?.streamAudioOn === undefined ? true : options.streamAudioOn === true;
  const embedMuted = preferMuted || !streamAudioUnmuted;
  const nonce = options?.reloadNonce;

  if (channelLogin.startsWith('yt-')) {
    const id = channelLogin.slice(3);
    const q = new URLSearchParams();
    q.set('autoplay', '1');
    q.set('playsinline', '1');
    if (embedMuted) {
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
    if (embedMuted) {
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
  params.set('muted', embedMuted ? 'true' : 'false');
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

export type YoutubeEmbedExtras = {
  autoplay?: boolean;
  /**
   * `true` = mute=1 (silent autoplay). `false` = mute=0 — use when opening from a user gesture
   * (e.g. LoFi picker) so volume isn’t stuck at 0 with a confusing UI.
   */
  muted?: boolean;
  reloadNonce?: number;
};

export function buildYoutubeVideoEmbedUrl(
  videoId: string,
  extras?: YoutubeEmbedExtras,
): string {
  const q = new URLSearchParams();
  q.set('autoplay', extras?.autoplay === false ? '0' : '1');
  q.set('playsinline', '1');
  /* Always set mute explicitly — omitting can leave YouTube’s volume at 0 while looking “unmuted”. */
  const muted = extras?.muted === true;
  q.set('mute', muted ? '1' : '0');
  if (extras?.reloadNonce !== undefined) {
    q.set('lucent_ap', String(extras.reloadNonce));
  }
  return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${q.toString()}`;
}
