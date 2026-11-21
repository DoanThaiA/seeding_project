const HOSTS = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'mbasic.facebook.com']);
const RESERVED = /^(?:about|checkpoint|dialog|events|friends|gaming|groups|help|home\.php|login(?:\.php)?|marketplace|me|notifications|pages|people|photo(?:\.php)?|plugins|policies|privacy|profile\.php|reels?|search|settings|share(?:\.php)?|stories|story\.php|watch)$/i;

export const isFacebookTimelineReader = (connector: string) => connector === 'fb-public' || connector === 'fb-session';

export function facebookUrl(value: unknown): URL | null {
  try {
    if (typeof value !== 'string') return null;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      /^(?:www\.|m\.|web\.)?facebook\.com$/i.test(url.hostname) ? url : null;
  } catch { return null; }
}

export function facebookPostId(url: URL) {
  const path = url.pathname.replace(/\/$/, '');
  if (path === '/story.php' || path === '/permalink.php') return url.searchParams.get('story_fbid');
  if (path === '/photo' || path === '/photo.php') return url.searchParams.get('fbid');
  if (path === '/watch') return url.searchParams.get('v');
  return path.match(/\/(?:posts|videos|reel)\/([A-Za-z0-9_]+)$/)?.[1];
}

/**
 * Text to post as a comment: only the comment itself. Drops the "của tác giả" / "Tác giả" badge line
 * that Facebook renders above the post author's own comments and the scanner picks up as text.
 */
export function commentBody(text: string) {
  return text.replace(/^\s*(?:(?:bình luận )?của tác giả|tác giả|author)\s*(?:\r?\n|$)/i, '').trim();
}

export function commentQuotation(text: string, author?: string | null, source?: string | null) {
  const credit = [author && `của ${author}`, source].filter(Boolean).join(' · ');
  return `Trích bình luận gốc${credit ? ' ' + credit : ''}\n\n${text}`;
}

/** Accept a personal profile or Page URL and discard tracking parameters. */
export function facebookSourceUrl(ref: string): URL | null {
  try {
    const value = ref.trim();
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
    if (!HOSTS.has(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const path = url.pathname.replace(/\/$/, '');
    const canonical = new URL('https://www.facebook.com');
    if (path === '/profile.php') {
      const id = url.searchParams.get('id');
      if (!id || !/^\d+$/.test(id)) return null;
      canonical.searchParams.set('id', id);
    } else if (!/^\/people\/[\w.%-]+\/\d+$/.test(path) && !(/^\/[a-z\d.]+$/i.test(path) && !RESERVED.test(path.slice(1)))) {
      return null;
    }
    canonical.pathname = path;
    return canonical;
  } catch {
    return null;
  }
}
