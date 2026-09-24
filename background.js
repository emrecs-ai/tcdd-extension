/**
 * background.js  (MV3 Service Worker)
 * -----------------------------------------------------------------------------
 * GÖREVLERİ (bilerek sınırlı tutulmuştur):
 *   1. chrome.webRequest.onBeforeSendHeaders ile TCDD trafiğini dinleyip
 *      Authorization (JWT), X-Tms-Xsrf-Token ve Captcha-Session başlıklarını
 *      yakalamak ve chrome.storage.local'a yazmak.
 *   2. Popup'tan gelen Başla/Dur komutlarını almak, TCDD sekmesini bulmak /
 *      açmak ve content script'i oraya enjekte etmek.
 *   3. Content script'ten gelen olayları (koltuk bulundu, oturum doldu, hata)
 *      bildirimlere ve duruma dönüştürmek.
 *
 * BURADA ASLA API İSTEĞİ ATILMAZ. Service worker'dan atılan fetch çağrıları
 * çerezleri taşımadığı için 403 alır; tüm API trafiği content.js -> injected.js
 * zinciri üzerinden sayfa bağlamında yürütülür.
 * -----------------------------------------------------------------------------
 */

import "./src/config.js";

const CFG = globalThis.TCDD_CONFIG;
const { KEYS, MSG, NOTIF } = CFG;

const log = (...a) => console.log("%c[TCDD/bg]", "color:#1864ab;font-weight:600", ...a);
const warn = (...a) => console.warn("%c[TCDD/bg]", "color:#e8590c;font-weight:600", ...a);

/* ========================================================================== */
/* Depolama yardımcıları                                                      */
/* ========================================================================== */

async function getStore(key, fallback) {
  const data = await chrome.storage.local.get(key);
  return data[key] === undefined ? fallback : data[key];
}

async function setStore(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

const DEFAULT_STATE = {
  running: false,
  paused: false,
  reason: "",
  tabId: null,
  startedAt: null,
  lastScanAt: null,
  scanCount: 0,
  found: null
};

async function getState() {
  return Object.assign({}, DEFAULT_STATE, await getStore(KEYS.state, {}));
}

async function setState(patch) {
  const next = Object.assign(await getState(), patch);
  await setStore(KEYS.state, next);
  broadcast(MSG.STATE_CHANGED, { state: next });
  return next;
}

/** Popup açıksa haberdar et; kapalıysa hatayı yut. */
function broadcast(type, payload) {
  chrome.runtime.sendMessage(Object.assign({ type }, payload)).catch(() => {});
}

async function appendLog(level, text) {
  const line = { at: Date.now(), level, text: String(text) };
  const list = await getStore(KEYS.log, []);
  list.push(line);
  while (list.length > CFG.LOG_LIMIT) list.shift();
  await setStore(KEYS.log, list);
  broadcast(MSG.LOG, { line });
  log(`[${level}]`, text);
}

/* ========================================================================== */
/* Bildirimler                                                                */
/* ========================================================================== */

function notify(id, title, message, opts) {
  const options = Object.assign(
    {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
      priority: 2
    },
    opts || {}
  );
  // Aynı id ile tekrar oluşturmak eskisini günceller.
  chrome.notifications.create(id + ":" + Date.now(), options, () => {
    if (chrome.runtime.lastError) warn("Bildirim hatası:", chrome.runtime.lastError.message);
  });
}

/* ========================================================================== */
/* 1) Token yakalayıcı                                                        */
/* ========================================================================== */

/** Yakalanan başlıkların değişip değişmediğini anlamak için kısa imza. */
function headerSignature(headers) {
  return [
    (headers["authorization"] || "").slice(-24),
    (headers["x-tms-xsrf-token"] || "").slice(-16),
    (headers["captcha-session"] || "").slice(-16)
  ].join("|");
}

let lastSignature = "";

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      if (!details.requestHeaders) return;
      if (!/\/tms\//i.test(details.url)) return;

      const picked = {};
      for (const h of details.requestHeaders) {
        const name = String(h.name || "").toLowerCase();
        if (CFG.CAPTURE_HEADERS.includes(name) && h.value) {
          picked[name] = h.value;
        }
      }
      if (!Object.keys(picked).length) return;

      let apiBase = null;
      try {
        apiBase = new URL(details.url).origin;
      } catch (e) {
        /* yoksay */
      }

      storeHeaders(picked, apiBase, "webRequest");
    } catch (e) {
      warn("Header yakalama hatası:", e);
    }
  },
  { urls: ["https://*.tcddtasimacilik.gov.tr/*"] },
  ["requestHeaders", "extraHeaders"]
);

