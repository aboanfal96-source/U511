/* ══════════════════════════════════════════════════════════════════════
   وحدة مشتركة لجلب بيانات ياهو من جهة الخادم.

   لماذا من الخادم أصلاً؟ لأن المتصفح يمنع الطلب المباشر (CORS). البديل
   الشائع هو وسيط عام مثل allorigins، وهو خيار سيّئ لثلاثة أسباب: طرف ثالث
   يرى كل طلباتك، بلا ضمان توفّر، ويُحظر بـ429 عند أول مسح جماعي. على
   Vercel الطلب يخرج من الخادم فلا قيد CORS من الأصل.

   الـcrumb: بعض نقاط ياهو صارت تتطلّب كوكي + رمز crumb. نحصل عليه مرة
   ونخزّنه في ذاكرة الدالة (تبقى حيّة بين الطلبات المتقاربة على Vercel)،
   ونعيد المحاولة بلا crumb إن فشل — لأن نقاط أخرى ما زالت تعمل بدونه.
   ══════════════════════════════════════════════════════════════════════ */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

let _crumb = null;
let _cookie = null;
let _crumbAt = 0;
const CRUMB_TTL = 30 * 60 * 1000; /* نصف ساعة */

async function getCrumb() {
  if (_crumb && _cookie && Date.now() - _crumbAt < CRUMB_TTL) {
    return { crumb: _crumb, cookie: _cookie };
  }
  try {
    /* ① كوكي الموافقة */
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': UA },
      redirect: 'manual'
    });
    const setCookie = r1.headers.get('set-cookie') || '';
    const cookie = setCookie.split(',').map(s => s.split(';')[0].trim()).filter(Boolean).join('; ');
    if (!cookie) return { crumb: null, cookie: null };

    /* ② رمز crumb مقابل الكوكي */
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, Cookie: cookie }
    });
    const crumb = (await r2.text()).trim();
    if (!crumb || crumb.length > 40 || crumb.includes('<')) return { crumb: null, cookie };

    _crumb = crumb; _cookie = cookie; _crumbAt = Date.now();
    return { crumb, cookie };
  } catch {
    return { crumb: null, cookie: null };
  }
}

/**
 * يجلب مساراً من ياهو مع محاولات متدرّجة.
 * @param {string} path مثل `/v8/finance/chart/AAPL`
 * @param {object} params معاملات الاستعلام
 * @returns {Promise<object>} الجسم المُحلَّل JSON
 */
export async function yahooFetch(path, params = {}) {
  const qs = new URLSearchParams(params);
  const hosts = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

  let lastErr = 'لم تُنفَّذ أي محاولة';

  /* محاولة أولى بلا crumb — أسرع، وتكفي لأغلب النقاط */
  for (const host of hosts) {
    try {
      const rsp = await fetch(`${host}${path}?${qs}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      });
      if (rsp.ok) return await rsp.json();
      /* 401/403 غالباً تعني أن النقطة تطلب crumb — نكسر الحلقة ونجرّبه */
      if (rsp.status === 401 || rsp.status === 403) { lastErr = `ياهو أعاد ${rsp.status}`; break; }
      lastErr = `ياهو أعاد ${rsp.status}`;
    } catch (e) {
      lastErr = e.name === 'TimeoutError' ? 'انتهت مهلة الطلب إلى ياهو' : (e.message || 'تعذّر الاتصال بياهو');
    }
  }

  /* محاولة ثانية بالكوكي والـcrumb */
  const { crumb, cookie } = await getCrumb();
  if (crumb && cookie) {
    const qs2 = new URLSearchParams({ ...params, crumb });
    for (const host of hosts) {
      try {
        const rsp = await fetch(`${host}${path}?${qs2}`, {
          headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: cookie },
          signal: AbortSignal.timeout(10000)
        });
        if (rsp.ok) return await rsp.json();
        lastErr = `ياهو أعاد ${rsp.status} (مع crumb)`;
      } catch (e) {
        lastErr = e.name === 'TimeoutError' ? 'انتهت مهلة الطلب إلى ياهو' : (e.message || 'تعذّر الاتصال بياهو');
      }
    }
    /* الرمز صار قديماً — نُبطله ليُعاد جلبه في الطلب القادم */
    _crumb = null; _cookie = null;
  }

  const err = new Error(lastErr);
  err.upstream = true;
  throw err;
}

/** ترويسات موحّدة: تخزين مؤقت قصير يخفّف الضغط دون تقديم بيانات بائتة. */
export function setCache(res, seconds) {
  res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}
