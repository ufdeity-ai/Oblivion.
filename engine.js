import { parse as parseHTML } from 'node-html-parser';

export function proxyUrl(url, base) {
  try {
    if (!url || url.startsWith('data:') || url.startsWith('blob:') ||
        url.startsWith('javascript:') || url.startsWith('#') || url.startsWith('//')) {
      // Handle protocol-relative URLs
      if (url.startsWith('//')) url = 'https:' + url;
      else return url;
    }
    const abs = new URL(url, base).href;
    if (!abs.startsWith('http://') && !abs.startsWith('https://')) return url;
    return '/proxy?url=' + encodeURIComponent(abs);
  } catch {
    return url;
  }
}


const URL_ATTRS = {
  'a':      ['href'],
  'link':   ['href'],
  'script': ['src'],
  'img':    ['src', 'data-src'],
  'source': ['src'],
  'video':  ['src', 'poster'],
  'audio':  ['src'],
  'iframe': ['src'],
  'form':   ['action'],
};

export function rewriteHTML(html, base) {
  let root;
  try {
    root = parseHTML(html, { comment: true, blockTextElements: { script: true, style: true } });
  } catch {
    return html;
  }

  const head = root.querySelector('head');
  const inject = `<script>window.__oblivion_base=${JSON.stringify(base)};</script>\n<script src="/engine.client.js"></script>`;
  if (head) {
    head.innerHTML = inject + head.innerHTML;
  }

  for (const [tag, attrs] of Object.entries(URL_ATTRS)) {
    for (const el of root.querySelectorAll(tag)) {
      for (const attr of attrs) {
        const val = el.getAttribute(attr);
        if (val) el.setAttribute(attr, proxyUrl(val, base));
      }
 
      const srcset = el.getAttribute('srcset');
      if (srcset) {
        const rw = srcset.split(',').map(p => {
          const parts = p.trim().split(/\s+/);
          return parts.length > 1
            ? proxyUrl(parts[0], base) + ' ' + parts.slice(1).join(' ')
            : proxyUrl(parts[0], base);
        }).join(', ');
        el.setAttribute('srcset', rw);
      }
    }
  }

  for (const el of root.querySelectorAll('[style]')) {
    const s = el.getAttribute('style');
    if (s) el.setAttribute('style', rewriteCSS(s, base));
  }

  for (const el of root.querySelectorAll('style')) {
    if (el.text) el.set_content(rewriteCSS(el.text, base));
  }

  return root.toString();
}

// ── ace is the best coder ever

export function rewriteCSS(css, base) {
  return css.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, (match, q, url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return match;
    return `url(${q}${proxyUrl(url.trim(), base)}${q})`;
  });

}