/**
 * Yakalanan başlıkları birleştirip saklar.
 * Sadece yeni gelen alanlar güncellenir; böylece bir istekte Captcha-Session,
 * diğerinde Authorization gelse bile elimizde tam set kalır.
 */
async function storeHeaders(picked, apiBase, source) {
  const current = await getStore(KEYS.headers, {});
  const merged = Object.assign({}, current, picked);
  // content-type'ı sabitliyoruz, sayfadan gelen multipart vb. değerleri taşımayalım.
  merged["content-type"] = "application/json";

  const signature = headerSignature(merged);
  const meta = {
    apiBase: apiBase || (await getStore(KEYS.headersMeta, {})).apiBase || CFG.API_BASE_FALLBACK,
    capturedAt: Date.now(),
    source
  };

  await chrome.storage.local.set({ [KEYS.headers]: merged, [KEYS.headersMeta]: meta });

  if (signature !== lastSignature) {
    lastSignature = signature;
    const missing = CFG.REQUIRED_HEADERS.filter((k) => !merged[k]);
    await appendLog(
      "info",
      `Yeni oturum bilgisi yakalandı (${source}). Eksik başlık: ${missing.length ? missing.join(", ") : "yok"}`
    );
    broadcast(MSG.STATE_CHANGED, { headersMeta: meta, headersPresent: presentMap(merged) });
    await maybeResumeAfterCaptcha(merged);
  }
}

/** Popup'a gönderilen şablon (uç nokta) özeti. */
function templateInfo(templates) {
  const out = {};
  for (const kind of ["availability", "seatMap"]) {
    const t = (templates || {})[kind];
    out[kind] = t && t.url ? { url: t.url, at: t.at } : null;
  }
  return out;
}

function presentMap(headers) {
  return {
    authorization: !!headers["authorization"],
    "x-tms-xsrf-token": !!headers["x-tms-xsrf-token"],
    "captcha-session": !!headers["captcha-session"]
  };
}

/**
 * Kullanıcı Captcha'yı çözüp manuel arama yaptığında yeni token'lar yakalanır.
 * Tarama "auth" nedeniyle duraklatılmışsa kaldığı yerden devam ettirilir.
 */
async function maybeResumeAfterCaptcha(headers) {
  const state = await getState();
  if (!state.running || !state.paused || state.reason !== "auth") return;

  const missing = CFG.REQUIRED_HEADERS.filter((k) => !headers[k]);
  if (missing.length) return;

  await appendLog("ok", "Güncel token yakalandı, tarama kaldığı yerden devam ediyor.");
  await setState({ paused: false, reason: "" });
  notify(NOTIF.INFO, "Tarama devam ediyor", "Yeni güvenlik bilgileri alındı, koltuk taraması kaldığı yerden sürüyor.");
  const settings = await getStore(KEYS.settings, null);
  if (settings) await startContentScan(settings, { resumed: true });
}

/**
 * İstek şablonunu (gerçek URL + gövde) saklar.
 * İki kaynaktan gelebilir: sayfa bağlamındaki fetch/XHR hook'u ya da
 * aşağıdaki webRequest dinleyicisi.
 */
async function storeTemplate(kind, url, body, source) {
  if (!kind || !url || !body) return false;
  const templates = await getStore(KEYS.templates, {});
  const prev = templates[kind];
  templates[kind] = { url, body, at: Date.now(), source: source || "page" };
  await setStore(KEYS.templates, templates);

  if (!prev || prev.url !== url) {
    await appendLog("ok", `İstek şablonu yakalandı [${kind}] (${source || "page"}): ${url}`);
  }
  broadcast(MSG.STATE_CHANGED, { templates: templateInfo(templates) });
  return true;
}

