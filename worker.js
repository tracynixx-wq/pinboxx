// PinBox worker v3 (Cloudflare Workers)
// GET /?url=<ссылка на пин или pin.it>   -> JSON {type, mediaUrl, title, pinUrl}
// GET /?url=...&debug=1                  -> то же + журнал шагов (для диагностики)
// GET /?media=<ссылка на pinimg.com>     -> сам файл (с CORS-заголовками)
// GET /                                  -> {"error": "...", "v": 3}  (так видно, что воркер обновился)

const VERSION = 3;

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
    const debug = u.searchParams.get('debug') === '1';
    try {
      if (media) return await proxyMedia(media);
      if (pin) return await resolvePin(pin, debug);
      return json({ error: 'Нужен параметр url или media', v: VERSION }, 400);
    } catch (e) {
      return json({ error: String((e && e.message) || e), v: VERSION }, 500);
    }
  },
};

// ───── Файл ─────

// Ссылки для проб: сначала как есть, потом другие размеры
function candidates(href) {
  const list = [href];
  if (/\/(originals|\d+x\d*)\//.test(href)) {
    for (const size of ['originals', '1200x', '736x', '564x', '474x', '236x']) {
      const alt = href.replace(/\/(originals|\d+x\d*)\//, '/' + size + '/');
      if (!list.includes(alt)) list.push(alt);
    }
  }
  return list;
}

async function proxyMedia(m) {
  const mu = new URL(m);
  if (mu.protocol !== 'https:' || !isPinimg(mu.hostname)) {
    return json({ error: 'Этот хост не разрешён', v: VERSION }, 400);
  }
  const tried = [];
  const list = candidates(mu.href);
  for (let i = 0; i < list.length; i++) {
    // для первой ссылки пробуем и с Referer, и без
    const variants = i === 0
      ? [{ 'User-Agent': UA, Referer: 'https://www.pinterest.com/' }, { 'User-Agent': UA }]
      : [{ 'User-Agent': UA, Referer: 'https://www.pinterest.com/' }];
    for (const headers of variants) {
      let r;
      try {
        r = await fetch(list[i], { headers: { ...headers, Accept: '*/*' } });
      } catch (e) {
        tried.push('сеть');
        continue;
      }
      if (r.ok) {
        const h = new Headers(CORS);
        h.set('Content-Type', r.headers.get('Content-Type') || 'application/octet-stream');
        return new Response(r.body, { headers: h });
      }
      tried.push(r.status);
    }
  }
  return json({ error: 'Pinterest не отдал файл (коды: ' + tried.join(', ') + ')', v: VERSION }, 502);
}

// ───── Разбор страницы пина ─────

function upgrade(src) {
  return src.replace(/\/(\d+x\d*)\//, '/originals/');
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function meta(html, prop) {
  const a = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']+)["\']', 'i').exec(html);
  if (a) return decode(a[1]);
  const b = new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']' + prop + '["\']', 'i').exec(html);
  return b ? decode(b[1]) : '';
}

function pickVideo(urls) {
  const mp4 = urls.filter((x) => /\.mp4(\?|$)/i.test(x));
  return (
    mp4.find((x) => /720p/.test(x)) ||
    mp4.find((x) => /expMp4|exp\d/.test(x)) ||
    mp4.find((x) => /480p|640p/.test(x)) ||
    mp4[0] ||
    ''
  );
}

// Ищет медиа прямо в тексте страницы (в том числе в JSON внутри скриптов)
function fromText(html) {
  const txt = html.replace(/\\u002F/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const videos = [...txt.matchAll(/https:\/\/v\d*\.pinimg\.com\/[^"'\\\s<>]+?\.mp4/g)].map((m) => m[0]);
  const video = pickVideo(videos);
  let image = '';
  const orig = /"orig"\s*:\s*\{[^}]*?"url"\s*:\s*"(https:[^"]+)"/.exec(txt);
  if (orig) image = orig[1];
  if (!image) image = meta(html, 'og:image');
  const title = meta(html, 'og:title');
  return { video, image, title };
}

// Разбор объекта пина из API
function fromPinObject(p) {
  if (!p) return { video: '', image: '', title: '' };
  const vl = (p.videos && p.videos.video_list) || (p.story_pin_data && null) || {};
  const urls = Object.values(vl).map((v) => v && v.url).filter(Boolean);
  const video = pickVideo(urls);
  const imgs = p.images || {};
  const image = (imgs.orig && imgs.orig.url) || (imgs['736x'] && imgs['736x'].url) || (imgs['474x'] && imgs['474x'].url) || '';
  return { video, image, title: p.title || p.grid_title || p.description || '' };
}

async function tryApis(id, trace) {
  // 1) внутренний ресурс Pinterest
  try {
    const data = encodeURIComponent(JSON.stringify({ options: { id, field_set_key: 'detailed' }, context: {} }));
    const u = 'https://www.pinterest.com/resource/PinResource/get/?source_url=' + encodeURIComponent('/pin/' + id + '/') + '&data=' + data;
    const r = await fetch(u, {
      headers: { 'User-Agent': UA, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-Pinterest-AppState': 'active' },
    });
    trace.push('api1 ' + r.status);
    if (r.ok) {
      const j = await r.json();
      const res = fromPinObject(j && j.resource_response && j.resource_response.data);
      if (res.video || res.image) return res;
    }
  } catch (e) { trace.push('api1 ошибка'); }

  // 2) виджеты
  try {
    const r = await fetch('https://widgets.pinterest.com/v3/pidgets/pins/info/?pin_ids=' + id, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    trace.push('api2 ' + r.status);
    if (r.ok) {
      const j = await r.json();
      const res = fromPinObject(j && j.data && j.data[0]);
      if (res.video || res.image) return res;
    }
  } catch (e) { trace.push('api2 ошибка'); }
  return null;
}

async function resolvePin(raw, debug) {
  const trace = [];
  const done = (type, mediaUrl, title) => {
    const out = { type, mediaUrl, title: title || '', pinUrl: raw, v: VERSION };
    if (debug) out.trace = trace;
    return json(out);
  };

  const pu = new URL(raw);

  // Прямая ссылка на файл pinimg
  if (isPinimg(pu.hostname) && /\.(jpe?g|png|webp|gif|mp4)$/i.test(pu.pathname)) {
    const isVideo = /\.mp4$/i.test(pu.pathname);
    return done(isVideo ? 'video' : 'image', isVideo ? pu.href : upgrade(pu.href), '');
  }

  if (!/(^|\.)pinterest\.[a-z.]+$/i.test(pu.hostname) && pu.hostname !== 'pin.it') {
    return json({ error: 'Это не ссылка Pinterest', v: VERSION }, 400);
  }

  // Страница пина (pin.it сам перенаправит)
  let html = '';
  let finalUrl = pu.href;
  try {
    const r = await fetch(pu.href, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    finalUrl = r.url || pu.href;
    trace.push('страница ' + r.status);
    if (r.ok) html = await r.text();
  } catch (e) { trace.push('страница: сеть'); }

  let found = html ? fromText(html) : { video: '', image: '', title: '' };
  trace.push('в странице: видео ' + (found.video ? 'да' : 'нет') + ', картинка ' + (found.image ? 'да' : 'нет'));

  // Если в странице пусто, идём в API по номеру пина
  if (!found.video && !found.image) {
    const idm = /\/pin\/(\d+)/.exec(finalUrl) || /\/pin\/(\d+)/.exec(html) || /pin(?:s)?\/(\d{6,})/.exec(finalUrl);
    if (idm) {
      const viaApi = await tryApis(idm[1], trace);
      if (viaApi) found = viaApi;
    } else {
      trace.push('номер пина не найден, адрес: ' + finalUrl.slice(0, 80));
    }
  }

  if (found.video) return done('video', found.video, found.title);
  if (found.image) return done('image', upgrade(found.image), found.title);

  return json({ error: 'Не нашёл медиа в этом пине (' + trace.join('; ') + ')', v: VERSION, trace }, 404);
}
