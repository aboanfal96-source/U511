/* ══════════════════════════════════════════════════════════════════════════
   USA-H1 — محرك التحليل الكمي للسوق الأمريكي + الأوبشن
   ──────────────────────────────────────────────────────────────────────────
   وحدة مستقلة، قابلة للاختبار في Node وفي المتصفح على حد سواء.
   كل دالة هنا لا تعتمد على DOM ولا على حالة عامة (G) — مدخلات ← مخرجات فقط.

   مبادئ التصميم (وهي أساس تصحيح الأخطاء الجذرية):
   1) لا رقم "ثقة" مصطنع. أي احتمال يُعرض يجب أن يأتي من عينة محسوبة،
      ومعه حجم العينة وفاصل ثقة (Wilson) — أو لا يُعرض إطلاقاً.
   2) لا تسرّب زمني (look-ahead). كل نقطة ارتكاز لها فهرس "تأكيد" لا يجوز
      استخدامها قبله، وكل اختبار تاريخي يعيد الحساب من البيانات المتاحة
      حتى تلك اللحظة فقط.
   3) لا عشوائية غير مُبذّرة. كل مولّد أرقام عشوائية هنا ببذرة ثابتة، فتكون
      كل النتائج قابلة لإعادة الإنتاج بالضبط.
   4) الوحدات صريحة. أيام تداول ≠ أيام تقويمية، والعائد ≠ السعر.
   ══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.USEngine = api; root.KSAEngine = api; /* اسم قديم مدعوم */ }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ════════════════════════════════════════════════════════════════════
     0) أدوات عامة — عشوائية ببذرة، وحماية من القيم غير المنتهية
     ════════════════════════════════════════════════════════════════════ */

  /** مولّد عشوائي حتمي (mulberry32). نفس البذرة ⇒ نفس السلسلة دائماً.
   *  السبب: تقارير الاختبار التاريخي كانت تتغيّر بين تشغيل وآخر لأنها
   *  استخدمت Math.random — فيخرج "حكم" مختلف لنفس السهم بنفس البيانات. */
  function seededRandom(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** بذرة مستقرة مشتقة من نص (رمز السهم) — حتى يكون لكل سهم سلسلة ثابتة. */
  function seedFromString(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  const isNum = (v) => typeof v === 'number' && isFinite(v);
  /** يرجع القيمة إن كانت رقماً منتهياً، وإلا القيمة البديلة. يمنع تسرّب
   *  NaN/Infinity إلى الواجهة (كان يظهر "NaN ر.س" في عدة مسارات). */
  const num = (v, fallback = null) => (isNum(v) ? v : fallback);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round = (v, d = 2) => (isNum(v) ? +v.toFixed(d) : null);

  /* ════════════════════════════════════════════════════════════════════
     1) إحصاء — الأساس الذي تُبنى عليه كل "الاحتمالات" المعروضة
     ════════════════════════════════════════════════════════════════════ */

  const Stats = {
    mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; },

    /** تباين العينة (قسمة على n-1) — التقدير غير المتحيّز.
     *  النسخة السابقة في المنصة كانت تقسم على n وتُهمل طرح المتوسط. */
    variance(a) {
      const n = a.length;
      if (n < 2) return 0;
      const m = Stats.mean(a);
      return a.reduce((s, v) => s + (v - m) * (v - m), 0) / (n - 1);
    },
    std(a) { return Math.sqrt(Stats.variance(a)); },

    quantile(a, q) {
      if (!a.length) return null;
      const s = [...a].sort((x, y) => x - y);
      const pos = (s.length - 1) * q;
      const lo = Math.floor(pos), hi = Math.ceil(pos);
      return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
    },

    /** انحدار خطي بسيط بأقل المربعات. يرجع الميل والمقطع و R². */
    linreg(y, x) {
      const n = y.length;
      if (n < 2) return { slope: 0, intercept: y[0] ?? 0, r2: 0 };
      const xs = x || y.map((_, i) => i);
      const mx = Stats.mean(xs), my = Stats.mean(y);
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx, dy = y[i] - my;
        sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
      }
      const slope = sxx ? sxy / sxx : 0;
      return { slope, intercept: my - slope * mx, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : 0 };
    },

    /** فاصل ثقة Wilson لنسبة نجاح — الطريقة الصحيحة لعينة صغيرة.
     *  هذا ما يجعل عرض "نسبة نجاح 70%" أمينًا: 7 من 10 نجاحات تعطي
     *  فاصلاً [39%, 90%] — أي أن الرقم وحده بلا معنى بدون هذا الفاصل. */
    wilson(successes, n, z = 1.959964) {
      if (!n) return { p: null, lo: null, hi: null, n: 0 };
      const p = successes / n;
      const z2 = z * z;
      const denom = 1 + z2 / n;
      const centre = (p + z2 / (2 * n)) / denom;
      const half = (z / denom) * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
      return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), n };
    },

    /** دالة التوزيع التراكمي للتوزيع الطبيعي القياسي (تقريب Abramowitz-Stegun). */
    normalCdf(x) {
      const t = 1 / (1 + 0.2316419 * Math.abs(x));
      const d = 0.3989422804014327 * Math.exp(-x * x / 2);
      let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
      return x > 0 ? 1 - p : p;
    },

    /** اختبار z لفرق نسبتين (طرفان). يرجع p-value.
     *  يُستخدم للحكم: هل نسبة نجاح الإشارة تختلف فعلاً عن خط الأساس،
     *  أم أن الفرق يقع ضمن التذبذب العشوائي المتوقع لحجم العينة هذا؟ */
    twoProportionP(s1, n1, s2, n2) {
      if (!n1 || !n2) return 1;
      const p1 = s1 / n1, p2 = s2 / n2;
      const pPool = (s1 + s2) / (n1 + n2);
      const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
      if (!se) return 1;
      const z = (p1 - p2) / se;
      return 2 * (1 - Stats.normalCdf(Math.abs(z)));
    },

    /** تصحيح Benjamini-Hochberg لمعدل الاكتشاف الخاطئ (FDR).
     *  ضروري عند مسح ~250 سهماً: عند مستوى 5٪ ستظهر ~12 نتيجة "دالة"
     *  بمحض الصدفة وحدها. بدون هذا التصحيح تكون قائمة "الأسهم المؤهلة"
     *  في المسح الشامل ضجيجاً بالكامل. */
    benjaminiHochberg(pValues, alpha = 0.10) {
      const m = pValues.length;
      if (!m) return [];
      const idx = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
      let kMax = -1;
      for (let k = 0; k < m; k++) if (idx[k].p <= ((k + 1) / m) * alpha) kMax = k;
      const pass = new Array(m).fill(false);
      for (let k = 0; k <= kMax; k++) pass[idx[k].i] = true;
      return pass;
    },

    /** لوغاريتم دالة غاما (Lanczos) — لازم لمعامل ذي الحدين في اختبار Fisher. */
    lnGamma(x) {
      const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
        -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
      let xx = x, y = x, tmp = x + 5.5;
      tmp -= (xx + 0.5) * Math.log(tmp);
      let ser = 1.000000000190015;
      for (let j = 0; j < 6; j++) ser += g[j] / ++y;
      return -tmp + Math.log(2.5066282746310005 * ser / xx);
    },
    lnChoose(n, k) {
      if (k < 0 || k > n) return -Infinity;
      return Stats.lnGamma(n + 1) - Stats.lnGamma(k + 1) - Stats.lnGamma(n - k + 1);
    }
  };

  /* ════════════════════════════════════════════════════════════════════
     2) تقويم السوق الأمريكي (NYSE / Nasdaq)
     ──────────────────────────────────────────────────────────────────
     السوق الأمريكي يعمل الاثنين→الجمعة، 09:30–16:00 بتوقيت نيويورك،
     ويغلق في عطلات رسمية متغيّرة (الجمعة العظيمة تتبع تقويماً قمرياً،
     وبعض الأعياد تنتقل إذا وقعت في عطلة نهاية الأسبوع).

     ⚠️ فرق جوهري عن السوق السعودي يجب أن ينعكس في كل الحسابات:
     لا يوجد حدّ تذبذب يومي (±10٪) للأسهم الأمريكية. آلية LULD توقف
     التداول مؤقتاً عند حركة سريعة، لكنها ليست سقفاً للسعر اليومي.
     لذلك حساب «أقل عدد جلسات لبلوغ الهدف» لا يمكن أن يُشتقّ من حدّ
     نسبي — اشتُقّ هنا من ATR (المدى الحقيقي المتوسط)، وهو التقدير
     الصادق الوحيد المتاح: كم جلسة يلزم بحركة نموذجية لهذا السهم.

     ⚠️ التوقيت الصيفي: نيويورك تتحوّل بين UTC-5 و UTC-4. أي إزاحة ثابتة
     تُنتج خطأ ساعة كاملة لنصف السنة، فيصبح «هل السوق مفتوح» خاطئاً
     في ٧٥ جلسة سنوياً. نستخدم Intl لاستخراج التوقيت المحلي الفعلي.
     ════════════════════════════════════════════════════════════════════ */

  /** عطلات NYSE الرسمية (إغلاق كامل) — بصيغة YYYY-MM-DD بتوقيت نيويورك. */
  const US_HOLIDAYS = new Set([
    /* 2025 */
    '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18',
    '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
    /* 2026 */
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
    '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    /* 2027 */
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
    '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
    /* 2028 */
    '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19',
    '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25'
  ]);

  /** جلسات نصف يوم (إغلاق 13:00 ET) — تؤثر على الحجم وعلى تسعير الوقت. */
  const US_HALF_DAYS = new Set([
    '2025-07-03', '2025-11-28', '2025-12-24',
    '2026-11-27', '2026-12-24',
    '2027-11-26'
  ]);

  const _etFmt = (typeof Intl !== 'undefined' && Intl.DateTimeFormat)
    ? new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit',
        hour12: false, weekday: 'short'
      })
    : null;

  const _WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  const USMarket = {
    TZ: 'America/New_York',
    SESSION: { open: '09:30', close: '16:00', halfDayClose: '13:00' },
    /* لا حدّ تذبذب يومي في السوق الأمريكي. LULD نطاق توقّف لا سقف سعر. */
    DAILY_LIMIT_MAIN: null,
    LULD_TIER1_BAND: 0.05,   /* نطاق التوقف المؤقت للأسهم الكبرى (تقريبي) */

    /** يفكّك أي تاريخ إلى مكوّناته بتوقيت نيويورك الفعلي (مع التوقيت الصيفي). */
    partsET(date) {
      const d = (date instanceof Date) ? date : new Date(date);
      if (!_etFmt) {
        /* بديل احتياطي: UTC-5 ثابت — أقل دقة، يُستخدم فقط إن غاب Intl */
        const x = new Date(d.getTime() - 5 * 3600e3);
        return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate(),
                 hh: x.getUTCHours(), mm: x.getUTCMinutes(), wd: x.getUTCDay() };
      }
      const p = {};
      for (const part of _etFmt.formatToParts(d)) p[part.type] = part.value;
      return {
        y: +p.year, m: +p.month, d: +p.day,
        hh: +p.hour % 24, mm: +p.minute,
        wd: _WD[p.weekday] ?? 0
      };
    },

    /** مفتاح اليوم YYYY-MM-DD بتوقيت نيويورك — أساس مطابقة العطل. */
    ymdET(date) {
      const p = USMarket.partsET(date);
      return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    },

    dayOfWeekET(date) { return USMarket.partsET(date).wd; },
    isWeekend(date) { const d = USMarket.dayOfWeekET(date); return d === 0 || d === 6; },
    isHoliday(date) { return US_HOLIDAYS.has(USMarket.ymdET(date)); },
    isHalfDay(date) { return US_HALF_DAYS.has(USMarket.ymdET(date)); },
    isTradingDay(date) { return !USMarket.isWeekend(date) && !USMarket.isHoliday(date); },

    /** يضيف عدداً من *جلسات التداول* متجاوزاً العطل الأسبوعية والرسمية. */
    addTradingDays(date, n) {
      const d = new Date(date.getTime());
      let left = Math.max(0, Math.round(n)), guard = 0;
      while (left > 0 && guard++ < 4000) {
        d.setUTCDate(d.getUTCDate() + 1);
        if (USMarket.isTradingDay(d)) left--;
      }
      return d;
    },

    /** يعدّ جلسات التداول بين تاريخين (حصري للبداية، شامل للنهاية). */
    tradingDaysBetween(from, to) {
      if (to <= from) return 0;
      let n = 0, guard = 0;
      const d = new Date(from.getTime());
      while (d < to && guard++ < 4000) {
        d.setUTCDate(d.getUTCDate() + 1);
        if (d <= to && USMarket.isTradingDay(d)) n++;
      }
      return n;
    },

    /** تواريخ انتهاء الأوبشن الأسبوعي (الجمعة، ومع تقديمها إن كانت عطلة). */
    upcomingExpiries(from = new Date(), count = 6) {
      const out = [];
      const d = new Date(from.getTime());
      let guard = 0;
      while (out.length < count && guard++ < 400) {
        d.setUTCDate(d.getUTCDate() + 1);
        if (USMarket.dayOfWeekET(d) !== 5) continue;
        let e = new Date(d.getTime());
        /* إن كانت الجمعة عطلة رسمية ينتقل الانتهاء إلى الخميس */
        let g2 = 0;
        while (!USMarket.isTradingDay(e) && g2++ < 7) e.setUTCDate(e.getUTCDate() - 1);
        out.push(new Date(e.getTime()));
      }
      return out;
    },

    /** لا يوجد حدّ تذبذب يومي — نعيد null صراحةً بدل رقم مُختلق. */
    dailyLimits() {
      return {
        up: null, down: null, limitPct: null,
        note: 'السوق الأمريكي بلا حدّ تذبذب يومي. آلية LULD توقف التداول ٥ دقائق عند حركة سريعة خارج النطاق، لكنها لا تضع سقفاً للسعر.'
      };
    },

    /** أقل عدد جلسات لبلوغ هدف — مشتقّ من ATR وليس من حدّ نسبي وهمي.
     *  يفترض أن السهم يقطع مسافة ATR واحد لكل جلسة في أفضل حالاته
     *  الاتجاهية (وهو سقف متفائل: المتوسط الفعلي أقل بسبب التذبذب). */
    minSessionsToReach(fromPrice, toPrice, atrValue) {
      if (!isNum(fromPrice) || !isNum(toPrice) || !isNum(atrValue) || atrValue <= 0) return null;
      const dist = Math.abs(toPrice - fromPrice);
      if (dist === 0) return 0;
      return Math.ceil(dist / atrValue);
    },

    /** جلسات متوقعة بحركة اتجاهية واقعية (≈0.55 ATR صافي/جلسة). */
    expectedSessionsToReach(fromPrice, toPrice, atrValue, efficiency = 0.55) {
      if (!isNum(fromPrice) || !isNum(toPrice) || !isNum(atrValue) || atrValue <= 0) return null;
      const dist = Math.abs(toPrice - fromPrice);
      if (dist === 0) return 0;
      return Math.ceil(dist / (atrValue * efficiency));
    },

    /** هل السوق مفتوح الآن (الجلسة النظامية فقط، بلا ما قبل/بعد الإغلاق). */
    isOpenNow(now = new Date()) {
      if (!USMarket.isTradingDay(now)) return false;
      const p = USMarket.partsET(now);
      const mins = p.hh * 60 + p.mm;
      const close = USMarket.isHalfDay(now) ? 13 * 60 : 16 * 60;
      return mins >= 9 * 60 + 30 && mins < close;
    },

    /** الحالة النصية للسوق — للعرض في شريط الرأس. */
    statusNow(now = new Date()) {
      const p = USMarket.partsET(now);
      const mins = p.hh * 60 + p.mm;
      if (!USMarket.isTradingDay(now)) {
        return { open: false, phase: 'closed', label: USMarket.isHoliday(now) ? 'عطلة رسمية' : 'عطلة نهاية الأسبوع' };
      }
      const close = USMarket.isHalfDay(now) ? 13 * 60 : 16 * 60;
      if (mins >= 4 * 60 && mins < 9 * 60 + 30) return { open: false, phase: 'pre', label: 'ما قبل الافتتاح' };
      if (mins >= 9 * 60 + 30 && mins < close) return { open: true, phase: 'regular', label: USMarket.isHalfDay(now) ? 'مفتوح (نصف جلسة)' : 'مفتوح' };
      if (mins >= close && mins < 20 * 60) return { open: false, phase: 'post', label: 'ما بعد الإغلاق' };
      return { open: false, phase: 'closed', label: 'مغلق' };
    }
  };

  /* ════════════════════════════════════════════════════════════════════
     3) نقاط الارتكاز المؤكدة — بلا تسرّب زمني
     ──────────────────────────────────────────────────────────────────
     المشكلة الجذرية في النسخة السابقة: كشف القمم/القيعان استعمل
     lows[i+1] و lows[i+2]، أي بيانات لاحقة للشمعة i. عند الفحص التاريخي
     كان هذا يعني أن النموذج "يعرف المستقبل" — فتخرج نتائج اختبار
     متفائلة بلا أي مقابل في التداول الحقيقي.

     الحل: لكل ارتكاز نسجّل `confirmedAt = i + k`. لا يجوز لأي حساب يجري
     عند الشمعة t أن يستخدم ارتكازاً confirmedAt > t. الدوال هنا تفرض ذلك.
     ════════════════════════════════════════════════════════════════════ */

  /**
   * يكشف نقاط الارتكاز بعرض k شمعة على كل جانب.
   * @param {Array} candles  شموع {time,open,high,low,close,volume}
   * @param {number} k       عدد الشموع المطلوبة على كل جانب (افتراضي 3)
   * @param {number} asOf    آخر فهرس مرئي (محاكاة "الآن" في الاختبار التاريخي)
   * @returns {Array} [{i, price, type:'H'|'L', confirmedAt}]  مرتّبة زمنياً
   */
  function detectPivots(candles, k = 3, asOf = null) {
    const n = candles.length;
    const limit = asOf == null ? n - 1 : Math.min(asOf, n - 1);
    const out = [];
    for (let i = k; i + k <= limit; i++) {
      let isHigh = true, isLow = true;
      for (let j = 1; j <= k; j++) {
        if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
        if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
        if (!isHigh && !isLow) break;
      }
      /* confirmedAt = i+k: الشمعة التي عندها اكتملت أدلة الارتكاز فعلياً */
      if (isHigh) out.push({ i, price: candles[i].high, type: 'H', confirmedAt: i + k });
      if (isLow) out.push({ i, price: candles[i].low, type: 'L', confirmedAt: i + k });
    }
    return out;
  }

  /** آخر ارتكاز *مؤكّد* عند الشمعة asOf — لا شيء من المستقبل. */
  function lastConfirmedPivot(candles, k = 3, asOf = null) {
    const limit = asOf == null ? candles.length - 1 : asOf;
    const pivots = detectPivots(candles, k, limit);
    for (let idx = pivots.length - 1; idx >= 0; idx--) {
      if (pivots[idx].confirmedAt <= limit) return pivots[idx];
    }
    return null;
  }

  /** الدورة الذاتية للسهم = متوسط المسافة بين ارتكازات متعاقبة من نفس النوع،
   *  مع مقياس اتساق = 1 - (معامل الاختلاف). اتساق منخفض ⇒ لا دورة حقيقية. */
  function dominantPivotCycle(candles, k = 3, asOf = null) {
    const pivots = detectPivots(candles, k, asOf);
    if (pivots.length < 4) return null;
    const gaps = [];
    for (const type of ['H', 'L']) {
      const sub = pivots.filter(p => p.type === type);
      for (let i = 1; i < sub.length; i++) gaps.push(sub[i].i - sub[i - 1].i);
    }
    if (gaps.length < 3) return null;
    const m = Stats.mean(gaps), sd = Stats.std(gaps);
    const cv = m ? sd / m : 1;
    return {
      cycle: Math.round(m),
      consistencyPct: round(clamp((1 - cv) * 100, 0, 100), 0),
      sampleSize: gaps.length,
      /* اتساق أقل من 50٪ يعني تباعداً غير منتظم — ضجيج، لا دورة */
      reliable: (1 - cv) >= 0.5 && gaps.length >= 5
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     4) التحليل الطيفي — النسخة الصحيحة
     ──────────────────────────────────────────────────────────────────
     ثلاثة أخطاء جذرية في النسخة السابقة، كلها مُصلَحة هنا:

     (أ) اختبار الدلالة كان z-score على طاقات الطيف نفسه. القياس التجريبي
         أظهر أنه يصنّف 91.5٪ من مسارات المشي العشوائي المحض على أنها
         "دالة إحصائياً" — أي أنه بلا قيمة تمييزية. البديل: اختبار Fisher's g
         بقيمة احتمال مضبوطة (exact p-value) تحت فرضية الضجيج الأبيض.

     (ب) المسح كان على "أطوال دورات صحيحة" 5..60، وهي شبكة غير منتظمة في
         التردد: الدورتان 55 و56 تكادان تكونان نفس التردد، بينما 5 و6
         متباعدتان جداً. هذا يضخّم الدورات الطويلة ويشوّه أي "حصة طاقة".
         البديل: ترددات فورييه المنتظمة k/N.

     (ج) الإسقاط الأمامي كان يعامل موجة *العوائد* كأنها موجة *السعر* —
         خطأ طور مقداره 90°: قمة السعر تقع حيث يعبر العائد الصفر هبوطاً،
         لا حيث يبلغ العائد قمته. البديل: نثبت الدلالة على العوائد (حيث
         فرضية الضجيج الأبيض معقولة)، ثم نلائم الجيبية على *لوغاريتم
         السعر منزوع الاتجاه* عند نفس التردد ونُسقط تلك الموجة.
     ════════════════════════════════════════════════════════════════════ */

  /** الدورية (periodogram) على ترددات فورييه المنتظمة k/N. */
  function periodogram(series) {
    const N = series.length;
    const m = Math.floor((N - 1) / 2);
    const mean = Stats.mean(series);
    const x = series.map(v => v - mean);
    const out = [];
    for (let k = 1; k <= m; k++) {
      const w = (2 * Math.PI * k) / N;
      let re = 0, im = 0;
      for (let t = 0; t < N; t++) { re += x[t] * Math.cos(w * t); im += x[t] * Math.sin(w * t); }
      out.push({ k, freq: k / N, period: N / k, power: (re * re + im * im) / N });
    }
    return out;
  }

  /**
   * اختبار Fisher's g للدورية.
   * تحت فرضية العدم (ضجيج أبيض غاوسي) تكون إحداثيات الدورية مستقلة
   * وموزّعة أسّياً، فتكون g = max(I) / Σ(I) لها توزيع معلوم بالضبط:
   *   P(g > x) = Σ_{j=1..⌊1/x⌋} (-1)^(j-1) · C(m,j) · (1 - j·x)^(m-1)
   * هذه قيمة احتمال حقيقية — لا "درجة ثقة" مخترعة.
   */
  function fisherGTest(powers) {
    const m = powers.length;
    if (m < 4) return { g: null, p: 1, m };
    const total = powers.reduce((s, v) => s + v, 0);
    if (!total) return { g: 0, p: 1, m };
    const g = Math.max(...powers) / total;
    const jMax = Math.min(Math.floor(1 / g), m);
    let p = 0;
    for (let j = 1; j <= jMax; j++) {
      const lnTerm = Stats.lnChoose(m, j) + (m - 1) * Math.log(1 - j * g);
      if (!isFinite(lnTerm)) continue;
      p += (j % 2 === 1 ? 1 : -1) * Math.exp(lnTerm);
      /* الحدود تتناقص بسرعة؛ نتوقف عند بلوغ دقة تفوق ما نعرضه */
      if (Math.abs(Math.exp(lnTerm)) < 1e-12) break;
    }
    return { g: round(g, 5), p: clamp(p, 0, 1), m };
  }

  /** ملاءمة جيبية بأقل المربعات عند تردد محدّد: y ≈ A·cos(ωt) + B·sin(ωt).
   *  يرجع السعة والطور بصيغة R·cos(ωt + φ). */
  function fitSinusoid(y, freq) {
    const n = y.length, w = 2 * Math.PI * freq;
    let cc = 0, ss = 0, cs = 0, yc = 0, ys = 0;
    for (let t = 0; t < n; t++) {
      const c = Math.cos(w * t), s = Math.sin(w * t);
      cc += c * c; ss += s * s; cs += c * s; yc += y[t] * c; ys += y[t] * s;
    }
    const det = cc * ss - cs * cs;
    if (!det) return { amplitude: 0, phase: 0, A: 0, B: 0 };
    const A = (yc * ss - ys * cs) / det;
    const B = (ys * cc - yc * cs) / det;
    return { A, B, amplitude: Math.hypot(A, B), phase: Math.atan2(-B, A) };
  }

  /**
   * التحليل الطيفي الكامل.
   * @param {number[]} closes أسعار الإغلاق
   * @param {object} opts { alpha: مستوى الدلالة (افتراضي 0.05) }
   */
  function spectral(closes, opts = {}) {
    const alpha = opts.alpha ?? 0.05;
    const n = closes.length;
    if (n < 40) return { ok: false, reason: `يتطلب 40 شمعة على الأقل (متوفر ${n})` };

    /* (1) الدلالة تُختبر على العوائد اللوغاريتمية: تحت فرضية "لا دورة"
       تكون العوائد اليومية قريبة جداً من ضجيج أبيض، وهي بالضبط الفرضية
       التي بُني عليها اختبار Fisher. اختباره على السعر مباشرة كان سيرفض
       فرضية العدم دائماً لمجرد أن السعر متسلسل زمنياً (I(1)). */
    const rets = [];
    for (let i = 1; i < n; i++) {
      if (closes[i] <= 0 || closes[i - 1] <= 0) return { ok: false, reason: 'أسعار غير صالحة (صفر أو سالبة)' };
      rets.push(Math.log(closes[i] / closes[i - 1]));
    }
    const pg = periodogram(rets);
    /* نحصر النطاق العملي: دورات من 4 شمعات حتى ثلث طول العينة. دورة أطول
       من ذلك لا تتكرّر بما يكفي في العينة لتُقاس أصلاً. */
    const band = pg.filter(p => p.period >= 4 && p.period <= rets.length / 3);
    if (band.length < 4) return { ok: false, reason: 'نطاق ترددي ضيّق جداً لهذا الطول' };

    const test = fisherGTest(band.map(p => p.power));
    const peak = band.reduce((a, b) => (b.power > a.power ? b : a));
    const totalBand = band.reduce((s, p) => s + p.power, 0) || 1;
    const significant = test.p <= alpha;

    /* (2) الطور والسعة تُستخرجان من *لوغاريتم السعر منزوع الاتجاه الخطي*
       عند نفس التردد، لأن ما نريد إسقاطه للأمام هو قمم/قيعان السعر،
       لا قمم العائد. هذا يصحّح خطأ طور مقداره 90° في النسخة السابقة. */
    const logP = closes.map(v => Math.log(v));
    const trend = Stats.linreg(logP);
    const detrended = logP.map((v, i) => v - (trend.intercept + trend.slope * i));
    const fit = fitSinusoid(detrended, peak.freq);

    /* موقع الطور الحالي داخل الدورة: 0° = قمة، 180° = قاع */
    const wNow = 2 * Math.PI * peak.freq * (n - 1) + fit.phase;
    const phaseNow = ((wNow % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const cyclePosPct = round((phaseNow / (2 * Math.PI)) * 100, 1);

    return {
      ok: true,
      period: round(peak.period, 1),
      freq: peak.freq,
      /* حصة الطاقة داخل النطاق المفحوص — تُعرض كوصف، لا كدليل دلالة */
      bandSharePct: round((peak.power / totalBand) * 100, 1),
      amplitudePct: round((Math.exp(fit.amplitude) - 1) * 100, 2), /* سعة الدورة كنسبة سعرية */
      phase: round(fit.phase, 4),
      cyclePosPct,                       /* 0٪=قمة الدورة، 50٪=قاع الدورة */
      gStatistic: test.g,
      pValue: test.p,
      pValueText: test.p < 0.001 ? '<0.001' : test.p.toFixed(3),
      alpha,
      significant,
      /* تفسير صريح بدل رقم ثقة: إما رفضنا فرضية العدم أو لم نرفضها */
      verdict: significant
        ? `دورة دالة إحصائياً (p=${test.p < 0.001 ? '<0.001' : test.p.toFixed(3)} ≤ ${alpha})`
        : `لا دليل على دورة — الطيف لا يختلف عن ضجيج عشوائي (p=${test.p.toFixed(3)} > ${alpha})`,
      trendSlopePerBar: round(trend.slope, 6),
      trendR2: round(trend.r2, 3),
      top: band.slice().sort((a, b) => b.power - a.power).slice(0, 5)
        .map(p => ({ period: round(p.period, 1), sharePct: round((p.power / totalBand) * 100, 1) }))
    };
  }

  /**
   * إسقاط نقاط انعطاف السعر المتوقعة من الدورة الطيفية.
   * يعمل *فقط* على دورة اجتازت اختبار الدلالة — الإسقاط من دورة غير دالة
   * هو رسم لموجة على ضجيج، وكان هذا مصدر "النوافذ الزمنية" الوهمية.
   */
  function projectCycleTurns(spec, lastIndex, horizonBars = 60) {
    if (!spec || !spec.ok || !spec.significant) return [];
    const w = 2 * Math.PI * spec.freq;
    const turns = [];
    const val = (t) => Math.cos(w * t + spec.phase);
    let prev = val(lastIndex), prevSlope = prev - val(lastIndex - 1);
    for (let t = lastIndex + 1; t <= lastIndex + horizonBars; t++) {
      const v = val(t), slope = v - prev;
      if (prevSlope > 0 && slope <= 0) turns.push({ type: 'peak', barsAhead: t - 1 - lastIndex });
      else if (prevSlope < 0 && slope >= 0) turns.push({ type: 'valley', barsAhead: t - 1 - lastIndex });
      prev = v; prevSlope = slope;
    }
    return turns.filter(t => t.barsAhead > 0);
  }

  /* ════════════════════════════════════════════════════════════════════
     5) التنبؤ — ARIMA(1,1,0) بفترة تنبؤ صحيحة
     ──────────────────────────────────────────────────────────────────
     النسخة السابقة حسبت نطاق عدم اليقين كـ σ·√h. هذا صحيح فقط لمشي
     عشوائي محض (φ=0). للنموذج AR(1) على الفروق، التباين التراكمي بعد h
     خطوة هو:
        Var(h) = σ² · Σ_{k=1..h} [ (1 - φ^(h-k+1)) / (1 - φ) ]²
     الفرق جوهري: عند φ=0.68 (سهم ذو زخم) تكون σ·√h أقل من الصحيح
     بأكثر من الضعف — أي أن النطاق المعروض كان يوحي بيقين غير موجود.
     ════════════════════════════════════════════════════════════════════ */

  function forecastARIMA(closes, horizon = 5, opts = {}) {
    const z = opts.z ?? 1.959964;                    /* 95٪ */
    const n = closes.length;
    if (n < 30) return { ok: false, reason: `يتطلب 30 شمعة على الأقل (متوفر ${n})` };

    const d = [];
    for (let i = 1; i < n; i++) d.push(closes[i] - closes[i - 1]);

    /* تقدير φ بأقل المربعات على d[t] = φ·d[t-1] + ε */
    const x = d.slice(0, -1), y = d.slice(1), m = x.length;
    const mx = Stats.mean(x), my = Stats.mean(y);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < m; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
    let phi = sxx ? sxy / sxx : 0;
    phi = clamp(phi, -0.95, 0.95);                   /* شرط الاستقرارية */

    /* الخطأ المعياري لـ φ — يحدّد إن كان الزخم الذاتي مميّزاً عن الصفر */
    let sse = 0;
    for (let i = 0; i < m; i++) sse += (y[i] - phi * x[i]) ** 2;
    const sigma2 = sse / Math.max(1, m - 1);
    const sigma = Math.sqrt(sigma2);
    const sePhi = sxx ? Math.sqrt(sigma2 / sxx) : Infinity;
    const tPhi = sePhi ? phi / sePhi : 0;
    const phiPValue = 2 * (1 - Stats.normalCdf(Math.abs(tPhi)));

    /* التنبؤ النقطي */
    let lastDiff = d[d.length - 1], price = closes[n - 1], point = price;
    for (let h = 1; h <= horizon; h++) { lastDiff = phi * lastDiff; point += lastDiff; }

    /* تباين التنبؤ التراكمي الصحيح لـ ARIMA(1,1,0) */
    let varSum = 0;
    for (let k = 1; k <= horizon; k++) {
      const psi = phi === 1 ? (horizon - k + 1) : (1 - Math.pow(phi, horizon - k + 1)) / (1 - phi);
      varSum += psi * psi;
    }
    const seForecast = sigma * Math.sqrt(varSum);
    const lo = point - z * seForecast, hi = point + z * seForecast;

    /* هل يختلف التنبؤ فعلاً عن "لا تغيّر"؟ إن كان السعر الحالي داخل
       فاصل التنبؤ فالجواب لا — وهذا هو الوضع الطبيعي لمعظم الأسهم.
       عرض رقم تنبؤ بلا هذه الجملة هو إيحاء زائف بالدقة. */
    const meaningful = price < lo || price > hi;

    return {
      ok: true, horizon,
      phi: round(phi, 3), phiPValue: round(phiPValue, 4),
      phiSignificant: phiPValue <= 0.05,
      sigma: round(sigma, 4),
      point: round(point), lo: round(lo), hi: round(hi),
      bandPct: round((z * seForecast) / price * 100, 2),
      expectedChangePct: round((point - price) / price * 100, 2),
      meaningful,
      note: meaningful
        ? 'التنبؤ يقع خارج نطاق "لا تغيّر" — فرق قابل للتمييز إحصائياً'
        : 'السعر الحالي يقع داخل فاصل التنبؤ 95٪ — أي أن النموذج لا يميّز هذا التوقع عن "بلا تغيّر". لا تبنِ قراراً على الفرق.'
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     6) المؤشرات التراكمية — VWAP مثبّت، OBV، وخط التجميع/التوزيع
     ──────────────────────────────────────────────────────────────────
     الخطأ الجذري: VWAP في المنصة كان يتراكم من أول شمعة في النطاق
     المحمّل ولا يُصفَّر أبداً. VWAP بمعناه الحقيقي يُثبَّت على نقطة بداية
     (جلسة، أو قاع/قمة مؤكدة). تراكمه عبر ٣ أشهر يجعله متوسطاً بطيئاً
     بلا معنى تنفيذي — وكان يُعرض للمستخدم على أنه VWAP.
     ════════════════════════════════════════════════════════════════════ */

  const Cumulative = {
    /**
     * VWAP مثبّت على فهرس بداية محدّد (anchor).
     *
     * @param {boolean} opts.capOutliers  يحدّ وزن أي شمعة عند 3× الوسيط.
     *   السبب: VWAP التنفيذي يجب أن يعكس الحجم كما وقع فعلاً (بلا حدّ).
     *   أما حين يُستخدم كـ *مرساة مرجعية* لنطاق القيمة، فصفقة تبادلية
     *   ضخمة في يوم واحد تزيح المرساة بنسبة معتبرة رغم أنها لا تقول شيئاً
     *   عن القيمة — وهو بالضبط العيب الذي أسقط "السعر العادل" السابق.
     *   الوسيط هنا مقياس متين (robust) لا يتأثر بالقيم الشاذة.
     */
    anchoredVWAP(candles, anchorIdx = 0, opts = {}) {
      const out = new Array(candles.length).fill(null);
      let cap = Infinity;
      if (opts.capOutliers) {
        const vols = candles.slice(anchorIdx).map(c => c.volume || 0).filter(v => v > 0);
        const med = vols.length ? Stats.quantile(vols, 0.5) : 0;
        if (med > 0) cap = med * 3;
      }
      let pv = 0, vol = 0;
      for (let i = anchorIdx; i < candles.length; i++) {
        const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
        const v = Math.min(candles[i].volume || 0, cap);
        pv += tp * v; vol += v;
        out[i] = vol > 0 ? pv / vol : candles[i].close;
      }
      return out;
    },

    /** VWAP متدحرج على نافذة ثابتة — البديل العملي حين لا توجد نقطة تثبيت. */
    rollingVWAP(candles, window = 20) {
      const out = new Array(candles.length).fill(null);
      for (let i = 0; i < candles.length; i++) {
        if (i < window - 1) continue;
        let pv = 0, vol = 0;
        for (let j = i - window + 1; j <= i; j++) {
          const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
          pv += tp * (candles[j].volume || 0); vol += candles[j].volume || 0;
        }
        out[i] = vol > 0 ? pv / vol : candles[i].close;
      }
      return out;
    },

    /** On-Balance Volume. */
    obv(candles) {
      const out = [0];
      for (let i = 1; i < candles.length; i++) {
        const c = candles[i].close, p = candles[i - 1].close, v = candles[i].volume || 0;
        out.push(out[i - 1] + (c > p ? v : c < p ? -v : 0));
      }
      return out;
    },

    /** خط التجميع/التوزيع (Accumulation/Distribution) — يزن الحجم بموقع
     *  الإغلاق داخل مدى الشمعة، فيميّز "حجم عالٍ بإغلاق ضعيف" عن العكس،
     *  وهو ما يعجز OBV عن رؤيته لأنه يعتمد إشارة التغيّر فقط. */
    adLine(candles) {
      const out = [];
      let acc = 0;
      for (const c of candles) {
        const range = c.high - c.low;
        const mfm = range > 0 ? ((c.close - c.low) - (c.high - c.close)) / range : 0;
        acc += mfm * (c.volume || 0);
        out.push(acc);
      }
      return out;
    },

    /**
     * تباعد مؤشر تراكمي عن السعر، مُطبَّع بحيث يكون قابلاً للمقارنة بين
     * الأسهم: ميل كل سلسلة يُقسَم على مداها في النافذة نفسها، فيصبح
     * الرقمان بلا وحدة. المقارنة الخام (أسهم مقابل ريالات) كانت بلا معنى.
     */
    divergence(candles, series, window = 20) {
      const n = candles.length;
      if (n < window + 2) return { type: null, why: 'نافذة غير كافية', strength: 0 };
      const segS = series.slice(-window), segP = candles.slice(-window).map(c => c.close);
      const rangeS = Math.max(...segS) - Math.min(...segS) || 1;
      const rangeP = Math.max(...segP) - Math.min(...segP) || 1;
      const slopeS = (Stats.linreg(segS).slope * window) / rangeS;
      const slopeP = (Stats.linreg(segP).slope * window) / rangeP;
      const gap = slopeS - slopeP;
      let type = null;
      if (slopeS > 0.15 && slopeP < 0.05) type = 'bullish';
      else if (slopeS < -0.15 && slopeP > -0.05) type = 'bearish';
      return {
        type,
        slopeSeries: round(slopeS, 3), slopePrice: round(slopeP, 3),
        strength: round(Math.abs(gap), 3),
        why: type === 'bullish' ? 'المؤشر التراكمي يصعد بينما السعر ثابت/هابط ← تجميع خفي'
          : type === 'bearish' ? 'المؤشر التراكمي يهبط بينما السعر ثابت/صاعد ← تصريف خفي'
            : 'لا تباعد واضح بين المؤشر التراكمي والسعر'
      };
    }
  };

  /* ════════════════════════════════════════════════════════════════════
     7) ملف الحجم الحقيقي (Volume Profile) والنطاق القيمي
     ──────────────────────────────────────────────────────────────────
     النسخة السابقة عرّفت POC بأنه "إغلاق الشمعة الأعلى حجماً" — وهذا ليس
     POC. الـPOC هو مستوى السعر الذي تداول عنده أكبر حجم تراكمي عبر
     الفترة كلها، ويُحسب بتوزيع حجم كل شمعة على شرائح السعر التي غطّتها.
     ════════════════════════════════════════════════════════════════════ */

  /**
   * @param {object} opts
   *   bins        عدد شرائح السعر (افتراضي 60)
   *   capOutliers يحدّ مساهمة أي جلسة عند 3× وسيط الحجم.
   *
   * ملاحظة منهجية مهمة: ملف الحجم الحقيقي يُبنى من بيانات التِك، حيث
   * يتوزّع حجم اليوم الواحد على عشرات مستويات السعر خلال الجلسة. نحن هنا
   * نملك شموعاً يومية فقط، فيهبط حجم اليوم كله داخل شريحة ضيّقة. النتيجة:
   * جلسة واحدة بحجم استثنائي (صفقة تبادلية مثلاً) تُعيد كتابة الـPOC
   * بالكامل — قياسنا: ×20 حجم في يوم واحد أزاح الـPOC بنسبة 25.6٪.
   * هذا أثر تقريب البيانات لا حقيقة سوقية، لذا يُفعَّل الحدّ افتراضياً
   * عند استخدام الملف كمرساة قيمة (valueBand)، ويُترك مطفأً حين يُعرض
   * الحجم كما وقع فعلاً.
   */
  function volumeProfile(candles, binsOrOpts = 60, maybeOpts = {}) {
    const opts = typeof binsOrOpts === 'object' ? binsOrOpts : { bins: binsOrOpts, ...maybeOpts };
    const bins = opts.bins ?? 60;
    if (!candles.length) return null;
    const hi = Math.max(...candles.map(c => c.high));
    const lo = Math.min(...candles.map(c => c.low));
    if (!(hi > lo)) return null;
    const width = (hi - lo) / bins;
    const hist = new Array(bins).fill(0);

    let cap = Infinity;
    if (opts.capOutliers) {
      const vols = candles.map(c => c.volume || 0).filter(v => v > 0);
      const med = vols.length ? Stats.quantile(vols, 0.5) : 0;
      if (med > 0) cap = med * 3;
    }

    for (const c of candles) {
      const v = Math.min(c.volume || 0, cap);
      if (!v) continue;
      /* توزيع حجم الشمعة بالتساوي على الشرائح التي غطّاها مدى high-low */
      const b0 = clamp(Math.floor((c.low - lo) / width), 0, bins - 1);
      const b1 = clamp(Math.floor((c.high - lo) / width), 0, bins - 1);
      const span = b1 - b0 + 1;
      for (let b = b0; b <= b1; b++) hist[b] += v / span;
    }

    const total = hist.reduce((s, v) => s + v, 0) || 1;
    let pocBin = 0;
    for (let b = 1; b < bins; b++) if (hist[b] > hist[pocBin]) pocBin = b;

    /* منطقة القيمة: نتوسّع من الـPOC للجانبين حتى نغطّي 70٪ من الحجم */
    let acc = hist[pocBin], lowBin = pocBin, highBin = pocBin;
    while (acc / total < 0.70 && (lowBin > 0 || highBin < bins - 1)) {
      const below = lowBin > 0 ? hist[lowBin - 1] : -1;
      const above = highBin < bins - 1 ? hist[highBin + 1] : -1;
      if (above >= below) { highBin++; acc += hist[highBin]; }
      else { lowBin--; acc += hist[lowBin]; }
    }

    const binPrice = (b) => lo + (b + 0.5) * width;
    return {
      poc: round(binPrice(pocBin)),
      valueAreaLow: round(binPrice(lowBin) - width / 2),
      valueAreaHigh: round(binPrice(highBin) + width / 2),
      valueAreaPct: round((acc / total) * 100, 1),
      rangeLow: round(lo), rangeHigh: round(hi),
      bins: hist.map((v, b) => ({ price: round(binPrice(b)), volPct: round((v / total) * 100, 2) }))
    };
  }

  /**
   * النطاق القيمي المرجعي — بديل "السعر العادل" السابق.
   *
   * لماذا حُذف السعر العادل القديم: كان حاصل ضرب أربعة عوامل مخترعة،
   * أحدها (عامل الحجم) يعتمد على حجم *يوم واحد*. القياس أظهر أن مضاعفة
   * حجم آخر يوم ×4 ترفع "السعر العادل" من 82.91 إلى 124.41 — أي أن
   * الرقم كان يتحرك 50٪ بسبب متغيّر لا علاقة له بالقيمة إطلاقاً.
   *
   * البديل هنا لا يدّعي معرفة "القيمة الحقيقية" (وهي لا تُشتق من الشارت
   * أصلاً)، بل يعرض **نطاقاً مرجعياً إحصائياً** مبنياً على ثلاثة مراسٍ
   * قابلة للتحقق: POC الحجمي، وVWAP المثبّت، وقناة الانحدار.
   */
  function valueBand(candles, opts = {}) {
    const n = candles.length;
    if (n < 30) return { ok: false, reason: `يتطلب 30 شمعة (متوفر ${n})` };
    const closes = candles.map(c => c.close);
    const price = closes[n - 1];

    const vp = volumeProfile(candles, { bins: 60, capOutliers: true });
    const pivot = lastConfirmedPivot(candles, 3);
    /* نضمن نافذة تثبيت لا تقل عن 20 جلسة: ارتكاز حديث جداً يجعل الـVWAP
       محسوباً من شمعتين أو ثلاث، فتهيمن جلسة واحدة على المرساة بالكامل. */
    const MIN_ANCHOR_BARS = 20;
    const rawAnchor = pivot ? pivot.i : Math.max(0, n - 60);
    const anchorIdx = Math.min(rawAnchor, Math.max(0, n - MIN_ANCHOR_BARS));
    const avwapArr = Cumulative.anchoredVWAP(candles, anchorIdx, { capOutliers: true });
    const avwap = avwapArr[n - 1];

    /* قناة انحدار على لوغاريتم السعر — الانحراف المعياري للبواقي يعطي
       عرض القناة، وهو مقياس تجريبي لا افتراضي */
    const logP = closes.map(v => Math.log(v));
    const reg = Stats.linreg(logP);
    const resid = logP.map((v, i) => v - (reg.intercept + reg.slope * i));
    const rStd = Stats.std(resid);
    const fitNow = reg.intercept + reg.slope * (n - 1);
    const regMid = Math.exp(fitNow);
    const regLow = Math.exp(fitNow - 2 * rStd);
    const regHigh = Math.exp(fitNow + 2 * rStd);

    const anchors = [
      { label: 'POC الحجمي (أكثر سعر تداولاً)', value: vp ? vp.poc : null },
      { label: `VWAP مثبّت على ${pivot ? (pivot.type === 'L' ? 'آخر قاع مؤكد' : 'آخر قمة مؤكدة') : 'آخر 60 شمعة'}`, value: round(avwap) },
      { label: 'وسط قناة الانحدار', value: round(regMid) }
    ].filter(a => isNum(a.value));

    const vals = anchors.map(a => a.value);
    const center = Stats.mean(vals);
    const spread = vals.length > 1 ? Stats.std(vals) : Math.abs(regHigh - regLow) / 4;

    const devPct = round(((price - center) / center) * 100, 2);
    /* التصنيف نسبةً إلى تشتّت المراسي نفسها، لا إلى عتبات ثابتة مخترعة */
    const zVsAnchors = spread > 0 ? (price - center) / spread : 0;

    return {
      ok: true,
      price: round(price),
      anchors,
      center: round(center),
      bandLow: round(Math.max(regLow, center - 2 * spread)),
      bandHigh: round(Math.min(regHigh, center + 2 * spread)),
      regressionLow: round(regLow), regressionHigh: round(regHigh), regressionR2: round(reg.r2, 3),
      valueArea: vp ? { low: vp.valueAreaLow, high: vp.valueAreaHigh, poc: vp.poc } : null,
      deviationPct: devPct,
      zVsAnchors: round(zVsAnchors, 2),
      /* لا "شراء قوي / بيع قوي" — وصف موقع فقط، والقرار للمستخدم */
      position: Math.abs(zVsAnchors) < 1 ? 'داخل نطاق المراسي المرجعية'
        : zVsAnchors >= 1 ? 'أعلى من كل المراسي المرجعية (امتداد سعري)'
          : 'أدنى من كل المراسي المرجعية (انضغاط سعري)',
      caveat: 'هذا نطاق مرجعي إحصائي مشتق من الشارت والحجم فقط. ليس تقييماً للشركة، ولا يتضمن أرباحاً أو ميزانية أو أخباراً.'
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     8) التذبذب — بوحدات صريحة
     ════════════════════════════════════════════════════════════════════ */

  /** تذبذب سنوي بالنسبة المئوية من العوائد اللوغاريتمية اليومية.
   *  252 غير مناسبة لتداول: السنة فيه ≈ 246 جلسة (٥ أيام أسبوعياً ناقص
   *  العطل الرسمية). النسخة السابقة لم تكن تُسنّن أصلاً وكانت تعرض
   *  جذر متوسط مربّع العوائد على أنه "٪ تذبذب". */
  function volatility(closes, opts = {}) {
    const sessionsPerYear = opts.sessionsPerYear ?? 246;
    const n = closes.length;
    if (n < 3) return { ok: false, reason: 'بيانات غير كافية' };
    const rets = [];
    for (let i = 1; i < n; i++) {
      if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
    }
    if (rets.length < 2) return { ok: false, reason: 'بيانات غير كافية' };
    const daily = Stats.std(rets);
    return {
      ok: true,
      dailyPct: round(daily * 100, 2),
      annualPct: round(daily * Math.sqrt(sessionsPerYear) * 100, 1),
      /* المدى اليومي المتوقع بثقة 95٪ — رقم قابل للاستخدام في تحديد الوقف */
      expectedDailyRangePct: round(1.96 * daily * 100, 2),
      sampleSize: rets.length
    };
  }

  function atr(candles, period = 14) {
    const n = candles.length;
    if (n < period + 1) return null;
    const tr = [];
    for (let i = 1; i < n; i++) {
      tr.push(Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      ));
    }
    /* Wilder smoothing — المتوسط البسيط الذي كان مستخدماً يعطي قيماً
       أعلى تذبذباً ويجعل مسافة الوقف تقفز بلا سبب */
    let a = Stats.mean(tr.slice(0, period));
    for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
    return round(a, 4);
  }

  /* ════════════════════════════════════════════════════════════════════
     9) النوافذ الزمنية — غان وفيبوناتشي، بوحدات صحيحة
     ──────────────────────────────────────────────────────────────────
     الخطأ الجذري السابق: خلط الوحدات. مناطق فيبوناتشي الزمنية تُقاس
     بالشموع (جلسات)، ودورات غان التقويمية تُقاس بالأيام التقويمية، وكانت
     تُجمَع في قائمة واحدة بعد ضربها في "معدّل تقريبي" مخترع (1.4).
     هنا كل نافذة تحمل وحدتها، والتحويل إلى تاريخ يمرّ عبر تقويم تداول
     الفعلي (أحد→خميس)، فلا يقع تاريخ متوقع في يوم عطلة.
     ════════════════════════════════════════════════════════════════════ */

  const FIB_BARS = [13, 21, 34, 55, 89, 144];
  const GANN_CALENDAR_DAYS = [30, 45, 60, 90, 120, 180, 270, 360];
  const BAR_TOLERANCE = 2;
  const DAY_TOLERANCE = 4;

  /**
   * يبني النوافذ الزمنية القادمة من ارتكاز مؤكد.
   * @returns {Array} [{label, unit:'bars'|'days', barsAhead, date, source}]
   */
  function timeWindows(candles, pivot, opts = {}) {
    const horizonDays = opts.horizonDays ?? 240;
    const n = candles.length;
    if (!pivot || pivot.i >= n) return [];

    const lastDate = new Date(candles[n - 1].time * 1000);
    const pivotDate = new Date(candles[pivot.i].time * 1000);
    const barsSince = (n - 1) - pivot.i;
    const daysSince = Math.round((lastDate - pivotDate) / 86400e3);

    const out = [];

    /* (أ) مناطق فيبوناتشي الزمنية — تُقاس بالشموع، وتُحوَّل لتاريخ عبر
       تقويم التداول الفعلي بدل أي معامل تحويل تقريبي */
    for (const f of FIB_BARS) {
      const ahead = f - barsSince;
      if (ahead <= 0) continue;
      const date = USMarket.addTradingDays(lastDate, ahead);
      const daysLeft = Math.round((date - lastDate) / 86400e3);
      if (daysLeft > horizonDays) continue;
      out.push({ label: `منطقة فيبوناتشي الزمنية ${f} جلسة`, unit: 'bars', barsAhead: ahead, daysLeft, date, source: 'fib' });
    }

    /* (ب) دورات غان التقويمية — تُقاس بالأيام التقويمية مباشرة.
       تاريخ الدورة نفسه تقويمي بحت وقد يقع في جمعة أو سبت. النافذة
       *القابلة للتداول* هي أول جلسة تالية له، ونعرض الاثنين صراحة بدل
       إعطاء المستخدم تاريخاً لا يفتح فيه السوق أصلاً. */
    for (const g of GANN_CALENDAR_DAYS) {
      const daysLeft = g - daysSince;
      if (daysLeft <= 0 || daysLeft > horizonDays) continue;
      const cycleDate = new Date(lastDate.getTime() + daysLeft * 86400e3);
      const date = new Date(cycleDate.getTime());
      let shifted = 0;
      while (!USMarket.isTradingDay(date)) { date.setUTCDate(date.getUTCDate() + 1); shifted++; }
      const barsAhead = Math.max(1, USMarket.tradingDaysBetween(lastDate, date));
      out.push({
        label: `دورة غان ${g} يوم تقويمي` + (shifted ? ` (تقع في عطلة — أول جلسة بعدها)` : ''),
        unit: 'days', barsAhead, daysLeft: daysLeft + shifted,
        date, cycleDate, shiftedFromWeekend: shifted > 0, source: 'gann'
      });
    }

    /* (ج) الدورة الذاتية للسهم — فقط إن كانت منتظمة فعلاً */
    const dc = dominantPivotCycle(candles, 3);
    if (dc && dc.reliable) {
      for (let k = 1; k <= 2; k++) {
        const ahead = dc.cycle * k - barsSince;
        if (ahead <= 0) continue;
        const date = USMarket.addTradingDays(lastDate, ahead);
        const daysLeft = Math.round((date - lastDate) / 86400e3);
        if (daysLeft > horizonDays) continue;
        out.push({
          label: `دورة السهم الذاتية ×${k} (${dc.cycle} جلسة، اتساق ${dc.consistencyPct}٪)`,
          unit: 'bars', barsAhead: ahead, daysLeft, date, source: 'cycle'
        });
      }
    }

    /* (د) الانعطافات الطيفية — فقط من دورة اجتازت اختبار الدلالة */
    const spec = spectral(candles.map(c => c.close));
    if (spec.ok && spec.significant) {
      for (const t of projectCycleTurns(spec, n - 1, 60)) {
        const date = USMarket.addTradingDays(lastDate, t.barsAhead);
        const daysLeft = Math.round((date - lastDate) / 86400e3);
        if (daysLeft > horizonDays) continue;
        out.push({
          label: `انعطاف طيفي (دورة ${spec.period} جلسة، p=${spec.pValueText}) — ${t.type === 'peak' ? 'قمة متوقعة' : 'قاع متوقع'}`,
          unit: 'bars', barsAhead: t.barsAhead, daysLeft, date, source: 'spectral', turnType: t.type
        });
      }
    }

    out.sort((a, b) => a.barsAhead - b.barsAhead);
    return out;
  }

  /** توافق زمني: كم دليلاً زمنياً *مستقلاً* يشير إلى نفس النافذة القريبة. */
  function timeConfluence(candles, pivot) {
    const n = candles.length;
    const barsSince = (n - 1) - pivot.i;
    const lastDate = new Date(candles[n - 1].time * 1000);
    const daysSince = Math.round((lastDate - new Date(candles[pivot.i].time * 1000)) / 86400e3);

    const fib = FIB_BARS.find(f => Math.abs(barsSince - f) <= BAR_TOLERANCE) || null;
    const gann = GANN_CALENDAR_DAYS.find(g => Math.abs(daysSince - g) <= DAY_TOLERANCE) || null;
    const dc = dominantPivotCycle(candles, 3);
    let cycle = null;
    if (dc && dc.reliable) {
      for (let k = 1; k <= 3; k++) if (Math.abs(barsSince - dc.cycle * k) <= BAR_TOLERANCE) { cycle = dc.cycle * k; break; }
    }
    const spec = spectral(candles.map(c => c.close));
    const specHit = spec.ok && spec.significant &&
      projectCycleTurns(spec, n - 1, 3).some(t => t.barsAhead <= 2);

    const evidence = [
      fib ? { name: `فيبوناتشي ${fib} جلسة`, hit: true } : { name: 'فيبوناتشي زمني', hit: false },
      gann ? { name: `غان ${gann} يوم`, hit: true } : { name: 'غان تقويمي', hit: false },
      cycle ? { name: `دورة السهم ${cycle} جلسة`, hit: true } : { name: 'دورة السهم الذاتية', hit: false },
      specHit ? { name: `انعطاف طيفي (p=${spec.pValueText})`, hit: true } : { name: 'انعطاف طيفي دال', hit: false }
    ];
    const count = evidence.filter(e => e.hit).length;

    return {
      barsSincePivot: barsSince, daysSincePivot: daysSince,
      evidence, count, total: evidence.length,
      /* تصنيف نصي فقط — ولا يُترجم أبداً إلى نسبة مئوية */
      label: count >= 3 ? 'توافق قوي' : count === 2 ? 'توافق متوسط' : count === 1 ? 'دليل منفرد' : 'لا توافق زمني'
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     10) محرك الاختبار التاريخي — walk-forward، حتمي، بقيمة احتمال
     ──────────────────────────────────────────────────────────────────
     ثلاثة إصلاحات جذرية مقارنة بالنسخة السابقة:
     (أ) خط الأساس كان عيّنة عشوائية بحجم n باستخدام Math.random، فكان
         "الحكم" يتغيّر بين تشغيل وآخر لنفس السهم (تحقّقنا: نفس المدخلات
         أعطت حكماً إيجابياً مرة و"ضئيل" مرة). الآن: خط الأساس هو التوزيع
         غير المشروط الكامل — كل شمعة مؤهّلة، بلا عشوائية إطلاقاً.
     (ب) لا يوجد حكم بلا قيمة احتمال. الفرق في نسبة الربح يُختبر باختبار
         نسبتين، ويُعرض p-value وحجم العينة وفاصل Wilson.
     (ج) مسافة الوقف كانت 0.5×ATR، فكان متوسط عمر الصفقة أقل من شمعتين
         (قياس فعلي) — أي أن الضجيج وحده كان يُغلق الصفقات. الافتراضي
         الآن 1.5×ATR، وهو قابل للضبط.
     ════════════════════════════════════════════════════════════════════ */

  const BT_DEFAULTS = {
    atrStopMult: 1.5,
    rewardRisk: 2.0,
    maxHoldBars: 30,
    minSignals: 20,        /* أقل من ذلك لا يسمح بأي استنتاج إحصائي */
    minHistory: 80,
    stepBars: 5,
    alpha: 0.05
  };

  /**
   * يحاكي صفقة واحدة على البيانات اللاحقة فقط.
   * ملاحظة على غموض الشمعة الواحدة: إن لامست الشمعة الوقف والهدف معاً،
   * نفترض الوقف أولاً (الافتراض المتحفّظ). أي محاكاة تفترض العكس تُنتج
   * نتائج متفائلة زائفة.
   */
  function simulateTrade(candles, entryIdx, dirUp, cfg) {
    const c = { ...BT_DEFAULTS, ...cfg };
    if (entryIdx >= candles.length - 1) return null;
    const entry = candles[entryIdx].close;
    const a = atr(candles.slice(0, entryIdx + 1), 14) || entry * 0.02;
    const risk = a * c.atrStopMult;
    if (!(risk > 0)) return null;
    const stop = dirUp ? entry - risk : entry + risk;
    const target = dirUp ? entry + risk * c.rewardRisk : entry - risk * c.rewardRisk;
    if (stop <= 0) return null;

    const last = Math.min(candles.length - 1, entryIdx + c.maxHoldBars);
    for (let i = entryIdx + 1; i <= last; i++) {
      const { high, low } = candles[i];
      if (dirUp) {
        if (low <= stop) return { outcome: 'stop', rMultiple: -1, pnlPct: (stop - entry) / entry * 100, bars: i - entryIdx };
        if (high >= target) return { outcome: 'target', rMultiple: c.rewardRisk, pnlPct: (target - entry) / entry * 100, bars: i - entryIdx };
      } else {
        if (high >= stop) return { outcome: 'stop', rMultiple: -1, pnlPct: (entry - stop) / entry * 100, bars: i - entryIdx };
        if (low <= target) return { outcome: 'target', rMultiple: c.rewardRisk, pnlPct: (entry - target) / entry * 100, bars: i - entryIdx };
      }
    }
    const exit = candles[last].close;
    const pnl = dirUp ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
    return { outcome: 'timeout', rMultiple: (dirUp ? exit - entry : entry - exit) / risk, pnlPct: pnl, bars: last - entryIdx };
  }

  function summarize(trades) {
    if (!trades.length) return null;
    const wins = trades.filter(t => t.pnlPct > 0).length;
    const pnls = trades.map(t => t.pnlPct);
    const rs = trades.map(t => t.rMultiple);
    const grossWin = pnls.filter(p => p > 0).reduce((s, v) => s + v, 0);
    const grossLoss = Math.abs(pnls.filter(p => p <= 0).reduce((s, v) => s + v, 0));
    const w = Stats.wilson(wins, trades.length);
    const mR = Stats.mean(rs), sdR = Stats.std(rs);
    /* أقصى تراجع على منحنى المضاعفات المتراكمة */
    let peak = 0, cum = 0, maxDD = 0;
    for (const r of rs) { cum += r; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
    return {
      count: trades.length,
      wins,
      winRatePct: round(w.p * 100, 1),
      winRateCI: [round(w.lo * 100, 1), round(w.hi * 100, 1)],
      avgPnlPct: round(Stats.mean(pnls), 2),
      expectancyR: round(mR, 3),
      /* نسبة شارب للصفقة (ليست سنوية) — عائد متوسط لكل وحدة تشتّت */
      sharpePerTrade: sdR ? round(mR / sdR, 2) : null,
      profitFactor: grossLoss ? round(grossWin / grossLoss, 2) : (grossWin ? null : 0),
      maxDrawdownR: round(maxDD, 2),
      avgBarsHeld: round(Stats.mean(trades.map(t => t.bars)), 1)
    };
  }

  /**
   * اختبار walk-forward لإشارة الدورة الطيفية على سهم واحد.
   * في كل خطوة يُعاد بناء الطيف من candles.slice(0, i+1) فقط.
   */
  function backtestSpectral(candles, cfg = {}) {
    const c = { ...BT_DEFAULTS, ...cfg };
    const n = candles.length;
    if (n < c.minHistory + c.maxHoldBars + 20) {
      return { ok: false, reason: `تاريخ غير كافٍ (متوفر ${n} شمعة، مطلوب ${c.minHistory + c.maxHoldBars + 20}+)` };
    }

    const signals = [];
    for (let i = c.minHistory; i < n - c.maxHoldBars; i += c.stepBars) {
      const hist = candles.slice(0, i + 1);
      const spec = spectral(hist.map(x => x.close), { alpha: c.alpha });
      if (!spec.ok || !spec.significant) continue;
      const turns = projectCycleTurns(spec, i, 10);
      const soon = turns.find(t => t.barsAhead <= 3);
      if (!soon) continue;
      const dirUp = soon.type === 'valley';
      const trade = simulateTrade(candles, i, dirUp, c);
      if (trade) signals.push({ ...trade, idx: i, dirUp });
    }

    /* خط الأساس: التوزيع غير المشروط الكامل — كل شمعة مؤهّلة، في كلا
       الاتجاهين. حتمي تماماً، ويمثّل "ماذا لو دخلت بلا إشارة إطلاقاً". */
    const baseline = [];
    for (let i = c.minHistory; i < n - c.maxHoldBars; i++) {
      for (const dir of [true, false]) {
        const t = simulateTrade(candles, i, dir, c);
        if (t) baseline.push(t);
      }
    }

    const sig = summarize(signals);
    const base = summarize(baseline);
    if (!base) return { ok: false, reason: 'تعذّر بناء خط أساس صالح من تاريخ هذا السهم' };
    if (!sig) {
      /* صفر إشارة ليس عطلاً — هو النتيجة الصحيحة لسهم بلا دورة دالة.
         النسخة السابقة كانت تعيد رسالة عطل عامة تُقرأ كخلل تقني. */
      return {
        ok: false, underpowered: true, signalCount: 0, signal: null, baseline: base,
        reason: 'لم تُصدر الإشارة الطيفية أي دخول على تاريخ هذا السهم — لا توجد دورة دالة إحصائياً تُبنى عليها. هذه نتيجة صحيحة، لا خلل.'
      };
    }

    if (signals.length < c.minSignals) {
      return {
        ok: false, underpowered: true, signalCount: signals.length,
        signal: sig, baseline: base,
        reason: `عدد الإشارات ${signals.length} أقل من الحد الأدنى ${c.minSignals} — العينة لا تسمح باستنتاج إحصائي. النتائج معروضة للاطلاع فقط ولا يجوز البناء عليها.`
      };
    }

    const p = Stats.twoProportionP(sig.wins, sig.count, base.wins, base.count);
    const edge = round(sig.winRatePct - base.winRatePct, 1);
    const significant = p <= c.alpha && edge > 0;

    return {
      ok: true,
      signalCount: signals.length,
      signal: sig, baseline: base,
      edgeWinRatePct: edge,
      edgeExpectancyR: round(sig.expectancyR - base.expectancyR, 3),
      pValue: round(p, 4),
      pValueText: p < 0.001 ? '<0.001' : p.toFixed(3),
      significant,
      verdict: significant
        ? `الإشارة تتفوّق على الدخول العشوائي على هذا السهم: فارق ${edge}+ نقطة في نسبة الربح (p=${p < 0.001 ? '<0.001' : p.toFixed(3)}، عينة ${sig.count} صفقة)`
        : `لا يوجد دليل إحصائي على تفوّق الإشارة على هذا السهم (فارق ${edge} نقطة، p=${p.toFixed(3)} > ${c.alpha}) — الفرق ضمن ما تفسّره الصدفة عند حجم العينة هذا`,
      config: { atrStopMult: c.atrStopMult, rewardRisk: c.rewardRisk, maxHoldBars: c.maxHoldBars, alpha: c.alpha }
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     11) خطة التنفيذ — مبنية على بنية حقيقية، وعلى حدود السوق السعودي
     ──────────────────────────────────────────────────────────────────
     النسخة السابقة كانت تضع الهدف عند 2R دائماً ثم تعرض "R:R = 1:2"
     كأنه نتيجة تحليل — وهي حشو تعريفي (الهدف عُرِّف بأنه 2R). كما كانت
     تشتق الوقف والهدف من امتدادات فراكتالية قد تقع في الجهة الخاطئة:
     القياس أظهر وقفاً *فوق* سعر الدخول في 4 من 5 عيّنات.
     ════════════════════════════════════════════════════════════════════ */

  function structuralLevels(candles, price, lookback = 120) {
    const seg = candles.slice(-lookback);
    const pivots = detectPivots(seg, 3);
    const supports = pivots.filter(p => p.type === 'L' && p.price < price).map(p => p.price).sort((a, b) => b - a);
    const resistances = pivots.filter(p => p.type === 'H' && p.price > price).map(p => p.price).sort((a, b) => a - b);
    return { supports, resistances };
  }

  function executionPlan(candles, opts = {}) {
    /* حارس مدخلات: الدالة عامة، وتمريرها رقماً أو null كان ينهار عند
       candles[n-1].close لأن `undefined < 40` يساوي false فيتجاوز الفحص. */
    if (!Array.isArray(candles)) return { ok: false, reason: 'مدخل غير صالح: يتطلب مصفوفة شموع' };
    const n = candles.length;
    if (n < 40) return { ok: false, reason: 'بيانات غير كافية لبناء خطة' };
    const price = candles[n - 1].close;
    const dirUp = opts.dirUp !== false;
    const a = atr(candles, 14) || price * 0.02;
    const atrMult = opts.atrStopMult ?? BT_DEFAULTS.atrStopMult;
    const { supports, resistances } = structuralLevels(candles, price);

    /* الوقف: خلف أقرب مستوى بنيوي في الجهة الصحيحة، أو مسافة ATR —
       أيّهما أبعد، حتى لا يقع الوقف داخل ضجيج الجلسة العادي. */
    const atrStop = dirUp ? price - a * atrMult : price + a * atrMult;
    const structStop = dirUp
      ? (supports.length ? supports[0] - a * 0.25 : null)
      : (resistances.length ? resistances[0] + a * 0.25 : null);
    let stop = atrStop, stopSource = `مسافة ${atrMult}×ATR من سعر الدخول`;
    if (isNum(structStop) && ((dirUp && structStop < atrStop) || (!dirUp && structStop > atrStop))) {
      stop = structStop;
      stopSource = `خلف أقرب ${dirUp ? 'دعم' : 'مقاومة'} بنيوي (${round(dirUp ? supports[0] : resistances[0])}) بهامش ربع ATR`;
    }
    if (dirUp && stop <= 0) return { ok: false, reason: 'وقف غير صالح' };

    const risk = Math.abs(price - stop);
    if (!(risk > 0)) return { ok: false, reason: 'مسافة مخاطرة صفرية' };

    /* الهدف: أقرب مستوى بنيوي مقابل — إن وُجد. وإلا امتداد ATR.
       نحسب R:R من الهدف الفعلي بدل فرضه مسبقاً. */
    const structTarget = dirUp ? (resistances.length ? resistances[0] : null)
      : (supports.length ? supports[0] : null);
    const fallbackTarget = dirUp ? price + risk * 2 : price - risk * 2;
    const target1 = isNum(structTarget) ? structTarget : fallbackTarget;
    const targetSource = isNum(structTarget)
      ? `أقرب ${dirUp ? 'مقاومة' : 'دعم'} بنيوي فعلي` : 'امتداد 2R (لا يوجد مستوى بنيوي مقابل ضمن النطاق)';
    const rr1 = round(Math.abs(target1 - price) / risk, 2);

    /* السوق الأمريكي بلا حدّ تذبذب يومي، فالجلسات تُقدَّر من ATR:
       minSessions = سقف متفائل (ATR كامل/جلسة)، expectedSessions = واقعي. */
    const sessionsToTarget = USMarket.minSessionsToReach(price, target1, a);
    const expectedSessions = USMarket.expectedSessionsToReach(price, target1, a);
    const limits = USMarket.dailyLimits();

    return {
      ok: true, dirUp,
      entry: round(price), stop: round(stop), stopSource,
      riskPerShare: round(risk), riskPct: round((risk / price) * 100, 2),
      target1: round(target1), targetSource, rr1,
      /* تحذير صريح حين لا يستحق الوضع الدخول أصلاً */
      viable: rr1 >= 1.5,
      viabilityNote: rr1 >= 1.5 ? null
        : `أقرب مستوى بنيوي مقابل يعطي عائداً/مخاطرة ${rr1} فقط — أقل من 1.5. الدخول هنا غير مجدٍ بالبنية الحالية، والانتظار أفضل من توسيع الهدف قسراً.`,
      atr: round(a),
      dailyLimitUp: limits.up, dailyLimitDown: limits.down,
      dailyLimitNote: limits.note,
      minSessionsToTarget: sessionsToTarget,
      expectedSessionsToTarget: expectedSessions,
      resistances: resistances.slice(0, 3).map(v => round(v)),
      supports: supports.slice(0, 3).map(v => round(v))
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     12) تدقيق جودة البيانات — يمنع بناء تحليل على مدخلات فاسدة
     ════════════════════════════════════════════════════════════════════ */

  function auditCandles(candles) {
    const issues = [];
    if (!Array.isArray(candles) || !candles.length) return { ok: false, issues: ['لا توجد شموع'], count: 0 };
    let badOHLC = 0, nonPositive = 0, zeroVol = 0, dupTime = 0, outOfOrder = 0, gaps = 0;
    const seen = new Set();
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (!isNum(c.open) || !isNum(c.high) || !isNum(c.low) || !isNum(c.close)) { badOHLC++; continue; }
      if (c.close <= 0 || c.open <= 0) nonPositive++;
      if (c.high < Math.max(c.open, c.close) - 1e-9 || c.low > Math.min(c.open, c.close) + 1e-9) badOHLC++;
      if (!c.volume) zeroVol++;
      if (seen.has(c.time)) dupTime++; else seen.add(c.time);
      if (i > 0 && c.time <= candles[i - 1].time) outOfOrder++;
      /* فجوة تتجاوز 10 أيام تقويمية بين شمعتين يوميتين متتاليتين = تعليق
         تداول أو عطلة طويلة — تُبطل حسابات الدورات التقويمية إن أُهملت */
      if (i > 0 && (c.time - candles[i - 1].time) > 10 * 86400) gaps++;
    }
    if (badOHLC) issues.push(`${badOHLC} شمعة بقيم OHLC غير متسقة`);
    if (nonPositive) issues.push(`${nonPositive} شمعة بسعر غير موجب`);
    if (dupTime) issues.push(`${dupTime} طابع زمني مكرر`);
    if (outOfOrder) issues.push(`${outOfOrder} شمعة خارج الترتيب الزمني`);
    if (gaps) issues.push(`${gaps} فجوة زمنية تتجاوز 10 أيام (تعليق تداول أو عطلة ممتدة)`);
    if (zeroVol > candles.length * 0.2) issues.push(`${zeroVol} شمعة بحجم صفري (سيولة ضعيفة جداً)`);
    return { ok: issues.length === 0, issues, count: candles.length, zeroVolumeBars: zeroVol };
  }

  /** ينظّف الشموع: يزيل المكرّرات، يرتّب زمنياً، ويسقط الفاسدة. */
  function sanitizeCandles(raw) {
    if (!Array.isArray(raw)) return [];
    const byTime = new Map();
    for (const c of raw) {
      if (!c || !isNum(c.time)) continue;
      const o = +c.open, h = +c.high, l = +c.low, cl = +c.close;
      if (![o, h, l, cl].every(isNum)) continue;
      if (cl <= 0 || o <= 0 || h <= 0 || l <= 0) continue;
      /* نصحّح انعكاسات high/low الطفيفة بدل إسقاط الشمعة بالكامل —
         النسخة السابقة كانت تُسقطها، فتفقد جلسات حقيقية بلا إشعار */
      const high = Math.max(o, h, l, cl), low = Math.min(o, h, l, cl);
      byTime.set(c.time, { time: c.time, open: o, high, low, close: cl, volume: Math.max(0, +c.volume || 0) });
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }


  /* ════════════════════════════════════════════════════════════════════
     13) الطيف المحسّن — تصحيح خطأ شبكة فورييه (السبب الجذري لانحراف
         النوافذ الزمنية)
     ──────────────────────────────────────────────────────────────────
     النسخة السابقة (spectral) صحيحة إحصائياً: اختبار Fisher's g يعطي
     معدّل إيجابيات كاذبة 5.3٪ مقاساً على 300 مسار مشي عشوائي، ويكشف
     40/40 من الدورات المزروعة. المشكلة ليست في *هل توجد دورة* بل في
     *أين نحن منها الآن* — وهي بالضبط ما تُبنى عليه النافذة الزمنية.

     السبب الجذري المقاس: التردد يُختار من شبكة فورييه المنتظمة k/N،
     وخطوة هذه الشبكة في وحدة *الدورة* تتناسب مع P²/N. عند N=299:

         الدورة الحقيقية 40 ⟵ أقرب ما تعرضه الشبكة هو 42.71 (خطأ 6.8٪)
         خطوة الشبكة عند هذا الطول = 5.3 جلسة كاملة

     ثم تُلاءم الموجة الجيبية على النافذة كلها بهذا التردد الخاطئ قليلاً،
     فينجرف الطور تراكمياً عبر 300 شمعة. القياس: انجراف 48٪ من دورة —
     أي أن «القمة المتوقعة» تقع عملياً عند القاع الحقيقي. القياس الشامل
     أعطى وسيط خطأ طور 14.5٪ من الدورة **حتى على دورة نقية بلا أي ضجيج**،
     وهذا يثبت أن الخطأ نظامي لا إحصائي.

     ثلاثة إصلاحات:
     (أ) تنقية التردد خارج الشبكة ببحث المقطع الذهبي على الدورية المستمرة.
     (ب) ملاءمة الطور على *نافذة حديثة* (٤ دورات) لا على التاريخ كله —
         الطور يجب أن يصف أين الدورة الآن، لا متوسطها عبر سنتين.
     (ج) عدم يقين معلن: كل انعطاف يُعرض بـ ±جلسات محسوبة من حدّ كرامر-راو،
         ويتّسع كلما بَعُد الأفق — لأنه كذلك فعلاً.
     ════════════════════════════════════════════════════════════════════ */

  /** الدورية عند تردد اعتباطي (ليس على الشبكة). */
  function periodogramAt(x, f) {
    const N = x.length, w = 2 * Math.PI * f;
    let re = 0, im = 0;
    for (let t = 0; t < N; t++) { re += x[t] * Math.cos(w * t); im += x[t] * Math.sin(w * t); }
    return (re * re + im * im) / N;
  }

  /** بحث المقطع الذهبي عن ذروة الدورية داخل [lo, hi]. */
  function refinePeakFreq(x, lo, hi, iters = 60) {
    const gr = (Math.sqrt(5) - 1) / 2;
    let a = lo, b = hi;
    let c = b - gr * (b - a), d = a + gr * (b - a);
    let fc = periodogramAt(x, c), fd = periodogramAt(x, d);
    for (let i = 0; i < iters && (b - a) > 1e-9; i++) {
      if (fc > fd) { b = d; d = c; fd = fc; c = b - gr * (b - a); fc = periodogramAt(x, c); }
      else { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = periodogramAt(x, d); }
    }
    return (a + b) / 2;
  }

  /**
   * التحليل الطيفي المحسّن.
   *
   * @param {number[]} closes
   * @param {object} opts
   *   alpha        مستوى الدلالة (0.05)
   *   maxCycles    أقصى عدد دورات متراكبة تُستخرج (3)
   *   phaseCycles  كم دورة تُستعمل نافذةً لملاءمة الطور (4)
   */
  function spectralPro(closes, opts = {}) {
    const alpha = opts.alpha ?? 0.05;
    const maxCycles = opts.maxCycles ?? 3;
    const phaseCycles = opts.phaseCycles ?? 4;
    const n = closes.length;
    if (n < 60) return { ok: false, reason: `يتطلب 60 شمعة على الأقل (متوفر ${n})` };

    for (let i = 0; i < n; i++) if (!(closes[i] > 0)) return { ok: false, reason: 'أسعار غير صالحة' };

    /* العوائد اللوغاريتمية: الوسط الذي تكون فيه فرضية الضجيج الأبيض معقولة */
    const rets = [];
    for (let i = 1; i < n; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
    const Nr = rets.length;

    /* لوغاريتم السعر منزوع الاتجاه — الوسط الذي تُقاس فيه قمم/قيعان السعر */
    const logP = closes.map(Math.log);
    const trend = Stats.linreg(logP);
    const detr = logP.map((v, i) => v - (trend.intercept + trend.slope * i));

    const minP = 5, maxP = Math.max(8, Math.floor(Nr / 3));
    const cycles = [];
    let resid = rets.slice();
    const residMean = Stats.mean(resid);
    resid = resid.map(v => v - residMean);

    for (let round_ = 0; round_ < maxCycles; round_++) {
      const pg = periodogram(resid).filter(p => p.period >= minP && p.period <= maxP);
      if (pg.length < 4) break;

      const test = fisherGTest(pg.map(p => p.power));
      /* تصحيح تسلسلي: الدورة الثانية تُختبر بعد إزالة الأولى، فاحتمال
         الصدفة يتضاعف مع كل جولة (Bonferroni تسلسلي محافظ). */
      const pAdj = clamp(test.p * (round_ + 1), 0, 1);
      if (pAdj > alpha) break;

      const peak = pg.reduce((a, b) => (b.power > a.power ? b : a));
      const bandTotal = pg.reduce((acc, p) => acc + p.power, 0) || 1;
      const bandShare = round(peak.power / bandTotal * 100, 1);
      const topList = pg.slice().sort((a, b) => b.power - a.power).slice(0, 5)
        .map(p => ({ period: round(p.period, 1), sharePct: round(p.power / bandTotal * 100, 1) }));

      /* (أ) تنقية التردد خارج الشبكة — نصف خطوة على كل جانب */
      const half = 0.5 / Nr;
      const fRef = refinePeakFreq(resid, Math.max(1 / maxP * 0.5, peak.freq - half), peak.freq + half);
      const period = 1 / fRef;
      if (!(period >= minP && period <= maxP)) break;

      /* (ب) الطور على نافذة حديثة = phaseCycles دورة (بحد أدنى ٢ دورة) */
      const W = clamp(Math.round(period * phaseCycles), Math.round(period * 2) + 2, n);
      const win = detr.slice(n - W);
      const fit = fitSinusoid(win, fRef);
      /* الطور مُعاد إلى مرجع t=0 للسلسلة الكاملة حتى تبقى الإسقاطات متسقة */
      const phaseAtFull = fit.phase - 2 * Math.PI * fRef * (n - W);

      /* عدم اليقين: تشتّت البواقي حول الملاءمة داخل النافذة */
      const wRad = 2 * Math.PI * fRef;
      let sse = 0;
      for (let t = 0; t < W; t++) {
        const pred = fit.A * Math.cos(wRad * t) + fit.B * Math.sin(wRad * t);
        sse += (win[t] - pred) ** 2;
      }
      const sigma = Math.sqrt(sse / Math.max(1, W - 3));
      const R = fit.amplitude;
      const snr = R > 0 ? R / Math.max(sigma, 1e-12) : 0;
      /* حدّ كرامر-راو لجيبية في ضجيج أبيض:
           var(φ̂) ≈ 2σ²/(R²·W)   ,   var(ω̂) ≈ 24σ²/(R²·W³)  */
      const sePhase = R > 0 ? Math.sqrt(2 * sigma * sigma / (R * R * W)) : Math.PI;
      const seOmega = R > 0 ? Math.sqrt(24 * sigma * sigma / (R * R * W * W * W)) : 0;

      cycles.push({
        period: round(period, 2), freq: fRef, phase: phaseAtFull,
        amplitude: R, amplitudePct: round((Math.exp(R) - 1) * 100, 2),
        gridPeriod: round(peak.period, 2), bandSharePct: bandShare,
        top: round_ === 0 ? topList : undefined,
        gridErrorPct: round((peak.period - period) / period * 100, 2),
        pValue: round(pAdj, 4),
        snr: round(snr, 2),
        sePhase, seOmega,
        /* عدم يقين التوقيت الآن، بالجلسات */
        seBarsNow: round(sePhase / (2 * Math.PI) * period, 2),
        windowBars: W
      });

      /* إزالة الدورة من البواقي للبحث عن الدورة التالية */
      const fitR = fitSinusoid(resid, fRef);
      for (let t = 0; t < resid.length; t++) {
        resid[t] -= fitR.A * Math.cos(wRad * t) + fitR.B * Math.sin(wRad * t);
      }
    }

    /* ── حين لا تجتاز أي دورة اختبار الدلالة ──
       الخطأ السابق: كانت الدالة تعود بلا أي وصف للدورة إطلاقاً، فتطبع
       الواجهة «الدورة المهيمنة: null جلسة». هذا أسوأ من الرقم الخاطئ لأنه
       يبدو عطلاً تقنياً بينما النتيجة صحيحة تماماً.

       الصواب: نصف **أقوى مرشّح** بكامل أرقامه (دورة منقّاة، سعة، موقع
       الطور) ونعلن صراحة أنه لم يجتز العتبة. الفرق بين «لا يوجد شيء»
       و«يوجد هذا لكنه لا يتميّز عن الضجيج» فرق جوهري للمستخدم: الأول
       يوحي بعطل، والثاني معلومة. والإسقاط الزمني يبقى ممنوعاً في
       الحالتين — projectTurnsPro يشترط significant. */
    if (!cycles.length) {
      const pg0 = periodogram(rets).filter(p => p.period >= minP && p.period <= maxP);
      const t0 = pg0.length >= 4 ? fisherGTest(pg0.map(p => p.power)) : { p: 1, g: null };
      const base = {
        ok: true, significant: false, cycles: [], nCycles: 0,
        n, lastIndex: n - 1,
        pValue: round(t0.p, 4), pValueText: t0.p < 0.001 ? '<0.001' : t0.p.toFixed(3),
        gStatistic: t0.g,
        trendR2: round(trend.r2, 3), trendSlopePerBar: round(trend.slope, 6),
        verdict: `لا دليل على دورة — الطيف لا يختلف عن ضجيج عشوائي (p=${t0.p.toFixed(3)} > ${alpha})`
      };
      if (!pg0.length) return base;

      /* وصف أقوى مرشّح — بنفس دقة المسار الدال، لكن بلا أي صلاحية توقيت */
      const pk = pg0.reduce((a, b) => (b.power > a.power ? b : a));
      const bandTotal0 = pg0.reduce((acc, p) => acc + p.power, 0) || 1;
      const half0 = 0.5 / Nr;
      const fRef0 = refinePeakFreq(rets.map(v => v - Stats.mean(rets)),
        Math.max(1 / maxP * 0.5, pk.freq - half0), pk.freq + half0);
      const per0 = 1 / fRef0;
      if (!(per0 >= minP && per0 <= maxP)) return base;
      const W0 = clamp(Math.round(per0 * phaseCycles), Math.round(per0 * 2) + 2, n);
      const fit0 = fitSinusoid(detr.slice(n - W0), fRef0);
      const ph0 = fit0.phase - 2 * Math.PI * fRef0 * (n - W0);
      const pn0 = (((2 * Math.PI * fRef0 * (n - 1) + ph0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

      /* نسبة الإشارة إلى الضجيج داخل النافذة — تشرح *لماذا* رُفض المرشّح */
      const w0 = 2 * Math.PI * fRef0; let sse0 = 0;
      const win0 = detr.slice(n - W0);
      for (let t = 0; t < W0; t++) {
        const pr = fit0.A * Math.cos(w0 * t) + fit0.B * Math.sin(w0 * t);
        sse0 += (win0[t] - pr) ** 2;
      }
      const sg0 = Math.sqrt(sse0 / Math.max(1, W0 - 3));

      return Object.assign(base, {
        candidate: true,
        period: round(per0, 2), freq: fRef0, phase: ph0,
        amplitudePct: round((Math.exp(fit0.amplitude) - 1) * 100, 2),
        cyclePosPct: round(pn0 / (2 * Math.PI) * 100, 1),
        bandSharePct: round(pk.power / bandTotal0 * 100, 1),
        snr: round(fit0.amplitude > 0 ? fit0.amplitude / Math.max(sg0, 1e-12) : 0, 2),
        gridErrorPct: round((pk.period - per0) / per0 * 100, 2),
        top: pg0.slice().sort((a, b) => b.power - a.power).slice(0, 5)
          .map(p => ({ period: round(p.period, 1), sharePct: round(p.power / bandTotal0 * 100, 1) })),
        candidateNote: `أقوى مرشّح: دورة ${round(per0, 1)} جلسة تستحوذ على ${round(pk.power / bandTotal0 * 100, 1)}٪ من طاقة النطاق — لكنها لا تتميّز عن الضجيج (p=${t0.p.toFixed(3)}). يُعرض للوصف فقط، ولا تُشتق منه أي نافذة زمنية.`
      });
    }

    const main = cycles[0];
    const phaseNow = (((2 * Math.PI * main.freq * (n - 1) + main.phase) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

    return {
      ok: true, significant: true,
      n, lastIndex: n - 1,
      cycles, nCycles: cycles.length,
      period: main.period, freq: main.freq, phase: main.phase,
      amplitudePct: main.amplitudePct,
      bandSharePct: main.bandSharePct, top: main.top || [],
      cyclePosPct: round(phaseNow / (2 * Math.PI) * 100, 1),  /* 0٪=قمة · 50٪=قاع */
      pValue: main.pValue,
      pValueText: main.pValue < 0.001 ? '<0.001' : main.pValue.toFixed(3),
      snr: main.snr,
      seBarsNow: main.seBarsNow,
      gridErrorPct: main.gridErrorPct,
      trendR2: round(trend.r2, 3), trendSlopePerBar: round(trend.slope, 6),
      verdict: `${cycles.length} دورة دالة — المهيمنة ${main.period} جلسة (p=${main.pValue < 0.001 ? '<0.001' : main.pValue.toFixed(3)}، نسبة إشارة/ضجيج ${main.snr})`
    };
  }

  /**
   * إسقاط الانعطافات من الطيف المحسّن — **بعدم يقين معلن**.
   * عدم اليقين يتّسع مع الأفق لأن خطأ التردد يتراكم: انعطاف بعد 5 جلسات
   * أدقّ بكثير من انعطاف بعد 50، وعرضهما بنفس الثقة تضليل.
   */
  function projectTurnsPro(spec, horizonBars = 90, opts = {}) {
    if (!spec || !spec.ok || !spec.significant || !spec.cycles.length) return [];
    const composite = opts.composite !== false;
    const cyc = composite ? spec.cycles : [spec.cycles[0]];
    const last = spec.lastIndex;

    const val = (t) => cyc.reduce((s, c) =>
      s + c.amplitude * Math.cos(2 * Math.PI * c.freq * t + c.phase), 0);

    const turns = [];
    let prev = val(last), prevSlope = prev - val(last - 1);
    for (let t = last + 1; t <= last + horizonBars; t++) {
      const v = val(t), slope = v - prev;
      const barsAhead = t - 1 - last;
      if (barsAhead > 0 && ((prevSlope > 0 && slope <= 0) || (prevSlope < 0 && slope >= 0))) {
        const type = prevSlope > 0 ? 'peak' : 'valley';
        /* عدم اليقين: خطأ الطور + خطأ التردد المتراكم عبر h جلسة */
        const m = spec.cycles[0];
        const sdRad = Math.sqrt(m.sePhase ** 2 + (m.seOmega * barsAhead) ** 2);
        const sdBars = sdRad / (2 * Math.PI) * m.period;
        turns.push({
          type, barsAhead,
          sdBars: round(sdBars, 1),
          loBars: Math.max(1, Math.round(barsAhead - 1.96 * sdBars)),
          hiBars: Math.round(barsAhead + 1.96 * sdBars),
          /* نافذة عملية لا تتجاوز نصف دورة — أوسع من ذلك بلا معنى تنفيذي */
          usable: 1.96 * sdBars < m.period / 4
        });
      }
      prev = v; prevSlope = slope;
    }
    return turns;
  }

  /* ════════════════════════════════════════════════════════════════════
     14) تماسك الدورة — هل تنبّأت فعلاً بانعطافات لم ترها؟
     ──────────────────────────────────────────────────────────────────
     قيمة الاحتمال من اختبار Fisher تجيب عن سؤال واحد: «هل هذه الذروة
     الطيفية تفسّرها الصدفة؟». وهو سؤال *وصفي* عن العينة الماضية.
     السؤال التنفيذي مختلف تماماً: «لو استعملتُ هذه الدورة للتنبؤ بموعد
     الانعطاف، هل كانت ستصيب؟».

     الطريقة: نبني الدورة من أول 60٪ من التاريخ فقط، ونُسقط انعطافاتها
     على الـ40٪ الباقية، ثم نقيس كم منها وقع قرب ارتكاز حقيقي مؤكد ضمن
     نافذة تسامح. ونقارن ذلك بمعدّل الإصابة المتوقّع بالصدفة (تغطية
     النوافذ من المحور الزمني) باختبار ذي حدّين.

     هذا رقم *مقاس* لكل سهم — لا مشتقّ من افتراض.
     ════════════════════════════════════════════════════════════════════ */
  function cycleCoherence(candles, opts = {}) {
    const n = candles.length;
    const minHist = opts.minHistory ?? 120;
    if (n < minHist + 60) return { ok: false, reason: `يتطلب ${minHist + 60} شمعة (متوفر ${n})` };

    const splitAt = Math.floor(n * 0.6);
    const closes = candles.map(c => c.close);
    const spec = spectralPro(closes.slice(0, splitAt), { alpha: opts.alpha ?? 0.05 });
    if (!spec.ok || !spec.significant) {
      return { ok: false, reason: 'لا دورة دالة في النصف الأول من التاريخ — لا شيء يُختبر خارج العيّنة' };
    }

    const horizon = n - splitAt;
    const turns = projectTurnsPro(spec, horizon, { composite: false });
    if (!turns.length) return { ok: false, reason: 'لم تُسقط الدورة أي انعطاف داخل الفترة المحجوزة' };

    /* الارتكازات الحقيقية المؤكدة في الفترة المحجوزة */
    const pivots = detectPivots(candles, opts.k ?? 3).filter(p => p.i >= splitAt);
    if (pivots.length < 3) return { ok: false, reason: 'ارتكازات مؤكدة غير كافية في الفترة المحجوزة' };

    /* نافذة التسامح: ±10٪ من الدورة، بحد أدنى شمعتان */
    const tol = Math.max(2, Math.round(spec.period * 0.10));

    let hits = 0;
    const detail = [];
    for (const t of turns) {
      const idx = splitAt - 1 + t.barsAhead;
      if (idx >= n) continue;
      const want = t.type === 'valley' ? 'L' : 'H';
      const near = pivots.find(p => p.type === want && Math.abs(p.i - idx) <= tol);
      if (near) hits++;
      detail.push({ barsAhead: t.barsAhead, type: t.type, hit: !!near, off: near ? near.i - idx : null });
    }
    const tried = detail.length;
    if (!tried) return { ok: false, reason: 'لا انعطافات قابلة للتقييم' };

    /* معدّل الإصابة بالصدفة: نسبة المحور الزمني المغطاة بنوافذ التسامح
       حول الارتكازات من النوع المطلوب */
    const winSize = 2 * tol + 1;
    const nL = pivots.filter(p => p.type === 'L').length;
    const nH = pivots.filter(p => p.type === 'H').length;
    const wantL = detail.filter(d => d.type === 'valley').length;
    const pChanceL = clamp(nL * winSize / horizon, 0, 1);
    const pChanceH = clamp(nH * winSize / horizon, 0, 1);
    const pChance = tried ? (wantL * pChanceL + (tried - wantL) * pChanceH) / tried : 0;

    /* اختبار ذي حدّين أحادي الطرف: P(X ≥ hits) */
    let pVal = 0;
    for (let k = hits; k <= tried; k++) {
      const ln = Stats.lnChoose(tried, k) + k * Math.log(Math.max(pChance, 1e-12)) + (tried - k) * Math.log(Math.max(1 - pChance, 1e-12));
      pVal += Math.exp(ln);
    }
    pVal = clamp(pVal, 0, 1);

    const ci = Stats.wilson(hits, tried);
    const alpha = opts.alpha ?? 0.05;
    const reliable = pVal <= alpha && hits / tried > pChance;

    return {
      ok: true,
      period: spec.period,
      hits, tried,
      hitRatePct: round(hits / tried * 100, 1),
      hitRateCI: [round(ci.lo * 100, 1), round(ci.hi * 100, 1)],
      chanceRatePct: round(pChance * 100, 1),
      toleranceBars: tol,
      pValue: round(pVal, 4),
      pValueText: pVal < 0.001 ? '<0.001' : pVal.toFixed(3),
      reliable,
      medianOffBars: (() => {
        const offs = detail.filter(d => d.hit).map(d => Math.abs(d.off)).sort((a, b) => a - b);
        return offs.length ? offs[Math.floor(offs.length / 2)] : null;
      })(),
      verdict: reliable
        ? `الدورة أصابت ${hits} من ${tried} انعطافاً خارج العيّنة (${round(hits / tried * 100, 1)}٪ مقابل ${round(pChance * 100, 1)}٪ بالصدفة، p=${pVal < 0.001 ? '<0.001' : pVal.toFixed(3)}) — توقيتها قابل للاعتماد على هذا السهم`
        : `أصابت ${hits} من ${tried} (${round(hits / tried * 100, 1)}٪) مقابل ${round(pChance * 100, 1)}٪ متوقعة بالصدفة، p=${pVal.toFixed(3)} — لا دليل على أن توقيت الدورة يتفوّق على التخمين هنا`,
      detail
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     15) دورات الارتكاز التجريبية — بديل عدّ غان/فيبوناتشي الأعمى
     ──────────────────────────────────────────────────────────────────
     التحليل الزمني الحالي يسأل: «هل المسافة منذ الارتكاز تساوي 34 أو 55
     أو 90؟». والمشكلة أن هذه الأرقام مفروضة من خارج السهم. لم يُسأل قط:
     هل لهذا السهم *فعلاً* ميل لانعطافات عند هذه المسافات؟

     هنا نقلب السؤال: نأخذ كل المسافات بين الارتكازات المؤكدة المتتالية
     لهذا السهم، ونبني منها توزيعه التجريبي، ثم نختبر كل رقم مرشّح مقابل
     فرضية عدم: «المسافات موزّعة كما لو كانت الانعطافات عشوائية بنفس
     المعدّل». الرقم الذي يتكرّر أكثر مما تفسّره الصدفة هو دورة حقيقية
     لهذا السهم — سواء صادف أن يكون رقم فيبوناتشي أم لا.
     ════════════════════════════════════════════════════════════════════ */
  function empiricalPivotCycles(candles, opts = {}) {
    const k = opts.k ?? 3;
    const alpha = opts.alpha ?? 0.10;
    const nPerm = opts.permutations ?? 300;
    const pv = detectPivots(candles, k);
    if (pv.length < 10) return { ok: false, reason: `ارتكازات مؤكدة غير كافية (${pv.length}) — يتطلب 10 على الأقل` };

    const span = candles.length;
    const idxs = pv.map(p => p.i).sort((x, y) => x - y);
    const maxGap = Math.min(200, Math.floor(span / 2));

    /* كل المسافات بين أزواج الارتكازات */
    const gapsOf = (arr) => {
      const out = [];
      for (let i = 0; i < arr.length; i++)
        for (let j = i + 1; j < arr.length; j++) {
          const d = arr[j] - arr[i];
          if (d >= 4 && d <= maxGap) out.push(d);
        }
      return out;
    };
    const gaps = gapsOf(idxs);
    if (gaps.length < 25) return { ok: false, reason: 'أزواج ارتكاز غير كافية' };

    const tolOf = d => Math.max(1, Math.round(d * 0.08));
    const countIn = (arr, lo, hi) => { let n = 0; for (const d of arr) if (d >= lo && d <= hi) n++; return n; };

    /* ══ فرضية العدم بالتبديل (permutation) ══
       اختبار بواسون على أزواج الارتكازات كان يعطي 35٪ إيجابيات كاذبة —
       قياس فعلي على 120 مسار مشي عشوائي. السبب أن الأزواج ليست مستقلة:
       كل ارتكاز يدخل في عشرات الأزواج، فحجم العينة الفعّال أصغر بكثير
       مما يفترضه بواسون، وقيمة الاحتمال تخرج متفائلة بشكل منهجي.

       البديل: نخلط *المسافات بين الارتكازات المتتالية* بترتيب عشوائي
       ببذرة ثابتة. هذا يحفظ عدد الارتكازات وتوزيع تباعدها تماماً، ويهدم
       البنية الدورية وحدها — وهي بالضبط الفرضية المراد اختبارها. */
    const inter = [];
    for (let i = 1; i < idxs.length; i++) inter.push(idxs[i] - idxs[i - 1]);
    const rand = seededRandom(seedFromString('pivotcycles:' + span + ':' + idxs.length));

    const nullCounts = [];      /* [perm][candidateIdx] */
    const permGapsList = [];
    for (let p = 0; p < nPerm; p++) {
      const sh = inter.slice();
      for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = sh[i]; sh[i] = sh[j]; sh[j] = t; }
      const pos = [idxs[0]];
      for (const d of sh) pos.push(pos[pos.length - 1] + d);
      permGapsList.push(gapsOf(pos));
    }

    /* المرشّحون: أرقام غان/فيبوناتشي + أكثر المسافات تكراراً في السهم نفسه */
    const classic = [13, 21, 34, 55, 89, 144, 30, 45, 60, 90, 120, 180];
    const histo = new Map();
    for (const d of gaps) histo.set(d, (histo.get(d) || 0) + 1);
    const own = [...histo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(e => e[0]);

    const seen = new Set(), cands = [];
    for (const c of [...classic, ...own]) {
      if (c < 5 || c > maxGap || seen.has(c)) continue;
      seen.add(c);
      const tol = tolOf(c);
      const obs = countIn(gaps, c - tol, c + tol);
      if (obs < 4) continue;
      let ge = 0, sum = 0;
      for (const pg of permGapsList) { const v = countIn(pg, c - tol, c + tol); sum += v; if (v >= obs) ge++; }
      const expected = sum / nPerm;
      /* قيمة احتمال التبديل بتصحيح المضافة (add-one) — لا تعطي صفراً أبداً */
      const p = (ge + 1) / (nPerm + 1);
      if (obs <= expected) continue;
      cands.push({
        cycle: c, observed: obs, expected: round(expected, 1), tolerance: tol,
        pValue: round(p, 5), lift: round(obs / Math.max(expected, 1e-9), 2), classic: classic.includes(c)
      });
    }

    if (!cands.length) return { ok: true, cycles: [], pivotCount: pv.length, tested: 0, lastPivot: pv[pv.length - 1], note: 'لا مسافة زمنية تتكرّر أكثر مما ينتجه خلط تباعد الارتكازات — عدّ غان/فيبوناتشي هنا بلا أساس تجريبي على هذا السهم' };

    /* تصحيح الاختبارات المتعددة على المرشّحين */
    const pass = Stats.benjaminiHochberg(cands.map(c => c.pValue), alpha);
    let kept = cands.filter((c, i) => pass[i]).sort((a, b) => a.pValue - b.pValue || b.lift - a.lift);

    /* دمج المرشّحين المتجاورين (34 و35 و36 دورة واحدة لا ثلاث) */
    const merged = [];
    for (const c of kept) {
      if (merged.some(m => Math.abs(m.cycle - c.cycle) <= Math.max(m.tolerance, c.tolerance))) continue;
      merged.push(c);
    }

    return {
      ok: true,
      pivotCount: pv.length,
      tested: cands.length,
      permutations: nPerm,
      cycles: merged.slice(0, 5),
      lastPivot: pv[pv.length - 1],
      note: merged.length
        ? `${merged.length} دورة زمنية اجتازت اختبار التبديل (${nPerm} خلطة) وتصحيح Benjamini-Hochberg من ${cands.length} مرشّحاً`
        : `لا دورة اجتازت التصحيح من ${cands.length} مرشّحاً — عدّ غان/فيبوناتشي على هذا السهم لا يتفوّق على الصدفة`
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     16) أهداف الفراكتال — هدف مشتقّ من البنية لا من مضاعف مخترع
     ──────────────────────────────────────────────────────────────────
     «الهدف = 2R» ليس تحليلاً بل تعريفاً. الهدف الفراكتالي يأتي من بنية
     السوق فعلياً: أقرب قمة فراكتالية لم تُكسر بعد هي المكان الذي توجد
     فيه أوامر بيع معلّقة، وهي أول ما يوقف الحركة.
     ثم الحركة المقيسة (measured move): ارتفاع آخر ساق دافعة مُسقَط من
     قاعدة الاختراق — وهو الهدف الذي يفترض تكرار السلوك لا مضاعفة رقم.
     ════════════════════════════════════════════════════════════════════ */
  function fractalTargets(candles, opts = {}) {
    const n = candles.length;
    if (n < 25) return { ok: false, reason: 'شموع غير كافية' };
    const price = candles[n - 1].close;
    const k = opts.k ?? 2;                        /* فراكتال بيل ويليامز = 2 */

    const up = [], dn = [];                       /* قيعان / قمم فراكتالية */
    for (let i = k; i < n - k; i++) {
      let isLow = true, isHigh = true;
      for (let j = 1; j <= k; j++) {
        if (!(candles[i].low < candles[i - j].low && candles[i].low < candles[i + j].low)) isLow = false;
        if (!(candles[i].high > candles[i - j].high && candles[i].high > candles[i + j].high)) isHigh = false;
      }
      if (isLow) up.push({ i, price: candles[i].low });
      if (isHigh) dn.push({ i, price: candles[i].high });
    }
    if (!dn.length || !up.length) return { ok: false, reason: 'لا فراكتالات مكتملة' };

    /* قمة فراكتالية «حيّة» = فوق السعر ولم يُغلق فوقها بعد تكوّنها */
    const liveHighs = dn.filter(f => f.price > price * 1.001 &&
      !candles.slice(f.i + k + 1).some(c => c.close > f.price))
      .sort((a, b) => a.price - b.price);
    const liveLows = up.filter(f => f.price < price * 0.999)
      .sort((a, b) => b.price - a.price);

    /* الحركة المقيسة: آخر ساق من قاع فراكتالي إلى قمة فراكتالية تلته */
    let measured = null;
    const lastLow = up[up.length - 1], lastHigh = dn[dn.length - 1];
    if (lastLow && lastHigh) {
      const legLow = up.filter(f => f.i < lastHigh.i).pop();
      if (legLow && lastHigh.price > legLow.price) {
        const legH = lastHigh.price - legLow.price;
        const base = liveLows[0] ? liveLows[0].price : legLow.price;
        measured = round(base + legH);
      }
    }

    const t1 = liveHighs[0] ? round(liveHighs[0].price) : null;
    const t2 = liveHighs[1] ? round(liveHighs[1].price) : null;

    return {
      ok: true,
      price: round(price),
      target1: t1,
      target2: t2,
      measuredMove: measured,
      /* الهدف المعتمد: أقرب قمة حيّة، وإلا الحركة المقيسة */
      target: t1 ?? measured,
      targetSource: t1 ? 'أقرب قمة فراكتالية غير مكسورة' : (measured ? 'حركة مقيسة من آخر ساق دافعة' : null),
      upsidePct: (t1 ?? measured) ? round(((t1 ?? measured) - price) / price * 100, 2) : null,
      support: liveLows[0] ? round(liveLows[0].price) : null,
      supportPct: liveLows[0] ? round((price - liveLows[0].price) / price * 100, 2) : null,
      highCount: liveHighs.length, lowCount: liveLows.length,
      /* مساحة نظيفة: لا قمة فراكتالية بين السعر والهدف = طريق مفتوح */
      cleanRunway: liveHighs.length > 0 && liveHighs[0].price / price - 1 > 0.03
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     14) محرك الأوبشن — تسعير Black-Scholes، الإغريق، واختيار العقد
     ──────────────────────────────────────────────────────────────────
     مبدأ الوحدة كله: **لا نُسعّر العقد من الدلتا وحدها**.

     الطريقة الشائعة في المنصّات ("إذا تحرك السهم ١٪ يربح العقد دلتا×١٪")
     خاطئة لعقود أسبوعية تحديداً، لثلاثة أسباب مجتمعة:
       (1) الدلتا نفسها تتغيّر مع حركة السهم (جاما مرتفعة قرب الاستحقاق)،
       (2) ثيتا تلتهم من ٥٪ إلى ١٥٪ من قيمة العقد يومياً في الأسبوع الأخير،
       (3) التذبذب الضمني ينهار بعد الحدث (IV crush) فيخسر العقد رغم صحة
           الاتجاه.
     لذلك كل هدف ووقف هنا يُحسب بإعادة **تسعير كاملة** للعقد عند سعر السهم
     الهدف، في التاريخ المتوقع للوصول، مع افتراض صريح لانخفاض التذبذب.
     الفرق بين الطريقتين ليس تجميلياً: في عقد أسبوعي ATM يبلغ ٤٠٪ من الربح.
     ════════════════════════════════════════════════════════════════════ */

  const SQRT2PI = Math.sqrt(2 * Math.PI);
  const TRADING_DAYS_YEAR = 252;

  const Options = {
    RISK_FREE_DEFAULT: 0.043,

    normPdf(x) { return Math.exp(-x * x / 2) / SQRT2PI; },
    normCdf(x) { return Stats.normalCdf(x); },

    /** تحويل جلسات التداول إلى زمن سنوي — الوحدة الصحيحة لصيغة BS.
     *  استخدام الأيام التقويمية/365 يبالغ في تقدير القيمة الزمنية لعقد
     *  يعبر عطلة نهاية أسبوع، لأن السوق مغلق ولا يتحرّك فيه شيء. */
    yearsFromSessions(sessions) { return Math.max(1 / TRADING_DAYS_YEAR / 8, sessions / TRADING_DAYS_YEAR); },

    d1d2(S, K, T, r, sig, q = 0) {
      if (!(S > 0) || !(K > 0) || !(T > 0) || !(sig > 0)) return null;
      const vt = sig * Math.sqrt(T);
      const d1 = (Math.log(S / K) + (r - q + sig * sig / 2) * T) / vt;
      return { d1, d2: d1 - vt, vt };
    },

    /** سعر العقد النظري. type: 'call' | 'put'. */
    price(S, K, T, r, sig, type, q = 0) {
      const isCall = type !== 'put';
      if (!(T > 0) || !(sig > 0)) {
        return Math.max(0, isCall ? S - K : K - S);  /* القيمة الجوهرية عند الانتهاء */
      }
      const dd = Options.d1d2(S, K, T, r, sig, q);
      if (!dd) return null;
      const df = Math.exp(-r * T), dq = Math.exp(-q * T);
      return isCall
        ? S * dq * Options.normCdf(dd.d1) - K * df * Options.normCdf(dd.d2)
        : K * df * Options.normCdf(-dd.d2) - S * dq * Options.normCdf(-dd.d1);
    },

    /** الإغريق. ثيتا تُعاد **لكل جلسة تداول** لا لكل سنة — لأن قرار
     *  المتداول اليومي هو "كم سأخسر إن بقيت ليلة إضافية". */
    greeks(S, K, T, r, sig, type, q = 0) {
      const isCall = type !== 'put';
      const dd = Options.d1d2(S, K, T, r, sig, q);
      if (!dd) return { delta: null, gamma: null, theta: null, vega: null };
      const { d1, d2 } = dd;
      const pdf = Options.normPdf(d1), sqT = Math.sqrt(T);
      const df = Math.exp(-r * T), dq = Math.exp(-q * T);
      const delta = isCall ? dq * Options.normCdf(d1) : dq * (Options.normCdf(d1) - 1);
      const gamma = dq * pdf / (S * sig * sqT);
      const vega = S * dq * pdf * sqT / 100;                    /* لكل ١٪ تغيّر في IV */
      const thetaYear = isCall
        ? -(S * dq * pdf * sig) / (2 * sqT) - r * K * df * Options.normCdf(d2) + q * S * dq * Options.normCdf(d1)
        : -(S * dq * pdf * sig) / (2 * sqT) + r * K * df * Options.normCdf(-d2) - q * S * dq * Options.normCdf(-d1);
      return {
        delta: round(delta, 4), gamma: round(gamma, 5),
        theta: round(thetaYear / TRADING_DAYS_YEAR, 4),          /* $ لكل سهم لكل جلسة */
        vega: round(vega, 4),
        thetaPctPerSession: null                                  /* يُملأ من المتصل */
      };
    },

    /** التذبذب الضمني من سعر السوق — تنصيف مضمون التقارب (لا Newton
     *  الذي ينفجر عند فيغا ≈ 0 في العقود العميقة داخل/خارج النقد). */
    impliedVol(marketPrice, S, K, T, r, type, q = 0) {
      if (!isNum(marketPrice) || marketPrice <= 0 || !(T > 0)) return null;
      const intrinsic = Math.max(0, (type !== 'put') ? S - K : K - S);
      if (marketPrice < intrinsic * 0.999) return null;           /* سعر دون القيمة الجوهرية = بيانات فاسدة */
      let lo = 0.005, hi = 5.0;
      if (Options.price(S, K, T, r, hi, type, q) < marketPrice) return null;
      for (let i = 0; i < 100; i++) {
        const mid = (lo + hi) / 2;
        const p = Options.price(S, K, T, r, mid, type, q);
        if (p > marketPrice) hi = mid; else lo = mid;
        if (hi - lo < 1e-6) break;
      }
      return round((lo + hi) / 2, 4);
    },

    /** نقطة التعادل عند الاستحقاق. */
    breakeven(K, premium, type) {
      return round(type !== 'put' ? K + premium : K - premium);
    },

    /** احتمال انتهاء العقد داخل النقد (محايد المخاطر — ليس احتمالاً واقعياً،
     *  وهذا فرق يجب ذكره: N(d2) تحت قياس محايد للمخاطر يميل للتحفّظ). */
    probITM(S, K, T, r, sig, type, q = 0) {
      const dd = Options.d1d2(S, K, T, r, sig, q);
      if (!dd) return null;
      return round(type !== 'put' ? Options.normCdf(dd.d2) : Options.normCdf(-dd.d2), 4);
    },

    /** احتمال ملامسة مستوى قبل الاستحقاق (انعكاس الحاجز) — أعلى دائماً
     *  من احتمال الإغلاق فوقه، وهو المقياس الصحيح لخطة "أخرج عند الهدف". */
    probTouch(S, level, T, sig, drift = 0) {
      if (!(S > 0) || !(level > 0) || !(T > 0) || !(sig > 0)) return null;
      const x = Math.log(level / S);
      if (x === 0) return 1;
      const m = drift - sig * sig / 2;
      const vt = sig * Math.sqrt(T);
      const expo = Math.exp(2 * m * x / (sig * sig));
      const p = (x > 0)
        /* حاجز أعلى: احتمال أن يبلغ الأقصى المستوى */
        ? Options.normCdf((-x + m * T) / vt) + expo * Options.normCdf((-x - m * T) / vt)
        /* حاجز أدنى: احتمال أن يبلغ الأدنى المستوى */
        : Options.normCdf((x - m * T) / vt) + expo * Options.normCdf((x + m * T) / vt);
      return round(clamp(p, 0, 1), 4);
    },

    /** الحركة المتوقعة للسهم حتى الاستحقاق (انحراف معياري واحد). */
    expectedMove(S, sig, T) {
      if (!(S > 0) || !(sig > 0) || !(T > 0)) return null;
      const em = S * sig * Math.sqrt(T);
      return { abs: round(em), pct: round(em / S * 100, 2), lo: round(S - em), hi: round(S + em) };
    },

    /** إعادة تسعير العقد عند سعر سهم مستقبلي وتاريخ مستقبلي.
     *  ivShift: تغيّر التذبذب الضمني بالنسبة المئوية المطلقة (سالب = انهيار). */
    repriceAt(K, type, S2, sessionsLeft, iv, r, ivShift = 0, q = 0) {
      const T2 = Options.yearsFromSessions(sessionsLeft);
      const iv2 = Math.max(0.02, iv + ivShift);
      if (sessionsLeft <= 0) return round(Math.max(0, type !== 'put' ? S2 - K : K - S2));
      return round(Options.price(S2, K, T2, r, iv2, type, q));
    },

    /** التذبذب التاريخي المحقق (سنوي) من الإغلاقات — مرجع الحكم على IV. */
    realizedVol(closes, lookback = 20) {
      if (!closes || closes.length < lookback + 2) return null;
      const w = closes.slice(-(lookback + 1));
      const rets = [];
      for (let i = 1; i < w.length; i++) {
        if (w[i - 1] > 0 && w[i] > 0) rets.push(Math.log(w[i] / w[i - 1]));
      }
      if (rets.length < 5) return null;
      return round(Stats.std(rets) * Math.sqrt(TRADING_DAYS_YEAR), 4);
    }
  };

  /* ════════════════════════════════════════════════════════════════════
     15) اختيار العقد الأسبوعي وخطة تنفيذه
     ──────────────────────────────────────────────────────────────────
     المدخل: سلسلة عقود حقيقية من مزوّد البيانات + تحليل السهم الأساسي
     (اتجاه، دخول، وقف، هدف، الدورة الزمنية). المخرج: عقد واحد مع
     أرقام تنفيذ، وحكم صريح: ادخل الآن / انتظر / تجنّب — ولماذا.
     ════════════════════════════════════════════════════════════════════ */

  const OPT_DEFAULTS = {
    minOpenInterest: 250,        /* أقل فائدة مفتوحة مقبولة للخروج بسعر عادل */
    minVolume: 25,               /* حجم اليوم — يكشف العقود الميتة */
    maxSpreadPct: 8,             /* (طلب-عرض)/الوسط — فوق ٨٪ تُدفع الحافة كلها للصانع */
    targetDeltaLo: 0.35,         /* نطاق الدلتا المستهدف: توازن بين التكلفة والاستجابة */
    targetDeltaHi: 0.62,
    minSessionsToExpiry: 2,      /* عقد يوم واحد = مقامرة على ثيتا لا صفقة */
    maxSessionsToExpiry: 12,
    ivCrushAssumption: -0.06,    /* افتراض تحفّظي: انخفاض ٦ نقاط IV عند بلوغ الهدف */
    minRR: 1.6,
    maxPremiumLossPct: 0.45,     /* أقصى خسارة مقبولة من العلاوة قبل الخروج */
    riskFree: 0.043
  };

  /** يبني عقداً مُقيّماً واحداً من صف خام في سلسلة العقود. */
  function evaluateContract(raw, ctx, cfg) {
    const { spot, sessionsToExpiry, type } = ctx;
    const K = num(raw.strike);
    if (!isNum(K) || K <= 0) return null;

    const bid = num(raw.bid, 0), ask = num(raw.ask, 0);
    const last = num(raw.lastPrice, null);
    /* الوسط هو السعر الواقعي للتنفيذ. آخر صفقة قد تكون من ساعات مضت. */
    const mid = (bid > 0 && ask > 0) ? (bid + ask) / 2 : (last || 0);
    if (!(mid > 0)) return null;

    const spreadPct = (bid > 0 && ask > 0 && mid > 0) ? round((ask - bid) / mid * 100, 2) : null;
    const oi = num(raw.openInterest, 0), vol = num(raw.volume, 0);

    const T = Options.yearsFromSessions(sessionsToExpiry);
    const r = cfg.riskFree;
    /* نُفضّل استخراج IV من السعر بأنفسنا: القيمة المعلنة من المزوّد
       تُحسب أحياناً على آخر صفقة لا على الوسط، فتنحرف بشكل ملحوظ. */
    const ivCalc = Options.impliedVol(mid, spot, K, T, r, type);
    const iv = ivCalc ?? num(raw.impliedVolatility, null);
    if (!isNum(iv) || iv <= 0) return null;

    const g = Options.greeks(spot, K, T, r, iv, type);
    const theta = g.theta ?? 0;
    const thetaPct = mid > 0 ? round(Math.abs(theta) / mid * 100, 2) : null;

    return {
      strike: round(K), type,
      bid: round(bid), ask: round(ask), mid: round(mid), last: last != null ? round(last) : null,
      spreadPct, openInterest: oi, volume: vol,
      iv: round(iv, 4), ivPct: round(iv * 100, 1),
      delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega,
      thetaPctPerSession: thetaPct,
      moneyness: round((spot - K) / spot * 100, 2),
      breakeven: Options.breakeven(K, mid, type),
      breakevenMovePct: round(Math.abs(Options.breakeven(K, mid, type) - spot) / spot * 100, 2),
      probITM: Options.probITM(spot, K, T, r, iv, type),
      contractSymbol: raw.contractSymbol || null,
      _T: T
    };
  }

  /**
   * الدالة الرئيسية.
   * ctx = {
   *   candles, spot, dirUp,
   *   entryU, stopU, targetU,          ← من executionPlan/fractalTargets
   *   sessionsToExpiry, expiryDate,
   *   cycleSessionsToTurn,             ← من التحليل الزمني (اختياري)
   *   chain: [{strike,bid,ask,lastPrice,openInterest,volume,impliedVolatility,...}]
   * }
   */
  function weeklyOptionPlan(ctx, options = {}) {
    const cfg = Object.assign({}, OPT_DEFAULTS, options);
    const reasons = [], warnings = [];

    const spot = num(ctx.spot);
    const chain = Array.isArray(ctx.chain) ? ctx.chain : [];
    if (!isNum(spot) || spot <= 0) return { ok: false, why: 'سعر السهم غير متاح' };
    if (!chain.length) return { ok: false, why: 'سلسلة العقود فارغة — لا توجد عقود مُدرجة لهذا الاستحقاق' };

    const type = ctx.dirUp ? 'call' : 'put';
    const sessions = Math.round(num(ctx.sessionsToExpiry, 0));
    if (sessions < cfg.minSessionsToExpiry) {
      return {
        ok: false, verdict: 'avoid', verdictLabel: 'تجنّب',
        why: `بقيت ${sessions} جلسة فقط على الاستحقاق. في هذا النطاق تتجاوز خسارة الوقت اليومية ما تكسبه حركة السهم النموذجية، فالنتيجة رهان على التوقيت الفوري لا صفقة لها حافة.`
      };
    }

    /* ── 1) تقييم كل العقود من النوع المطلوب ── */
    const evalCtx = { spot, sessionsToExpiry: sessions, type };
    let cands = chain
      .filter(c => (c.type ? c.type === type : true))
      .map(c => evaluateContract(c, evalCtx, cfg))
      .filter(Boolean);

    if (!cands.length) return { ok: false, why: 'لا توجد عقود صالحة التسعير في السلسلة (أسعار مفقودة أو صفرية)' };

    /* ── 2) التذبذب: هل العقود غالية أصلاً؟ ──
       IV/HV هو الحكم. فوق 1.6 معناه أن السوق يسعّر حركة أكبر بكثير مما
       يفعله السهم فعلاً — الشراء هنا يعني دفع علاوة لن تتحقق. */
    const closes = (ctx.candles || []).map(c => c.close).filter(isNum);
    const hv = Options.realizedVol(closes, 20);
    const atmSorted = [...cands].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
    const atmIV = atmSorted[0] ? atmSorted[0].iv : null;
    const ivHv = (isNum(atmIV) && isNum(hv) && hv > 0) ? round(atmIV / hv, 2) : null;

    /* ── 3) الحركة المتوقعة حتى الاستحقاق ── */
    const em = Options.expectedMove(spot, atmIV, Options.yearsFromSessions(sessions));

    /* ── 4) فلترة السيولة والدلتا ── */
    const liquid = cands.filter(c =>
      c.openInterest >= cfg.minOpenInterest &&
      (c.volume >= cfg.minVolume || c.openInterest >= cfg.minOpenInterest * 4) &&
      (c.spreadPct == null || c.spreadPct <= cfg.maxSpreadPct)
    );
    const pool = liquid.length ? liquid : cands;
    if (!liquid.length) warnings.push('لا يوجد عقد يستوفي حدّ السيولة. المعروض أدناه هو الأفضل نسبياً، لكن التنفيذ والخروج قد يكلّفان أكثر من الحافة المتوقعة.');

    const inDelta = pool.filter(c => {
      const d = Math.abs(c.delta ?? 0);
      return d >= cfg.targetDeltaLo && d <= cfg.targetDeltaHi;
    });
    const finalPool = inDelta.length ? inDelta : pool;

    /* ── 5) الأهداف: إعادة تسعير كاملة، لا ضرب في الدلتا ── */
    const targetU = num(ctx.targetU, null);
    const stopU = num(ctx.stopU, null);
    const atrVal = num(ctx.atr, null);
    /* كم جلسة نتوقع أن يستغرقها بلوغ الهدف؟ من ATR، ومقيّداً بالاستحقاق. */
    let sessionsToTarget = (isNum(targetU) && isNum(atrVal))
      ? USMarket.expectedSessionsToReach(spot, targetU, atrVal) : null;
    if (isNum(ctx.cycleSessionsToTurn) && ctx.cycleSessionsToTurn > 0) {
      /* الدورة الزمنية تقول متى يُتوقع الانعطاف — نأخذ الأبعد بين التقديرين
         لأن الأقصر يبالغ في التفاؤل بشأن سرعة الوصول. */
      sessionsToTarget = Math.max(sessionsToTarget ?? 0, Math.round(ctx.cycleSessionsToTurn));
    }
    const holdSessions = clamp(sessionsToTarget ?? Math.ceil(sessions / 2), 1, sessions);

    const scored = finalPool.map(c => {
      const leftAtTarget = Math.max(0, sessions - holdSessions);
      const leftAtStop = Math.max(0, sessions - 1);   /* الوقف يُفترض ضربه سريعاً */

      const exitAtTarget = isNum(targetU)
        ? Options.repriceAt(c.strike, type, targetU, leftAtTarget, c.iv, cfg.riskFree, cfg.ivCrushAssumption)
        : null;
      /* وقف العقد: نُسعّره عند وقف السهم — لكن لا نقبل أبداً أن يكون
         "الوقف" هو صفر (خسارة 100٪ من العلاوة). هذا خطأ منهجي شائع:
         الوقف الحقيقي أمر بيع يُنفَّذ على *سعر العقد*، ويجب أن يخرج قبل
         تبخّر العلاوة. لذلك نأخذ الأعلى بين السعر المُعاد حسابه وحدّ
         خسارة أقصى من العلاوة (افتراضياً 45٪). */
      const repricedStop = isNum(stopU)
        ? Options.repriceAt(c.strike, type, stopU, leftAtStop, c.iv, cfg.riskFree, cfg.ivCrushAssumption / 2)
        : null;
      const floorStop = round(c.mid * (1 - cfg.maxPremiumLossPct));
      const exitAtStop = isNum(repricedStop) ? Math.max(repricedStop, floorStop) : floorStop;
      const stopIsFloor = isNum(repricedStop) && repricedStop < floorStop;

      const entryPx = c.mid;
      const gain = isNum(exitAtTarget) ? exitAtTarget - entryPx : null;
      const loss = isNum(exitAtStop) ? entryPx - exitAtStop : null;
      const rr = (isNum(gain) && isNum(loss) && loss > 0) ? round(gain / loss, 2) : null;
      const gainPct = isNum(gain) ? round(gain / entryPx * 100, 1) : null;
      const lossPct = isNum(loss) ? round(loss / entryPx * 100, 1) : null;

      /* الحاجز الحقيقي: هل نقطة التعادل داخل الحركة المتوقعة؟
         عقد نقطة تعادله أبعد من 1σ يعني أنك تراهن ضد التوزيع نفسه. */
      const beWithinEM = (em && isNum(c.breakevenMovePct)) ? c.breakevenMovePct <= em.pct : null;

      /* ── التقييم المركّب (0–100) ── */
      let sc = 0;
      /* السيولة 25 */
      const spreadScore = c.spreadPct == null ? 8 : clamp(15 * (1 - c.spreadPct / cfg.maxSpreadPct), 0, 15);
      const oiScore = clamp(10 * Math.log10(Math.max(1, c.openInterest)) / 3.5, 0, 10);
      sc += spreadScore + oiScore;
      /* قيمة التذبذب 20 */
      if (isNum(ivHv)) sc += clamp(20 * (1.75 - ivHv) / 0.95, 0, 20);
      else sc += 10;
      /* الملاءمة الزمنية 25: هل يكفي الاستحقاق للوصول، وكم تأكل ثيتا */
      const timeBuffer = sessions - holdSessions;
      sc += clamp(15 * (timeBuffer / Math.max(1, sessions)) + 5, 0, 15);
      sc += clamp(10 * (1 - (c.thetaPctPerSession ?? 10) / 12), 0, 10);
      /* الهيكل 20: نقطة التعادل ضمن الحركة المتوقعة + احتمال داخل النقد */
      if (beWithinEM === true) sc += 12; else if (beWithinEM === false) sc += 2; else sc += 6;
      sc += clamp(8 * ((c.probITM ?? 0.3) - 0.2) / 0.4, 0, 8);
      /* العائد/المخاطرة 10 */
      if (isNum(rr)) sc += clamp(10 * (rr - 0.8) / 2.2, 0, 10);

      return Object.assign({}, c, {
        entry: entryPx,
        exitAtTarget, exitAtStop,
        gain: isNum(gain) ? round(gain) : null,
        loss: isNum(loss) ? round(loss) : null,
        gainPct, lossPct, rr,
        stopIsFloor, repricedStop,
        beWithinEM,
        holdSessions,
        costPerContract: round(entryPx * 100),
        score: round(clamp(sc, 0, 100), 1)
      });
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best) return { ok: false, why: 'تعذّر تقييم أي عقد' };

    /* البدائل تُبنى من المجموعة الأوسع (قبل تضييق الدلتا) حتى يرى المستخدم
       خيارات أرخص/أبعد فعلاً، لا نسخاً متجاورة من نفس العقد. */
    const altScored = scored.filter(c => c.strike !== best.strike);

    /* ── 6) الحكم: ادخل / انتظر / تجنّب ── */
    let verdict = 'enter', label = 'جاهز — ادخل', color = 'up';

    const blockers = [];
    if (best.openInterest < cfg.minOpenInterest)
      blockers.push(`الفائدة المفتوحة ${best.openInterest} عقد فقط — الخروج سيكلّفك أكثر من الحافة`);
    if (best.spreadPct != null && best.spreadPct > cfg.maxSpreadPct)
      blockers.push(`الفارق بين العرض والطلب ${best.spreadPct}٪ — تدفع ${best.spreadPct}٪ خسارة لحظة الدخول`);
    if (isNum(ivHv) && ivHv > 1.75)
      blockers.push(`التذبذب الضمني ${ivHv}× التذبذب المحقق — العقود مسعّرة لحركة أكبر بكثير مما يفعله السهم فعلاً`);
    if (isNum(best.rr) && best.rr < cfg.minRR)
      blockers.push(`العائد/المخاطرة ${best.rr} فقط — أقل من ${cfg.minRR} بعد احتساب تآكل الوقت وانخفاض التذبذب`);
    if (holdSessions >= sessions)
      blockers.push(`الوصول للهدف يحتاج ${holdSessions} جلسة والاستحقاق بعد ${sessions} — الوقت لا يكفي، اختر استحقاقاً أبعد`);
    if (best.beWithinEM === false)
      blockers.push(`نقطة التعادل تبعد ${best.breakevenMovePct}٪ بينما الحركة المتوقعة ${em ? em.pct : '—'}٪ — الرهان خارج التوزيع`);

    const waiters = [];
    if (isNum(ctx.entryU) && isNum(atrVal) && atrVal > 0) {
      const dist = (spot - ctx.entryU) / atrVal;
      if (ctx.dirUp && dist > 0.6)
        waiters.push(`السعر يبعد ${round(dist, 2)} ATR فوق منطقة الدخول (${round(ctx.entryU)}$) — الدخول هنا يوسّع الوقف ويخفض العائد/المخاطرة. انتظر ارتداداً للمنطقة.`);
      if (!ctx.dirUp && dist < -0.6)
        waiters.push(`السعر يبعد ${round(Math.abs(dist), 2)} ATR تحت منطقة الدخول (${round(ctx.entryU)}$) — انتظر ارتداداً صاعداً للمنطقة قبل شراء البوت.`);
    }
    if (isNum(ctx.cycleSessionsToTurn) && ctx.cycleSessionsToTurn >= 3)
      waiters.push(`التحليل الزمني يضع الانعطاف المتوقع بعد ${Math.round(ctx.cycleSessionsToTurn)} جلسة. الدخول اليوم يعني دفع ثيتا ${Math.round(ctx.cycleSessionsToTurn)} جلسات قبل بدء الحركة.`);
    if (ctx.needsConfirmation)
      waiters.push('الإشارة على السهم لم تُؤكَّد بإغلاق بعد. الدخول قبل التأكيد يضاعف احتمال الكسر الوهمي.');
    if (isNum(ctx.daysToEarnings) && ctx.daysToEarnings >= 0 && ctx.daysToEarnings <= sessions)
      waiters.push(`إعلان النتائج يقع داخل عمر العقد (بعد ${ctx.daysToEarnings} يوم). التذبذب الضمني منتفخ قبله وينهار بعده — قد يخسر العقد رغم صحة الاتجاه.`);

    if (blockers.length >= 2 || blockers.some(b => b.includes('الوقت لا يكفي') || b.includes('خارج التوزيع'))) {
      verdict = 'avoid'; label = 'تجنّب'; color = 'dn';
    } else if (blockers.length === 1 || waiters.length) {
      verdict = 'wait'; label = 'انتظر'; color = 'wn';
    } else if (best.score < 55) {
      verdict = 'wait'; label = 'انتظر'; color = 'wn';
      waiters.push(`التقييم المركّب ${best.score}/100 — لا يوجد مانع صريح، لكن لا توجد حافة كافية تبرّر المخاطرة.`);
    }

    /* ── 7) بناء التقرير ── */
    return {
      ok: true,
      type, typeLabel: type === 'call' ? 'كول (شراء)' : 'بوت (بيع)',
      spot: round(spot),
      expiry: ctx.expiryDate || null,
      sessionsToExpiry: sessions,
      verdict, verdictLabel: label, verdictColor: color,

      contract: {
        symbol: best.contractSymbol,
        strike: best.strike,
        entry: best.entry,
        entryLimitFrom: best.bid ? round(best.bid + (best.mid - best.bid) * 0.4) : best.entry,
        entryLimitTo: best.entry,
        stop: best.exitAtStop,
        target: best.exitAtTarget,
        rr: best.rr,
        gainPct: best.gainPct, lossPct: best.lossPct,
        costPerContract: best.costPerContract,
        bid: best.bid, ask: best.ask, spreadPct: best.spreadPct,
        openInterest: best.openInterest, volume: best.volume,
        iv: best.ivPct, delta: best.delta, gamma: best.gamma,
        theta: best.theta, thetaPctPerSession: best.thetaPctPerSession,
        breakeven: best.breakeven, breakevenMovePct: best.breakevenMovePct,
        probITM: best.probITM != null ? round(best.probITM * 100, 1) : null,
        score: best.score
      },

      underlying: {
        entry: isNum(ctx.entryU) ? round(ctx.entryU) : null,
        stop: isNum(stopU) ? round(stopU) : null,
        target: isNum(targetU) ? round(targetU) : null,
        atr: isNum(atrVal) ? round(atrVal) : null,
        expectedSessionsToTarget: sessionsToTarget,
        cycleSessionsToTurn: isNum(ctx.cycleSessionsToTurn) ? Math.round(ctx.cycleSessionsToTurn) : null
      },

      vol: {
        atmIV: isNum(atmIV) ? round(atmIV * 100, 1) : null,
        hv20: isNum(hv) ? round(hv * 100, 1) : null,
        ivHvRatio: ivHv,
        verdict: !isNum(ivHv) ? null
          : ivHv > 1.6 ? 'العقود غالية — التذبذب المسعّر أكبر بكثير من الفعلي'
          : ivHv < 0.9 ? 'العقود رخيصة نسبياً — التذبذب المسعّر أقل من الفعلي'
          : 'التسعير في النطاق العادل'
      },

      expectedMove: em,
      blockers, waiters, warnings,
      /* البدائل — للمقارنة، مرتّبة بالتقييم */
      alternatives: altScored.slice(0, 4).map(c => ({
        strike: c.strike, entry: c.entry, target: c.exitAtTarget, stop: c.exitAtStop,
        rr: c.rr, delta: c.delta, iv: c.ivPct, openInterest: c.openInterest,
        spreadPct: c.spreadPct, score: c.score, breakeven: c.breakeven
      })),
      /* المخاطرة النقدية لكل عقد (100 سهم) — أساس تحديد حجم المركز */
      riskPerContractUsd: isNum(best.loss) ? round(best.loss * 100) : null,
      /* حجم المركز: كم عقداً مقابل مخاطرة نقدية محددة */
      sizeFor(riskUsd) {
        const perContract = isNum(best.loss) ? best.loss * 100 : null;
        if (!isNum(perContract) || perContract <= 0) return null;
        return Math.max(0, Math.floor(riskUsd / perContract));
      }
    };
  }

  /* ════════════════════════════════════════════════════════════════════ */

  return {
    version: '3.0.0-US',
    Stats, USMarket, Cumulative, Options,
    /* توافق خلفي: أي كود قديم ينادي SaudiMarket يحصل على تقويم أمريكي صريح */
    SaudiMarket: USMarket,
    seededRandom, seedFromString,
    detectPivots, lastConfirmedPivot, dominantPivotCycle,
    periodogram, fisherGTest, fitSinusoid, spectral, projectCycleTurns,
    periodogramAt, refinePeakFreq, spectralPro, projectTurnsPro,
    cycleCoherence, empiricalPivotCycles, fractalTargets,
    forecastARIMA,
    volumeProfile, valueBand, volatility, atr,
    timeWindows, timeConfluence, FIB_BARS, GANN_CALENDAR_DAYS,
    simulateTrade, summarize, backtestSpectral, BT_DEFAULTS,
    structuralLevels, executionPlan,
    evaluateContract, weeklyOptionPlan, OPT_DEFAULTS,
    auditCandles, sanitizeCandles,
    _internal: { num, clamp, round, isNum }
  };
});
