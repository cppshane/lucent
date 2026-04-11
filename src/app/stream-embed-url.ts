/**
 * Twitch / YouTube / Kick embed URLs (same rules as stream sidebar player).
 */
export function buildStreamEmbedUrl(channelLogin: string): string {
  if (channelLogin.startsWith('yt-')) {
    const id = channelLogin.slice(3);
    return `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1`;
  }

  if (channelLogin.startsWith('kick-')) {
    const slug = channelLogin.slice(5);
    return `https://player.kick.com/${encodeURIComponent(slug)}?autoplay=true`;
  }

  const params = new URLSearchParams();
  params.set('channel', channelLogin);
  params.set('muted', 'false');
  const parents = new Set<string>([
    typeof window !== 'undefined' ? window.location.hostname : 'localhost',
    'localhost',
    '127.0.0.1',
  ]);
  parents.forEach((p) => params.append('parent', p));
  return `https://player.twitch.tv/?${params.toString()}`;
}
