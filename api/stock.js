/* /api/stock — وكيل بيانات الشموع (Yahoo v8 chart)
   يعمل من جهة الخادم، فلا حاجة لأي وسيط CORS خارجي. */
const { yfetch, setCors } = require('./_yahoo');

const RANGES = new Set(['1d','5d','1mo','3mo','6mo','1y','2y','5y','10y','ytd','max']);
const INTERVALS = new Set(['1m','2m','5m','15m','30m','60m','90m','1h','1d','5d','1wk','1mo','3mo']);

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { symbol, range = '3mo', interval = '1d' } = req.query || {};
  if (!symbol || !/^[A-Za-z0-9.\-^]{1,12}$/.test(symbol))
    return res.status(400).json({ error: 'رمز غير صالح' });
  if (!RANGES.has(range) || !INTERVALS.has(interval))
    return res.status(400).json({ error: 'نطاق أو فاصل زمني غير مدعوم' });

  const sym = encodeURIComponent(symbol.toUpperCase());
  const out = await yfetch(() =>
    `https://query1.finance.yahoo.com/v8/finance/chart/${sym}` +
    `?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplit`);

  if (!out.ok) return res.status(out.status).json({ error: out.error });

  /* تخزين قصير: الشموع اليومية لا تتغيّر كل ثانية، والمسح الشامل
     يطلب نفس الرمز أكثر من مرة في الجلسة الواحدة. */
  res.setHeader('Cache-Control', 's-maxage=45, stale-while-revalidate=120');
  return res.status(200).json(out.data);
};
