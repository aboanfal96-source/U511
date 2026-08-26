/* ══════════════════════════════════════════════════════════════════════
   /api/stock — شموع السهم
   يستدعيها loadStock() في الواجهة. تُعيد جسم ياهو كما هو (chart.result)
   لأن الواجهة تحلّله بنفسها في parseY، فلا داعي لإعادة تشكيله هنا.
   ══════════════════════════════════════════════════════════════════════ */
import { yahooFetch, setCache } from './_yahoo.js';

/* المدى والفاصل مقيّدان بقوائم بيضاء: المعامل يصل من العميل، وتمريره خاماً
   إلى الطلب الخارجي يفتح باباً لتوجيه طلبات لا نقصدها. */
const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);
const INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo']);

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').trim().toUpperCase();
  const range = String(req.query.range || '3mo');
  const interval = String(req.query.interval || '1d');

  /* رموز السوق الأمريكي: حروف وأرقام ونقطة وشرطة فقط (مثل BRK-B) */
  if (!symbol || !/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
    res.status(400).json({ error: 'رمز غير صالح' });
    return;
  }
  if (!RANGES.has(range) || !INTERVALS.has(interval)) {
    res.status(400).json({ error: 'مدى أو فاصل زمني غير مدعوم' });
    return;
  }

  try {
    const data = await yahooFetch(`/v8/finance/chart/${encodeURIComponent(symbol)}`, {
      range, interval, includePrePost: 'false'
    });

    if (!data?.chart?.result?.[0]) {
      const why = data?.chart?.error?.description || 'لا توجد بيانات لهذا الرمز';
      res.status(404).json({ error: why });
      return;
    }

    /* الشموع اليومية تتغيّر ببطء؛ دقيقة تخزين تكفي لتخفيف مسح 76 رمزاً
       دون أن تُظهر سعراً بائتاً بشكل مضلّل. */
    setCache(res, interval === '1d' ? 60 : 20);
    res.status(200).json(data);
  } catch (e) {
    res.status(e.upstream ? 502 : 500).json({ error: e.message || 'فشل غير معروف' });
  }
}
