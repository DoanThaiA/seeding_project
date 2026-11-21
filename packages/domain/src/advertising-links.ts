export function isAdvertisingLink(value: string): boolean {
  try {
    let url = new URL(value);
    if (/^(?:l|lm|www)\.facebook\.com$/.test(url.hostname) && url.pathname === '/l.php') {
      url = new URL(url.searchParams.get('u') ?? '');
    }
    const host = url.hostname.toLowerCase();
    if (host === 's.shopee.vn' || host === 'shope.ee') return true;
    return (host === 'shopee.vn' || host.endsWith('.shopee.vn'))
      && (/^\/an_redir(?:\/|$)/i.test(url.pathname)
        || ['affiliate_id', 'gads_t_sig', 'sub_id'].some(key => url.searchParams.has(key)));
  } catch {
    return false;
  }
}

/** Strip URLs without dereferencing them, preserving ordinary links and caption line breaks. */
export function removeAdvertisingLinks(text: string): string {
  const stripped = text.replace(/https?:\/\/[^\s<>"']+/gi, value => isAdvertisingLink(value) ? '' : value);
  return stripped === text ? text : stripped.replace(/[ \t]+$/gm, '').trim();
}
