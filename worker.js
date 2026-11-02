// Cloudflare Worker: достаёт прямую ссылку на медиа из пина Pinterest и отдаёт файл с CORS.
// GET /?url=<ссылка на пин или pin.it>  -> JSON {type, mediaUrl, title, pinUrl}
// GET /?media=<ссылка на pinimg.com>    -> сам файл (с CORS-заголовками)

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });

const isPinimg = (host) => /(^|\.)pinimg\.com$/.test(host);

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    const media = u.searchParams.get('media');
    const pin = u.searchParams.get('url');
    try {
      if (media) return await proxyMedia(media);
      if (pin) return await resolvePin(pin);
      return json({ error: 'Нужен параметр url или media' }, 400);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};

async function proxyMedia(m) {
  const mu = new URL(m);
  if (mu.protocol !== 'https:' || !isPinimg(mu.hostname)) {
    return json({ error: 'Этот хост не разрешён' }, 400);
  }
  const r = await fetch(mu.href, {
    headers: { 'User-Agent': UA, Referer: 'https://www.pinterest.com/' },
  });
  if (!r.ok) return json({ error: 'Медиа недоступно: ' + r.status }, 502);
  const h = new Headers(CORS);
  h.set('Content-Type', r.headers.get('Content-Type') || 'application/octet-stream');
  return new Response(r.body, { headers: h });
}

function upgrade(src) {
  // /236x/, /736x/, /564x/ -> /originals/
  return src.replace(/\/(\d+x\d*)\//, '/originals/');
}

function meta(html, prop) {
  const a = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']+)["\']', 'i').exec(html);
  if (a) return decode(a[1]);
  const b = new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']' + prop + '["\']', 'i').exec(html);
  return b ? decode(b[1]) : '';
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function resolvePin(raw) {
  const pu = new URL(raw);

  // Прямая ссылка на файл pinimg
  if (isPinimg(pu.hostname) && /\.(jpe?g|png|webp|gif|mp4)$/i.test(pu.pathname)) {
    const isVideo = /\.mp4$/i.test(pu.pathname);
    return json({ type: isVideo ? 'video' : 'image', mediaUrl: isVideo ? pu.href : upgrade(pu.href), title: '', pinUrl: raw });
  }

  if (!/(^|\.)pinterest\.[a-z.]+$/i.test(pu.hostname) && pu.hostname !== 'pin.it') {
    return json({ error: 'Это не ссылка Pinterest' }, 400);
  }

  const r = await fetch(pu.href, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow',
  });
  if (!r.ok) return json({ error: 'Pinterest ответил ' + r.status }, 502);
  const html = await r.text();
  const txt = html.replace(/\\u002F/g, '/').replace(/\\\//g, '/');

  const title = meta(html, 'og:title');
  const ogVideo = meta(html, 'og:video') || meta(html, 'og:video:url');
  const ogImage = meta(html, 'og:image');

  // Видео
  if (ogVideo) {
    let video = /\.mp4/i.test(ogVideo) ? ogVideo : '';
    if (!video) {
      const all = [...txt.matchAll(/https:\/\/v\d*\.pinimg\.com\/videos\/[^"'\\\s<>]+?\.mp4/g)].map((m) => m[0]);
      video = all.find((x) => /720p|expMp4/.test(x)) || all[0] || '';
    }
    if (video) return json({ type: 'video', mediaUrl: video, title, pinUrl: raw });
  }

  // Картинка
  if (ogImage) {
    return json({ type: 'image', mediaUrl: upgrade(ogImage), title, pinUrl: raw });
  }

  return json({ error: 'Не нашёл медиа в этом пине' }, 404);
}
