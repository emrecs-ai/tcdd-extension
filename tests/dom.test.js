/**
 * tests/dom.test.js
 * -----------------------------------------------------------------------------
 * DOM tarafını gerçek TCDD sefer listesine benzeyen bir sayfa üzerinde sınar:
 *   - sayfadan istasyon / tarih / sefer saati okuma (readPageContext)
 *   - hedef seferin kartını bulma (findTrainRow)
 *
 * En kritik kural: eşleşme kartın İLK saat hücresine (kalkış) bakılarak yapılır.
 * Saati kartın herhangi bir yerinde aramak, varış saatiyle eşleşip yanlış
 * sefere tıklanmasına yol açıyordu.
 *
 * Çalıştırma:  node tests/dom.test.js     (Chromium gerektirir)
 * -----------------------------------------------------------------------------
 */
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FIXTURE = path.join(__dirname, "fixtures", "sefer-listesi.html");

let chromium;
try {
  ({ chromium } = require("/opt/node22/lib/node_modules/playwright"));
} catch (e) {
  try {
    ({ chromium } = require("playwright"));
  } catch (e2) {
    console.log("ATLANDI: playwright bulunamadı (DOM testleri tarayıcı gerektirir).");
    process.exit(0);
  }
}

const fs = require("fs");
let failed = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name, extra === undefined ? "" : JSON.stringify(extra));
  if (!cond) failed++;
};

const CHROME_STUB = () => {
  window.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      getURL: () => "about:blank",
      sendMessage: async () => ({ ok: true })
    },
    storage: { local: { get: async () => ({}), set: async () => {} } }
  };
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  await page.addInitScript(CHROME_STUB);
  await page.goto("file://" + FIXTURE);
  for (const f of ["src/config.js", "src/dom-utils.js", "content.js"]) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, f), "utf8") });
  }

  /* ---- Sayfadan okuma ---- */
  const ctx = await page.evaluate(() => window.__TCDD_DEBUG__.readPageContext());
  check("istasyonlar okundu", /SÖĞÜTLÜÇEŞME/.test(ctx.fromName) && /ANKARA/.test(ctx.toName), [ctx.fromName, ctx.toName]);
  check("tarih okundu", ctx.date === "2026-09-27", ctx.date);
  check("yalnızca kalkış saatleri", ctx.times.join(",") === "05:30,07:20,15:40", ctx.times);
  check("varış saatleri listeye girmiyor", !ctx.times.some((t) => ["09:59", "11:31", "20:15"].includes(t)));

  /* ---- Kart eşleştirme ---- */
  const rows = await page.evaluate(() => {
    const D = window.__TCDD_DEBUG__;
    const label = (el) => (el && el.querySelector(".baslik") ? el.querySelector(".baslik").textContent : el ? el.className : null);
    return {
      kalkis0530: label(D.findTrainRow("05:30")),
      kalkis1540: label(D.findTrainRow("15:40")),
      varis0959: label(D.findTrainRow("09:59")),
      varis2015: label(D.findTrainRow("20:15")),
      olmayan: label(D.findTrainRow("13:05"))
    };
  });
  check("kalkış 05:30 doğru kartı buluyor", /81002/.test(rows.kalkis0530 || ""), rows.kalkis0530);
  check("kalkış 15:40 doğru kartı buluyor", /81016/.test(rows.kalkis1540 || ""), rows.kalkis1540);
  check("VARIŞ saati 09:59 kart eşleştirmiyor", rows.varis0959 === null, rows.varis0959);
  check("VARIŞ saati 20:15 kart eşleştirmiyor", rows.varis2015 === null, rows.varis2015);
  check("listede olmayan saat eşleşmiyor", rows.olmayan === null, rows.olmayan);

  check("sayfada JS hatası yok", errors.length === 0, errors);
  await browser.close();

  console.log(failed ? `\n${failed} test BAŞARISIZ` : "\nTüm DOM testleri geçti");
  process.exit(failed ? 1 : 0);
})();
