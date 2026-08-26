/* /api/options — وكيل سلسلة عقود الأوبشن (Yahoo v7 options)
   ──────────────────────────────────────────────────────────────────
   بلا ?date  → يعيد أقرب استحقاق + قائمة كل تواريخ الاستحقاق.
   مع  ?date  → يعيد سلسلة ذلك الاستحقاق بالضبط (unix seconds).

   ⚠️ هذه النقطة تتطلب زوج كوكي/crumb من ياهو، وتُخنق بسرعة عند المسح
      المتلاحق. الطبقة الأمامية تُبطئ بين الرموز عمداً لهذا السبب. */
const { yfetch, setCors } = require('./_yahoo');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { symbol, date } = req.query || {};
  if (!symbol || !/^[A-Za-z0-9.\-^]{1,12}$/.test(symbol))
    return res.status(400).json({ error: 'رمز غير صالح' });
  if (date && !/^\d{9,12}$/.test(String(date)))
    return res.status(400).json({ error: 'تاريخ استحقاق غير صالح (المتوقع unix بالثواني)' });

  const sym = encodeURIComponent(symbol.toUpperCase());
  const out = await yfetch((crumb) => {
    const p = new URLSearchParams();
    if (date) p.set('date', String(date));
    if (crumb) p.set('crumb', crumb);
    const qs = p.toString();
    return `https://query2.finance.yahoo.com/v7/finance/options/${sym}${qs ? '?' + qs : ''}`;
  }, { needCrumb: true });

  if (!out.ok) return res.status(out.status).json({ error: out.error });

  const result = out.data?.optionChain?.result?.[0];
  if (!result)
    return res.status(404).json({ error: 'لا توجد عقود أوبشن مُدرجة لهذا الرمز' });

  /* سلسلة العقود تتحرّك خلال الجلسة — تخزين أقصر من الشموع. */
  res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=60');
  return res.status(200).json(out.data);
};