/**
 * Şablonu doğrudan ağ trafiğinden yakalar.
 *
 * Bu yol content script'e BAĞIMLI DEĞİLDİR. Eklenti yenilendiğinde açık
 * sekmelerdeki content script ölür ve otomatik olarak yeniden enjekte edilmez;
 * o durumda sayfa bağlamındaki hook çalışmadığı için şablon yakalanamıyordu.
 * webRequest arka planda yaşadığından kullanıcının manuel araması her hâlükârda
 * görülür.
 */
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      if (details.method !== "POST") return;
      if (!/\/tms\//i.test(details.url)) return;

      const match = CFG.matchEndpoint(details.url);
      if (!match || match.kind === "stationPairs") return;

      const raw = details.requestBody && details.requestBody.raw;
      if (!raw || !raw.length) return;

      // Gövde birden fazla parçaya bölünmüş olabilir.
      const decoder = new TextDecoder("utf-8");
      let text = "";
      for (const part of raw) {
        if (part && part.bytes) text += decoder.decode(part.bytes, { stream: true });
      }
      text += decoder.decode();
      if (!text || text.length > 200000) return;

      let body = null;
      try {
        body = JSON.parse(text);
      } catch (e) {
        return; // JSON olmayan gövdeler şablon olarak kullanılamaz
      }
      storeTemplate(match.kind, details.url, body, "webRequest");
    } catch (e) {
      warn("Gövde yakalama hatası:", e);
    }
  },
  { urls: ["https://*.tcddtasimacilik.gov.tr/*"] },
  ["requestBody"]
);

/* ========================================================================== */
/* 2) Sekme yönetimi ve content script enjeksiyonu                            */
/* ========================================================================== */

const TCDD_URL_MATCH = "https://ebilet.tcddtasimacilik.gov.tr/*";

async function findTcddTab() {
  const tabs = await chrome.tabs.query({ url: TCDD_URL_MATCH });
  if (!tabs.length) return null;
  // Aktif olan varsa onu tercih et.
  return tabs.find((t) => t.active) || tabs[0];
}

async function ensureTcddTab(openIfMissing) {
  let tab = await findTcddTab();
  if (!tab && openIfMissing) {
    tab = await chrome.tabs.create({ url: CFG.SITE_ORIGIN, active: true });
    await appendLog("info", "TCDD sekmesi açıldı, sayfanın yüklenmesi bekleniyor.");
    await waitForTabComplete(tab.id, 30000);
  }
  return tab;
}

function waitForTabComplete(tabId, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, timeout || 30000);
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") finish();
    }
    function finish() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/**
 * Sayfa bağlamı (MAIN world) köprüsünü enjekte eder.
 * <script src> ile enjeksiyon sayfanın CSP'sine takılabildiği için
 * öncelikli yol chrome.scripting + world:"MAIN" olmalıdır.
 */
async function injectMainWorld(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/injected.js"],
      world: "MAIN"
    });
    return true;
  } catch (e) {
    warn("MAIN world enjeksiyonu başarısız:", e.message);
    return false;
  }
}

/**
 * Açık TCDD sekmelerine content script'i enjekte eder.
 * Eklenti kurulduğunda/güncellendiğinde açık sekmeler content script'siz kalır;
 * bu da sayfa bağlamındaki yakalamayı sessizce devre dışı bırakır.
 */
async function injectIntoOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: TCDD_URL_MATCH });
    for (const tab of tabs) {
      const ok = await ensureContentScript(tab.id);
      if (ok) await appendLog("info", `Açık TCDD sekmesine bağlanıldı (#${tab.id}).`);
    }
  } catch (e) {
    warn("Açık sekmelere enjeksiyon hatası:", e);
  }
}

/** Content script yaşıyor mu? */
async function pingContent(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: MSG.CONTENT_PING });
    return !!(res && res.pong);
  } catch (e) {
    return false;
  }
}

/**
 * Content script'i garantiye alır.
 * manifest'teki content_scripts zaten enjekte eder; ancak eklenti kurulduktan
 * sonra açık kalan sekmelerde script bulunmaz. Bu yüzden scripting API ile
 * gerekirse elle enjekte ediyoruz.
 */
