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

export function facebookPostLink(value: unknown) {
  const url = facebookUrl(value);
  if (!url || url.searchParams.has('comment_id') || url.searchParams.has('reply_comment_id')) return null;
  const id = facebookPostId(url);
  if (!id) return null;
  for (const key of [...url.searchParams.keys()]) if (!['id', 'story_fbid', 'fbid', 'v'].includes(key)) url.searchParams.delete(key);
  url.hash = '';
  return { url, id };
}

/** Accept a direct post link or a Facebook share link that must be resolved in a checked session. */
export function facebookScriptPost(value: string) {
  const direct = facebookPostLink(value);
  if (direct && /^[A-Za-z0-9_]{1,160}$/.test(direct.id)) {
    const set = /^\/photo(?:\.php)?\/?$/.test(direct.url.pathname) && new URL(value).searchParams.get('set');
    if (set && /^(?:a|pcb)\.\d{1,30}$/.test(set)) direct.url.searchParams.set('set', set);
    return { url: direct.url, id: direct.id };
  }
  const shared = facebookUrl(value);
  if (!shared || !/^\/share\/(?:[prv]\/)?[A-Za-z0-9_-]{1,160}\/?$/.test(shared.pathname)) return null;
  shared.search = '';
  shared.hash = '';
  return { url: shared, id: null };
}

/**
 * Facebook writes a comment id either as digits or as base64 of "comment:<post>_<comment>"
 * (links copied from notifications). Return the digits so ids from both forms compare equal.
 */
export function facebookCommentId(value: string | null | undefined): string | null {
  if (!value || /^\d+$/.test(value)) return value || null;
  try {
    return /^comment:\d+_(\d+)$/.exec(atob(value.replace(/-/g, '+').replace(/_/g, '/')))?.[1] ?? value;
  } catch { return value; }
}

export function facebookScriptComment(value: string | null | undefined) {
  const url = facebookUrl(value);
  if (!url) return null;
  const root = facebookCommentId(url.searchParams.get('comment_id'));
  const reply = facebookCommentId(url.searchParams.get('reply_comment_id'));
  const valid = (id: string) => /^[A-Za-z0-9_:-]{1,150}$/.test(id);
  if (!root || !valid(root) || (url.searchParams.has('reply_comment_id') && (!reply || !valid(reply) || reply === root))) return null;
  url.searchParams.delete('comment_id');
  url.searchParams.delete('reply_comment_id');
  const post = facebookScriptPost(url.href);
  if (!post?.id) return null;
  const comment = new URL(post.url);
  comment.searchParams.set('comment_id', root);
  if (reply) comment.searchParams.set('reply_comment_id', reply);
  return { url: comment, postId: post.id, root, reply, id: reply ?? root };
}

/**
 * Text to post as a comment: only the comment itself. Drops the "của tác giả" / "Tác giả" badge line
 * that Facebook renders above the post author's own comments and the scanner picks up as text.
 */
export function commentBody(text: string) {
  return text.replace(/^\s*(?:(?:bình luận )?của tác giả|tác giả|author)\s*(?:\r?\n|$)/i, '').trim();
}

/** Unwrap older generated copies when their body still matches the source comment. */
export function commentReplayBody(text: string, sourceText: string) {
  const body = commentBody(text);
  const original = commentBody(sourceText);
  const legacy = /^Trích bình luận gốc(?:(?: của | · )[^\r\n]+)?\r?\n[ \t]*\r?\n/.exec(body);
  return legacy && commentBody(body.slice(legacy[0].length)) === original ? original : body;
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
