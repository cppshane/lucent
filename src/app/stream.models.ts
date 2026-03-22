/** Matches LucentApi StreamDto JSON (camelCase). */
export interface StreamDto {
  title: string;
  description: string;
  link: string;
  thumbnail: string;
  viewerCount: number;
  latitude: number;
  longitude: number;
  uncertaintyKm?: number | null;
  /** `"twitch"` | `"youtube"` | `"kick"` — defaults to twitch when omitted (older API payloads). */
  platform?: string | null;
}

/** globe.gl point + sidebar (parsed Twitch login). */
export interface GlobeStreamPoint extends StreamDto {
  channelLogin: string;
  kind: 'stream';
}

export function twitchLoginFromLink(link: string): string | null {
  try {
    const u = new URL(link);
    if (!u.hostname.endsWith('twitch.tv')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const login = parts[0];
    if (!login || login === 'videos' || login === 'directory') return null;
    return login.toLowerCase();
  } catch {
    return null;
  }
}

/** YouTube watch / youtu.be /live/ → video id (case-sensitive). */
export function youtubeVideoIdFromLink(link: string): string | null {
  try {
    const u = new URL(link);
    const host = u.hostname.replace(/^www\./i, '');
    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return id && id.length >= 6 ? id : null;
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      if (u.pathname.startsWith('/watch')) {
        return u.searchParams.get('v');
      }
      if (u.pathname.startsWith('/live/')) {
        const parts = u.pathname.split('/').filter(Boolean);
        return parts.length >= 2 ? parts[1]! : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function kickSlugFromLink(link: string): string | null {
  try {
    const u = new URL(link);
    const host = u.hostname.replace(/^www\./i, '');
    if (host !== 'kick.com') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const slug = parts[0];
    return slug ? slug.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Stable id for globe + URL param: Twitch login, `yt-{videoId}`, or `kick-{slug}`. */
export function streamKeyFromDto(d: StreamDto): string | null {
  const platform = (d.platform ?? 'twitch').toLowerCase();
  if (platform === 'youtube') {
    const id = youtubeVideoIdFromLink(d.link);
    return id ? `yt-${id}` : null;
  }
  if (platform === 'kick') {
    const slug = kickSlugFromLink(d.link);
    return slug ? `kick-${slug}` : null;
  }
  return twitchLoginFromLink(d.link);
}

export function toGlobeStreamPoint(d: StreamDto): GlobeStreamPoint | null {
  const channelLogin = streamKeyFromDto(d);
  if (!channelLogin) return null;
  if (!Number.isFinite(d.latitude) || !Number.isFinite(d.longitude)) return null;
  const platform = (d.platform ?? 'twitch').toLowerCase();
  return { ...d, platform, channelLogin, kind: 'stream' as const };
}