async function ensureContentScript(tabId) {
  await injectMainWorld(tabId); // köprü her durumda güncel olsun
  if (await pingContent(tabId)) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/config.js", "src/dom-utils.js", "content.js"]
    });
    await new Promise((r) => setTimeout(r, 300));
    const ok = await pingContent(tabId);
    await appendLog(ok ? "ok" : "error", ok ? "Content script enjekte edildi." : "Content script enjekte edilemedi.");
    return ok;
  } catch (e) {
    await appendLog("error", "Enjeksiyon hatası: " + e.message);
    return false;
  }
}

/* ========================================================================== */
/* 3) Tarama orkestrasyonu                                                    */
/* ========================================================================== */

async function startContentScan(settings, opts) {
  const tab = await ensureTcddTab(true);
  if (!tab) {
    await appendLog("error", "TCDD sekmesi bulunamadı/açılamadı.");
    return { ok: false, error: "TCDD sekmesi açılamadı." };
  }

  const ready = await ensureContentScript(tab.id);
  if (!ready) {
    return { ok: false, error: "Content script çalıştırılamadı. Sayfayı yenileyip tekrar deneyin." };
  }

  await setState({ tabId: tab.id });

  try {
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: MSG.CONTENT_START,
      settings,
      resumed: !!(opts && opts.resumed)
    });
    return res || { ok: true };
  } catch (e) {
    await appendLog("error", "Content script'e komut gönderilemedi: " + e.message);
    return { ok: false, error: e.message };
  }
}

async function stopContentScan(reasonText) {
  const state = await getState();
  if (state.tabId) {
    try {
      await chrome.tabs.sendMessage(state.tabId, { type: MSG.CONTENT_STOP, reason: reasonText || "" });
    } catch (e) {
      /* sekme kapanmış olabilir */
    }
  }
}

async function handleStart(settings) {
  const headers = await getStore(KEYS.headers, {});
  const missing = CFG.REQUIRED_HEADERS.filter((k) => !headers[k]);
  if (missing.length) {
    const text =
      "Güvenlik bilgileri henüz yakalanmadı. Lütfen TCDD sayfasında bir kez manuel arama yapın (Captcha'yı çözün), sonra tekrar başlatın.";
    await appendLog("error", text + ` Eksik: ${missing.join(", ")}`);
    notify(NOTIF.AUTH, "Önce manuel arama gerekli", text);
    return { ok: false, error: text };
  }

  await setStore(KEYS.settings, settings);
  await setState({
    running: true,
    paused: false,
    reason: "",
    startedAt: Date.now(),
    scanCount: 0,
    found: null
  });
  await appendLog("ok", `Tarama başlatıldı: ${settings.fromName} -> ${settings.toName} / ${settings.date}`);

  const res = await startContentScan(settings, {});
  if (!res.ok) {
    await setState({ running: false, reason: res.error || "" });
  }
  await ensureWatchdog(true);
  return res;
}

async function handleStop(reasonText) {
  await stopContentScan(reasonText);
  await setState({ running: false, paused: false, reason: reasonText || "" });
  await ensureWatchdog(false);
  await appendLog("info", "Tarama durduruldu." + (reasonText ? ` (${reasonText})` : ""));
  return { ok: true };
}

/* ========================================================================== */
/* 4) Watchdog: sekme yenilenirse taramayı geri getir                         */
/* ========================================================================== */

const ALARM = "tcdd-watchdog";

async function ensureWatchdog(enable) {
  if (enable) {
    await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  } else {
    await chrome.alarms.clear(ALARM);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  const state = await getState();
  if (!state.running || state.paused) return;

  const tab = await findTcddTab();
  if (!tab) {
    await appendLog("warn", "TCDD sekmesi kapalı, tarama duraklatıldı.");
    await setState({ paused: true, reason: "tab" });
    notify(NOTIF.ERROR, "Sekme kapandı", "TCDD sekmesi kapatıldığı için tarama duraklatıldı.");
    return;
  }

  const alive = await pingContent(tab.id);
  if (!alive) {
    await appendLog("warn", "Content script yanıt vermiyor, yeniden enjekte ediliyor.");
    const settings = await getStore(KEYS.settings, null);
    if (settings) await startContentScan(settings, { resumed: true });
  }
});

