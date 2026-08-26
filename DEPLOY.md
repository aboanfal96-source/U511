# خطوات النشر على Vercel

## بنية المجلد (لا تغيّرها)

```
us-market-pro/
├── index.html        ← يجب أن يكون في الجذر
├── engine/
│   └── core.js       ← داخل engine/ تحديداً — الصفحة تستدعيه بالمسار /engine/core.js
├── package.json
├── vercel.json
├── .gitignore
├── README.md
├── DEPLOY.md
└── api/
    ├── stock.js      ← يصبح /api/stock
    ├── options.js    ← يصبح /api/options
    └── _yahoo.js     ← الشرطة السفلية تمنعه من أن يصير مساراً، ويبقى قابلاً للاستيراد
```

الشرطة السفلية في `_yahoo.js` مقصودة: Vercel لا يحوّل الملفات التي تبدأ بها إلى نقاط وصول، لكنه يضمّها في الحزمة عند `require`. لو أزلتها صار الملف مساراً عاماً بلا داعٍ.

## الطريقة الأولى: من الطرفية مباشرة (الأسرع)

```bash
cd us-market-pro
npx vercel login
npx vercel --prod
```

الأسئلة التي ستظهر والإجابات الصحيحة:

| السؤال | الإجابة |
|---|---|
| Set up and deploy? | `y` |
| Which scope? | حسابك |
| Link to existing project? | `n` |
| Project name? | اضغط Enter |
| In which directory is your code located? | `./` |
| Want to modify these settings? | `n` |

بعد دقيقة يعطيك رابطاً. افتحه.

## الطريقة الثانية: عبر GitHub

```bash
cd us-market-pro
git init
git add .
git commit -m "US Market Pro"
git branch -M main
git remote add origin https://github.com/<حسابك>/us-market-pro.git
git push -u origin main
```

ثم في vercel.com: **Add New → Project → Import** المستودع → **Deploy** بلا أي تعديل على الإعدادات. لا تضع Build Command ولا Output Directory — اتركها فارغة.

## التجربة محلياً قبل النشر

```bash
cd us-market-pro
npx vercel dev
```

ثم افتح `http://localhost:3000`.

**مهم:** لا تفتح `index.html` بالنقر المزدوج. الفتح كملف (`file://`) يعطّل `/api/*` بالكامل، فتبقى كل الأسعار تجريبية.

## التحقق أن النشر نجح

بعد فتح الرابط:

1. **لا يظهر شريط أحمر أسفل الشاشة** ⇒ البيانات تصل. لو ظهر، اقرأ السبب المكتوب فيه.
2. افتح مباشرة: `https://<موقعك>.vercel.app/api/stock?symbol=SPY&range=5d&interval=1d`
   يجب أن يعود JSON فيه `chart.result`. لو عاد `404` فمجلد `api/` لم يُرفع أو ليس في الجذر.
3. افتح: `https://<موقعك>.vercel.app/api/options?symbol=AAPL`
   يجب أن يعود JSON فيه `optionChain.result`.

## الأخطاء الشائعة ومعانيها

| ما تراه | المعنى | الحل |
|---|---|---|
| `404` على `/api/stock` | مجلد `api/` ليس في الجذر، أو رُفع داخل مجلد فرعي | تأكد أن `api/` أخٌ لـ `index.html` لا ابنٌ لمجلد آخر |
| `429` | ياهو يخنق الطلبات | أبطئ المسح، أو انتقل لمزوّد مدفوع |
| `401` على `/api/options` فقط | الـ crumb انتهى | الوكيل يجدّده تلقائياً مرة واحدة؛ إن تكرر فالمزوّد شدّد الحماية |
| الشموع تعمل والأوبشن لا | طبيعي — نقطة الأوبشن أكثر تشدداً | جرّب رمزاً كبيراً مثل AAPL أو SPY أولاً |
| صفحة بيضاء، أو الجدول فارغ ولا يستجيب | `core.js` ليس في `engine/` | المسار الصحيح `engine/core.js` بالضبط — الصفحة تطلبه بـ `/engine/core.js`، ووضعه في الجذر يعطّل المحرّك كله |

## بعد النشر

المنصة تعتمد على مزوّد مجاني متأخر ١٥ دقيقة. للتداول الفعلي انتقل إلى Polygon أو Tradier — التعديل محصور في `api/options.js` و`api/stock.js`، ولا يمسّ المحرّك ولا الواجهة.
