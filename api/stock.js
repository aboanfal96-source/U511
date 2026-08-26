/* /api/stock — وكيل بيانات الشموع مع سلسلة مصادر بديلة.
   يعيد شكل استجابة ياهو دائماً، ويضيف _source ليُعرف مصدر الأرقام. */
const { getCandles } = require('./_sources');

const RANGES = new Set(['1d','5d','1mo','3mo','6mo','1y','2y','5y','10y','ytd','max']);
const INTERVALS = new Set(['1m','2m','5m','15m','30m','60m','90m','1h','1d','5d','1wk','1mo','3mo']);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { symbol, range = '3mo', interval = '1d' } = req.query || {};
  if (!symbol || !/^[A-Za-z0-9.\-^]{1,12}$/.test(symbol))
    return res.status(400).json({ error: 'رمز غير صالح' });
  if (!RANGES.has(range) || !INTERVALS.has(interval))
    return res.status(400).json({ error: 'نطاق أو فاصل زمني غير مدعوم' });

  const out = await getCandles(symbol.toUpperCase(), range, interval);
  if (!out.ok) return res.status(502).json({ error: out.error, tried: out.tried });

  res.setHeader('Cache-Control', 's-maxage=45, stale-while-revalidate=120');
  return res.status(200).json({ ...out.data, _source: out.source });
};
