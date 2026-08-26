/* ══════════════════════════════════════════════════════════════════════
   وسيط ياهو المشترك — إدارة الكوكي والـ crumb
   ──────────────────────────────────────────────────────────────────────
   ياهو تطلب منذ 2023 زوجاً من (كوكي A1 + crumb) على معظم نقاط v7/v10.
   نقطة الشارت v8 ما زالت تعمل بلا ذلك غالباً، لكن سلسلة العقود لا.

   نحتفظ بالزوج في ذاكرة العملية ونجدّده عند انتهائه (401/403/Invalid
   Crumb). الاحتفاظ مهم: طلب crumb جديد مع كل استدعاء يستدعي خنق الطلبات
   بعد دقائق من الاستخدام العادي.
   ══════════════════════════════════════════════════════════════════════ */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

let CACHE = { cookie: null, crumb: null, at: 0 };
const TTL = 45 * 60 * 1000;   /* الزوج يعيش نحو ساعة عند ياهو */

async function getCrumb(force = false) {
  if (!force && CACHE.crumb && Date.now() - CACHE.at < TTL) return CACHE;

  const r1 = await fetch('https://fc.yahoo.com', {
    headers: { 'User-Agent': UA },
    redirect: 'manual'
  }).catch(() => null);

  let cookie = null;
  if (r1) {
    const raw = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie')].filter(Boolean);
    cookie = raw.map(c => c.split(';')[0]).join('; ');
  }
  if (!cookie) {
    const r2 = await fetch('https://finance.yahoo.com/', { headers: { 'User-Agent': UA } }).catch(() => null);
    if (r2) {
      const raw = r2.headers.getSetCookie ? r2.headers.getSetCookie() : [r2.headers.get('set-cookie')].filter(Boolean);
      cookie = raw.map(c => c.split(';')[0]).join('; ');
    }
  }

  let crumb = null;
  if (cookie) {
    const r3 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, Cookie: cookie }
    }).catch(() => null);
    if (r3 && r3.ok) {
      const t = (await r3.text()).trim();
      if (t && t.length < 40 && !t.startsWith('<')) crumb = t;
    }
  }

  CACHE = { cookie, crumb, at: Date.now() };
  return CACHE;
}

/** يجلب من ياهو مع الكوكي/الـcrumb، ويعيد المحاولة مرة واحدة بزوج جديد. */
async function yfetch(buildUrl, { needCrumb = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { cookie, crumb } = needCrumb ? await getCrumb(attempt > 0) : { cookie: null, crumb: null };
    const url = buildUrl(crumb);
    const headers = { 'User-Agent': UA, Accept: 'application/json' };
    if (cookie) headers.Cookie = cookie;

    const r = await fetch(url, { headers });
    const text = await r.text();

    if (r.ok) {
      try { return { ok: true, status: 200, data: JSON.parse(text) }; }
      catch { return { ok: false, status: 502, error: 'استجابة غير قابلة للتحليل من المزوّد' }; }
    }
    /* 401/403 غالباً crumb منتهٍ — نجدّد ونعيد مرة واحدة فقط */
    if ((r.status === 401 || r.status === 403) && needCrumb && attempt === 0) continue;

    return {
      ok: false,
      status: r.status,
      error: r.status === 429
        ? 'المزوّد يخنق الطلبات (429). أبطئ المسح أو انتقل إلى مزوّد مدفوع.'
        : `المزوّد أعاد ${r.status}`
    };
  }
  return { ok: false, status: 502, error: 'فشل الاتصال بالمزوّد بعد محاولتين' };
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
}

module.exports = { yfetch, getCrumb, setCors, UA };
