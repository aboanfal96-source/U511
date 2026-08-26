/* /api/health — تشخيص صريح: أي مصدر يعمل من هذا الخادم، وأيّها يُحجب.
   افتحه في المتصفح مباشرة عند ظهور «الأسعار تجريبية» — يجيب عن السؤال
   في طلب واحد بدل التخمين. */
const { fromYahoo, fromStooq } = require('./_sources');
const { getCrumb } = require('./_yahoo');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const sym = (req.query?.symbol || 'SPY').toUpperCase();
  const t0 = Date.now();
  const checks = {};

  const run = async (name, fn) => {
    const s = Date.now();
    try { const r = await fn(); checks[name] = { ok: !!r.ok, ms: Date.now() - s, error: r.ok ? null : r.error }; }
    catch (e) { checks[name] = { ok: false, ms: Date.now() - s, error: e.message }; }
  };

  await run('yahoo_chart', () => fromYahoo(sym, '5d', '1d', false));
  await run('yahoo_chart_crumb', () => fromYahoo(sym, '5d', '1d', true));
  await run('stooq_daily', () => fromStooq(sym, '1mo'));

  let crumb = null;
  try { const c = await getCrumb(); crumb = { cookie: !!c.cookie, crumb: !!c.crumb }; } catch (e) { crumb = { error: e.message }; }

  await run('yahoo_options', async () => {
    const { yfetch } = require('./_yahoo');
    const o = await yfetch((cr) => `https://query2.finance.yahoo.com/v7/finance/options/${sym}${cr ? '?crumb=' + encodeURIComponent(cr) : ''}`, { needCrumb: true });
    if (!o.ok) return o;
    return o.data?.optionChain?.result?.[0] ? { ok: true } : { ok: false, error: 'استجابة بلا سلسلة عقود' };
  });

  const candlesOK = checks.yahoo_chart.ok || checks.yahoo_chart_crumb.ok || checks.stooq_daily.ok;
  const verdict = !candlesOK
    ? 'لا يصل أي مصدر شموع من هذا الخادم — الأسعار ستبقى تجريبية.'
    : checks.yahoo_options.ok
      ? 'كل شيء يعمل: الشموع وسلسلة العقود.'
      : (checks.yahoo_chart.ok || checks.yahoo_chart_crumb.ok)
        ? 'الشموع تعمل، لكن سلسلة العقود محجوبة — تبويب الأوبشن لن يعمل، وبقية التبويبات ستعمل بأسعار حقيقية.'
        : 'الشموع تعمل عبر المصدر الاحتياطي (Stooq): بيانات نهاية اليوم فقط، بلا أوبشن.';

  return res.status(200).json({
    symbol: sym, node: process.version, region: process.env.VERCEL_REGION || null,
    totalMs: Date.now() - t0, yahooAuth: crumb, checks, verdict
  });
};
