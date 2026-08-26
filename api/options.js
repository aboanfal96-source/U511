/* ══════════════════════════════════════════════════════════════════════
   /api/options — سلسلة عقود الأوبشن
   يستدعيها optFetchChain() في الواجهة. تُعيد جسم ياهو كما هو
   (optionChain.result) لأن الواجهة تقرأ منه calls/puts/expirationDates.

   ⚠️ بيانات الأوبشن على المصادر المجانية متأخّرة ١٥ دقيقة، وفارق العرض
   والطلب يتحرّك أسرع بكثير. هذه النقطة تنقل ما يصلها بأمانة ولا تدّعي
   لحظية — والتحقق من السعر في منصة التنفيذ يبقى ضرورياً قبل أي أمر.
   ══════════════════════════════════════════════════════════════════════ */
import { yahooFetch, setCache } from './_yahoo.js';

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').trim().toUpperCase();
  const date = String(req.query.date || '').trim();

  if (!symbol || !/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
    res.status(400).json({ error: 'رمز غير صالح' });
    return;
  }
  /* تاريخ الاستحقاق يصل كطابع زمني يونكس بالثواني */
  if (date && !/^\d{9,11}$/.test(date)) {
    res.status(400).json({ error: 'تاريخ استحقاق غير صالح' });
    return;
  }

  try {
    const params = {};
    if (date) params.date = date;

    const data = await yahooFetch(`/v7/finance/options/${encodeURIComponent(symbol)}`, params);

    const result = data?.optionChain?.result?.[0];
    if (!result) {
      const why = data?.optionChain?.error?.description
        || 'لا توجد سلسلة عقود لهذا الرمز — قد يكون بلا أوبشن مُدرج';
      res.status(404).json({ error: why });
      return;
    }
    if (!result.options?.[0]) {
      res.status(404).json({ error: 'الاستجابة بلا عقود على هذا الاستحقاق' });
      return;
    }

    /* ٤٥ ثانية: أقصر من تأخّر المصدر (١٥ دقيقة) فلا تُضيف بياتاً يُذكر،
       وتكفي لمنع تكرار الطلب عند إعادة فتح نفس الرمز أثناء المسح. */
    setCache(res, 45);
    res.status(200).json(data);
  } catch (e) {
    res.status(e.upstream ? 502 : 500).json({ error: e.message || 'فشل غير معروف' });
  }
}
