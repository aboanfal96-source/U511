/* ══════════════════════════════════════════════════════════════════════
   مصادر بيانات الشموع — سلسلة بدائل مرتّبة
   ──────────────────────────────────────────────────────────────────────
   السبب في وجود أكثر من مصدر ليس الاحتياط النظري، بل واقع معروف:
   ياهو تحجب عناوين مراكز البيانات (AWS/Vercel وغيرها) بدرجات متفاوتة.
   نفس الطلب الذي ينجح من جهازك المنزلي قد يعود 401 أو 429 من دالة
   خادمية — ولا علاقة للكود بذلك إطلاقاً.

   لهذا كل مصدر هنا يعيد شكل استجابة ياهو نفسه (chart.result[0])، فتبقى
   الواجهة والمحلّل بلا تعديل، ويُضاف حقل _source ليعرف المستخدم من أين
   جاءت الأرقام فعلاً — وهذا ليس تفصيلاً تجميلياً: بيانات نهاية اليوم
   ليست كبيانات لحظية، والخلط بينهما يعطي إحساساً زائفاً بالحداثة.
   ══════════════════════════════════════════════════════════════════════ */

const { yfetch, UA } = require('./_yahoo');

/* ── المصدر ١: ياهو (الأفضل — لحظي بتأخير ١٥ دقيقة، وفيه أحجام صحيحة) ── */
async function fromYahoo(symbol, range, interval, useCrumb) {
  const sym = encodeURIComponent(symbol);
  const host = useCrumb ? 'query2' : 'query1';
  const out = await yfetch((crumb) => {
    const p = new URLSearchParams({ range, interval, includePrePost: 'false' });
    if (crumb) p.set('crumb', crumb);
    return `https://${host}.finance.yahoo.com/v8/finance/chart/${sym}?${p}`;
  }, { needCrumb: !!useCrumb });

  if (!out.ok) return { ok: false, error: out.error, status: out.status };
  if (!out.data?.chart?.result?.[0])
    return { ok: false, error: out.data?.chart?.error?.description || 'استجابة بلا شموع', status: 502 };
  return { ok: true, data: out.data, source: useCrumb ? 'yahoo-crumb' : 'yahoo' };
}

/* ── المصدر ٢: Stooq (احتياطي — يومي فقط، وقد يتأخّر جلسة كاملة) ──
   لا يتطلب مفتاحاً ولا كوكي، ونادراً ما يحجب مراكز البيانات. */
const RANGE_DAYS = { '1d': 5, '5d': 10, '1mo': 32, '3mo': 95, '6mo': 190, '1y': 370, '2y': 740, '5y': 1850, '10y': 3700, ytd: 370, max: 7300 };

async function fromStooq(symbol, range) {
  /* Stooq يستخدم لاحقة .us للأسهم الأمريكية، والمؤشرات لها رموز خاصة */
  const s = symbol.toLowerCase().replace(/^\^/, '');
  const candidates = symbol.startsWith('^') ? [`^${s}`, s] : [`${s}.us`];

  for (const cand of candidates) {
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(cand)}&i=d`;
    let text;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      text = await r.text();
    } catch { continue; }

    const lines = text.trim().split('\n');
    /* Stooq يعيد نصاً عادياً عند الرمز غير الموجود بدل رمز حالة خطأ */
    if (lines.length < 5 || !/^Date,/i.test(lines[0])) continue;

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const [d, o, h, l, c, v] = lines[i].split(',');
      const O = +o, H = +h, L = +l, C = +c;
      if (!isFinite(O) || !isFinite(C) || !isFinite(H) || !isFinite(L)) continue;
      /* منتصف نهار UTC: يضمن وقوع الطابع الزمني داخل اليوم الصحيح
         في كل المناطق الزمنية عند العرض */
      rows.push({ t: Math.floor(new Date(d + 'T12:00:00Z').getTime() / 1000), o: O, h: H, l: L, c: C, v: +v || 0 });
    }
    if (rows.length < 10) continue;

    const keep = RANGE_DAYS[range] || 95;
    const cut = rows.slice(-keep);
    const last = cut[cut.length - 1], prev = cut[cut.length - 2];

    return {
      ok: true,
      source: 'stooq',
      data: {
        chart: {
          result: [{
            meta: {
              symbol, currency: 'USD', regularMarketPrice: last.c,
              previousClose: prev ? prev.c : last.o, chartPreviousClose: prev ? prev.c : last.o
            },
            timestamp: cut.map(r => r.t),
            indicators: {
              quote: [{
                open: cut.map(r => r.o), high: cut.map(r => r.h),
                low: cut.map(r => r.l), close: cut.map(r => r.c), volume: cut.map(r => r.v)
              }]
            }
          }],
          error: null
        }
      }
    };
  }
  return { ok: false, error: 'Stooq لا يعرف هذا الرمز أو رفض الطلب' };
}

/** يجرّب المصادر بالترتيب ويعيد أول نجاح، مع سجلّ محاولات كامل. */
async function getCandles(symbol, range, interval) {
  const tried = [];
  const daily = interval === '1d';

  const steps = [
    () => fromYahoo(symbol, range, interval, false),
    () => fromYahoo(symbol, range, interval, true)
  ];
  /* Stooq يومي فقط — لا معنى لاستدعائه لفاصل ٥ دقائق */
  if (daily) steps.push(() => fromStooq(symbol, range));

  for (const step of steps) {
    let r;
    try { r = await step(); }
    catch (e) { r = { ok: false, error: e.message || 'استثناء غير متوقع' }; }
    if (r.ok) return { ...r, tried };
    tried.push(r.error);
  }
  return {
    ok: false,
    tried,
    error: daily
      ? `فشلت كل المصادر: ${tried.join(' | ')}`
      : `فشلت مصادر ياهو (${tried.join(' | ')}) — والفاصل ${interval} غير متاح في المصدر الاحتياطي، فالبديل اليومي فقط.`
  };
}

module.exports = { getCandles, fromYahoo, fromStooq };