/** Sayfa yenilendiğinde taramayı otomatik devam ettir. */
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  if (!tab.url || !tab.url.startsWith(CFG.SITE_ORIGIN)) return;

  const state = await getState();
  if (!state.running || state.paused) return;
  if (state.tabId && state.tabId !== tabId) return;

  await appendLog("info", "Sayfa yenilendi, tarama yeniden bağlanıyor.");
  const settings = await getStore(KEYS.settings, null);
  if (settings) {
    setTimeout(() => startContentScan(settings, { resumed: true }), 1500);
  }
});

/* ========================================================================== */
/* 5) Mesaj yönlendirici                                                      */
/* ========================================================================== */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        /* ---- popup -> background ---- */
        case MSG.START:
          sendResponse(await handleStart(msg.settings));
          break;

        case MSG.STOP:
          sendResponse(await handleStop("Kullanıcı durdurdu"));
          break;

        case MSG.GET_STATUS: {
          const [state, headers, meta, logLines, settings, templates] = await Promise.all([
            getState(),
            getStore(KEYS.headers, {}),
            getStore(KEYS.headersMeta, {}),
            getStore(KEYS.log, []),
            getStore(KEYS.settings, null),
            getStore(KEYS.templates, {})
          ]);
          const tab = await findTcddTab();
          sendResponse({
            ok: true,
            state,
            settings,
            headersPresent: presentMap(headers),
            headersMeta: meta,
            templates: templateInfo(templates),
            log: logLines,
            tabOpen: !!tab
          });
          break;
        }

        case MSG.CLEAR_LOG:
          await setStore(KEYS.log, []);
          sendResponse({ ok: true });
          break;

        case MSG.OPEN_TCDD: {
          const tab = await ensureTcddTab(true);
          if (tab) await chrome.tabs.update(tab.id, { active: true });
          sendResponse({ ok: !!tab });
          break;
        }

        /* ---- content -> background ---- */
        case MSG.CAPTURED_HEADERS:
          // Sayfa bağlamından (fetch/XHR hook) yakalanan başlıklar.
          await storeHeaders(msg.headers || {}, msg.apiBase || null, "page");
          sendResponse({ ok: true });
          break;

        case MSG.READ_PAGE: {
          // Popup -> açık TCDD sekmesi: ekrandaki istasyon/tarih/saat bilgisi.
          const tab = await findTcddTab();
          if (!tab) {
            sendResponse({ ok: false, error: "TCDD sekmesi açık değil." });
            break;
          }
          if (!(await ensureContentScript(tab.id))) {
            sendResponse({ ok: false, error: "Sayfaya bağlanılamadı. TCDD sayfasını yenileyin." });
            break;
          }
          try {
            sendResponse(await chrome.tabs.sendMessage(tab.id, { type: MSG.READ_PAGE }));
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        }

        case MSG.CAPTURED_TEMPLATE:
          await storeTemplate(msg.kind, msg.url, msg.body, "page");
          sendResponse({ ok: true });
          break;

        case MSG.INJECT_MAIN: {
          // Sayfa bağlamı köprüsünü CSP'den etkilenmeyen yoldan enjekte et.
          const tabId = sender && sender.tab && sender.tab.id;
          sendResponse({ ok: tabId ? await injectMainWorld(tabId) : false });
          break;
        }

        case MSG.CAPTURED_TIMETABLE: {
          /**
           * Güzergâhın kalkış saatleri, SON taramanın sonucuyla değiştirilir
           * (birleştirilmez). Birleştirme, ayrıştırma mantığı değiştiğinde eski
           * ve yanlış okunmuş saatlerin (ör. saat dilimi düzeltmesinden önceki
           * UTC değerleri) listede kalıcı olarak birikmesine yol açıyordu.
           */
          const all = await getStore(KEYS.timetables, {});
          const times = Array.from(new Set(msg.times || [])).sort();
          all[msg.routeKey] = { label: msg.label || "", times: times.slice(0, 40), at: Date.now() };
          await setStore(KEYS.timetables, all);
          sendResponse({ ok: true, count: times.length });
          break;
        }

        case MSG.AUTH_EXPIRED: {
          await setState({ paused: true, reason: "auth" });
          lastSignature = ""; // sonraki yakalama "yeni" sayılsın ki devam tetiklensin
          const text =
            "Güvenlik süresi doldu. Lütfen TCDD sayfasını yenileyip manuel bir arama yaparak Captcha'yı çözün.";
          await appendLog("error", `Oturum/Captcha süresi doldu (HTTP ${msg.status}). Tarama duraklatıldı.`);
          notify(NOTIF.AUTH, "TCDD Koltuk Tarayıcı", text, { requireInteraction: true });
          sendResponse({ ok: true });
          break;
        }

        case MSG.SEATS_FOUND: {
          await setState({ found: msg.result, lastScanAt: Date.now() });
          const s = msg.result || {};
          const seatText = (s.seats || [])
            .slice(0, 5)
            .map((x) => `${x.wagon}. vagon / ${x.seatNo}`)
            .join(", ");
          await appendLog("ok", `BOŞ KOLTUK: ${s.trainLabel || ""} -> ${seatText || s.emptyCount + " koltuk"}`);
          notify(
            NOTIF.FOUND,
            "Boş koltuk bulundu!",
            `${s.trainLabel || "Sefer"}\n${seatText || (s.emptyCount || 0) + " boş koltuk"}\nOtomatik seçim başlıyor...`,
            { requireInteraction: true }
          );
          sendResponse({ ok: true });
          break;
        }

        case MSG.TICKET_SELECTED: {
          await setState({ running: false, paused: false, reason: "selected" });
          await ensureWatchdog(false);
          await appendLog("ok", "Bilet seçildi. Ödeme adımı kullanıcıya bırakıldı.");
          notify(NOTIF.DONE, "Bilet Seçildi, Ödeme Yapın", msg.detail || "Koltuk seçimi tamamlandı, ödeme adımına geçebilirsiniz.", {
            requireInteraction: true
          });
          sendResponse({ ok: true });
          break;
        }

        case MSG.AUTOMATION_FAILED: {
          await setState({ running: false, reason: "automation" });
          await ensureWatchdog(false);
          await appendLog("error", "Otomasyon hatası: " + msg.error);
          notify(
            NOTIF.ERROR,
            "Otomatik seçim tamamlanamadı",
            `${msg.error}\nKoltuk bulundu ancak seçim adımı tamamlanamadı, lütfen sayfadan manuel devam edin.`,
            { requireInteraction: true }
          );
          sendResponse({ ok: true });
          break;
        }

        case MSG.LOG:
          await appendLog(msg.level || "info", msg.text);
          if (msg.scanTick) await setState({ lastScanAt: Date.now(), scanCount: (await getState()).scanCount + 1 });
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: "Bilinmeyen mesaj tipi: " + (msg && msg.type) });
      }
    } catch (e) {
      warn("Mesaj işleme hatası:", e);
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();

  return true; // asenkron yanıt
});

/* ========================================================================== */
/* Kurulum                                                                    */
/* ========================================================================== */

chrome.runtime.onInstalled.addListener(async (details) => {
  await setState(DEFAULT_STATE);

  if (details && details.reason === "update") {
    // Ayrıştırma mantığı sürümler arasında değişebildiği için öğrenilen
    // saatler güncellemede sıfırlanır; ilk taramada yeniden doldurulur.
    await setStore(KEYS.timetables, {});
    await appendLog("info", "Eklenti güncellendi. Öğrenilen sefer saatleri sıfırlandı.");
    await injectIntoOpenTabs();
    return;
  }

  await appendLog("info", "Eklenti kuruldu. TCDD sayfasında bir kez manuel arama yapmanız gerekir.");
  await injectIntoOpenTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  // Tarayıcı yeniden açıldığında tarama otomatik başlamasın.
  await setState({ running: false, paused: false, reason: "browser-restart" });
  await injectIntoOpenTabs();
});

// Service worker uyandığında da açık sekmelerle bağı tazele.
injectIntoOpenTabs();

log("Service worker hazır.");
