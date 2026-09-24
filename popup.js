/**
 * popup.js
 * -----------------------------------------------------------------------------
 * Arayüz mantığı:
 *   - Form verilerini okur/doğrular, chrome.storage.local'a yazar,
 *   - background'a START / STOP mesajı gönderir,
 *   - token durumunu, canlı log'u ve tarama istatistiklerini gösterir.
 *
 * Burada API çağrısı YAPILMAZ. Popup da tıpkı service worker gibi sayfa
 * bağlamı dışında olduğu için istekleri çerezsiz gider.
 * -----------------------------------------------------------------------------
 */
(function () {
  "use strict";

  const CFG = globalThis.TCDD_CONFIG;
  const { MSG, KEYS } = CFG;

  const $ = (id) => document.getElementById(id);

  const els = {
    form: $("form"),
    fromName: $("fromName"),
    fromId: $("fromId"),
    toName: $("toName"),
    toId: $("toId"),
    date: $("date"),
    timeFrom: $("timeFrom"),
    timeTo: $("timeTo"),
    passengerCount: $("passengerCount"),
    gender: $("gender"),
    cabinClass: $("cabinClass"),
    intervalSec: $("intervalSec"),
    preferredWagon: $("preferredWagon"),
    autoSelect: $("autoSelect"),
    debug: $("debug"),
    btnStart: $("btnStart"),
    btnStop: $("btnStop"),
    btnOpenSite: $("btnOpenSite"),
    btnFill: $("btnFillFromCapture"),
    btnClearLog: $("btnClearLog"),
    formError: $("formError"),
    runBadge: $("runBadge"),
    chipAuth: $("chipAuth"),
    chipXsrf: $("chipXsrf"),
    chipCaptcha: $("chipCaptcha"),
    tokenHint: $("tokenHint"),
    stats: $("stats"),
    log: $("log"),
    stationList: $("stationList")
  };

  /* ====================================================================== */
  /* Yardımcılar                                                            */
  /* ====================================================================== */

  function send(type, payload) {
    return chrome.runtime.sendMessage(Object.assign({ type }, payload || {})).catch((e) => ({
      ok: false,
      error: e && e.message
    }));
  }

  function showError(text) {
    els.formError.textContent = text || "";
    els.formError.hidden = !text;
  }

  function fmtTime(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /* ====================================================================== */
  /* Form <-> storage                                                       */
  /* ====================================================================== */

  function readForm() {
    return {
      fromName: els.fromName.value.trim(),
      fromId: Number(els.fromId.value),
      toName: els.toName.value.trim(),
      toId: Number(els.toId.value),
      date: els.date.value,
      timeFrom: els.timeFrom.value || "00:00",
      timeTo: els.timeTo.value || "23:59",
      passengerCount: Number(els.passengerCount.value) || 1,
      gender: els.gender.value,
      cabinClass: els.cabinClass.value,
      intervalSec: Number(els.intervalSec.value) || CFG.DEFAULTS.intervalSec,
      preferredWagon: els.preferredWagon.value ? Number(els.preferredWagon.value) : null,
      autoSelect: els.autoSelect.checked,
      debug: els.debug.checked
    };
  }

  function writeForm(s) {
    if (!s) return;
    if (s.fromName) els.fromName.value = s.fromName;
    if (s.fromId) els.fromId.value = s.fromId;
    if (s.toName) els.toName.value = s.toName;
    if (s.toId) els.toId.value = s.toId;
    if (s.date) els.date.value = s.date;
    if (s.timeFrom) els.timeFrom.value = s.timeFrom;
    if (s.timeTo) els.timeTo.value = s.timeTo;
    if (s.passengerCount) els.passengerCount.value = s.passengerCount;
    if (s.gender) els.gender.value = s.gender;
    if (s.cabinClass) els.cabinClass.value = s.cabinClass;
    if (s.intervalSec) els.intervalSec.value = s.intervalSec;
    if (s.preferredWagon) els.preferredWagon.value = s.preferredWagon;
    if (typeof s.autoSelect === "boolean") els.autoSelect.checked = s.autoSelect;
    if (typeof s.debug === "boolean") els.debug.checked = s.debug;
  }

  function validate(s) {
    if (!s.fromName || !s.fromId) return "Kalkış istasyonu ve ID'si zorunlu.";
    if (!s.toName || !s.toId) return "Varış istasyonu ve ID'si zorunlu.";
    if (s.fromId === s.toId) return "Kalkış ve varış istasyonu aynı olamaz.";
    if (!s.date) return "Tarih seçin.";
    if (s.date < todayISO()) return "Geçmiş bir tarih seçilemez.";
    if (s.timeFrom >= s.timeTo) return "Saat aralığı hatalı (en erken < en geç olmalı).";
    if (s.intervalSec < CFG.DEFAULTS.minIntervalSec) {
      return `Tarama periyodu en az ${CFG.DEFAULTS.minIntervalSec} saniye olmalı.`;
    }
    return null;
  }

  /* ====================================================================== */
  /* Yakalanan aramadan istasyon bilgisi çıkarma                            */
  /* ====================================================================== */

  /** Şablon gövdesindeki istasyon alanlarını derinlemesine arar. */
  function extractRoute(body) {
    const found = { fromId: null, fromName: "", toId: null, toName: "", date: "" };
    (function walk(node, depth) {
      if (!node || typeof node !== "object" || depth > 10) return;
      if (Array.isArray(node)) return node.forEach((x) => walk(x, depth + 1));

      for (const key of Object.keys(node)) {
        const v = node[key];
        if (/^departureStationId$/i.test(key) && found.fromId === null) found.fromId = v;
        else if (/^departureStationName$/i.test(key) && !found.fromName) found.fromName = String(v || "");
        else if (/^arrivalStationId$/i.test(key) && found.toId === null) found.toId = v;
        else if (/^arrivalStationName$/i.test(key) && !found.toName) found.toName = String(v || "");
        else if (/^departureDate$/i.test(key) && !found.date && typeof v === "string") found.date = v;
        if (v && typeof v === "object") walk(v, depth + 1);
      }
    })(body, 0);
    return found;
  }

  /** "25-09-2026 00:00:00" -> "2026-09-25" */
  function apiDateToISO(text) {
    const m = String(text || "").match(/^(\d{2})-(\d{2})-(\d{4})/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
  }

  async function fillFromCapture() {
    const data = await chrome.storage.local.get([KEYS.templates, KEYS.stations]);
    const tpl = (data[KEYS.templates] || {}).availability;
    if (!tpl || !tpl.body) {
      showError("Henüz yakalanmış bir arama yok. Önce TCDD sayfasında manuel arama yapın.");
      return;
    }

    const route = extractRoute(tpl.body);
    if (route.fromId) els.fromId.value = route.fromId;
    if (route.fromName) els.fromName.value = route.fromName;
    if (route.toId) els.toId.value = route.toId;
    if (route.toName) els.toName.value = route.toName;
    const iso = apiDateToISO(route.date);
    if (iso && iso >= todayISO()) els.date.value = iso;

    // İstasyon önbelleğini güncelle (datalist için).
    const stations = data[KEYS.stations] || { list: [] };
    const add = (id, name) => {
      if (!id || !name) return;
      if (!stations.list.some((x) => String(x.id) === String(id))) stations.list.push({ id, name });
    };
    add(route.fromId, route.fromName);
    add(route.toId, route.toName);
    stations.fetchedAt = Date.now();
    await chrome.storage.local.set({ [KEYS.stations]: stations });

    renderStations(stations);
    showError("");
  }

  function renderStations(stations) {
    const list = (stations && stations.list) || [];
    els.stationList.innerHTML = "";
    for (const st of list) {
      const opt = document.createElement("option");
      opt.value = st.name;
      opt.label = `${st.name} (#${st.id})`;
      els.stationList.appendChild(opt);
    }
  }

  /** Datalist'ten isim seçildiğinde ID'yi otomatik doldur. */
  async function autofillId(nameInput, idInput) {
    const data = await chrome.storage.local.get([KEYS.stations]);
    const list = ((data[KEYS.stations] || {}).list) || [];
    const hit = list.find((x) => x.name === nameInput.value.trim());
    if (hit) idInput.value = hit.id;
  }

  /* ====================================================================== */
  /* Durum gösterimi                                                        */
  /* ====================================================================== */

  function renderTokens(present, meta) {
    const set = (el, on) => {
      el.classList.toggle("on", !!on);
      el.classList.toggle("off", !on);
    };
    set(els.chipAuth, present.authorization);
    set(els.chipXsrf, present["x-tms-xsrf-token"]);
    set(els.chipCaptcha, present["captcha-session"]);

    const missing = [];
    if (!present.authorization) missing.push("Authorization");
    if (!present["x-tms-xsrf-token"]) missing.push("X-Tms-Xsrf-Token");

    if (missing.length) {
      els.tokenHint.textContent = `Eksik: ${missing.join(", ")} — TCDD sayfasında bir kez manuel arama yapın.`;
    } else {
      els.tokenHint.textContent = `Token'lar hazır. Son yakalama: ${fmtTime(meta && meta.capturedAt)}${
        present["captcha-session"] ? "" : " (Captcha-Session henüz görülmedi)"
      }`;
    }
  }

  function renderState(state) {
    const badge = els.runBadge;
    badge.className = "badge";
    if (state.running && state.paused) {
      badge.classList.add("badge-pause");
      badge.textContent = state.reason === "auth" ? "Captcha bekleniyor" : "Duraklatıldı";
    } else if (state.running) {
      badge.classList.add("badge-run");
      badge.textContent = "Taranıyor";
    } else if (state.reason === "selected") {
      badge.classList.add("badge-done");
      badge.textContent = "Bilet seçildi";
    } else {
      badge.classList.add("badge-idle");
      badge.textContent = "Beklemede";
    }

    els.btnStart.disabled = !!state.running;
    els.btnStop.disabled = !state.running;

    const parts = [];
    parts.push(`Tarama: ${state.scanCount || 0}`);
    if (state.lastScanAt) parts.push(`Son: ${fmtTime(state.lastScanAt)}`);
    if (state.found) {
      parts.push(`Bulunan: ${state.found.trainLabel} (${(state.found.seats || []).length} koltuk)`);
    }
    els.stats.textContent = parts.join(" · ");
  }

  function appendLogLine(line) {
    const li = document.createElement("li");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = fmtTime(line.at);
    const s = document.createElement("span");
    s.className = line.level || "info";
    s.textContent = line.text;
    li.append(t, s);
    els.log.appendChild(li);
    while (els.log.children.length > 120) els.log.removeChild(els.log.firstChild);
    els.log.scrollTop = els.log.scrollHeight;
  }

  function renderLog(lines) {
    els.log.innerHTML = "";
    (lines || []).slice(-120).forEach(appendLogLine);
  }

  /* ====================================================================== */
  /* Olaylar                                                                */
  /* ====================================================================== */

  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");

    const settings = readForm();
    const err = validate(settings);
    if (err) return showError(err);

    await chrome.storage.local.set({ [KEYS.settings]: settings });
    els.btnStart.disabled = true;

    const res = await send(MSG.START, { settings });
    if (!res || !res.ok) {
      showError(res && res.error ? res.error : "Tarama başlatılamadı.");
      els.btnStart.disabled = false;
    }
    refresh();
  });

  els.btnStop.addEventListener("click", async () => {
    await send(MSG.STOP);
    refresh();
  });

  els.btnOpenSite.addEventListener("click", async () => {
    await send(MSG.OPEN_TCDD);
    window.close();
  });

  els.btnFill.addEventListener("click", fillFromCapture);

  els.btnClearLog.addEventListener("click", async () => {
    await send(MSG.CLEAR_LOG);
    els.log.innerHTML = "";
  });

  els.fromName.addEventListener("change", () => autofillId(els.fromName, els.fromId));
  els.toName.addEventListener("change", () => autofillId(els.toName, els.toId));

  // Background'dan gelen canlı güncellemeler
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === MSG.LOG && msg.line) appendLogLine(msg.line);
    if (msg.type === MSG.STATE_CHANGED) {
      if (msg.state) renderState(msg.state);
      if (msg.headersPresent) renderTokens(msg.headersPresent, msg.headersMeta);
    }
  });

  /* ====================================================================== */
  /* Başlangıç                                                              */
  /* ====================================================================== */

  async function refresh() {
    const res = await send(MSG.GET_STATUS);
    if (!res || !res.ok) return;
    renderState(res.state || {});
    renderTokens(res.headersPresent || {}, res.headersMeta || {});
    renderLog(res.log);
    if (!res.tabOpen) {
      els.tokenHint.textContent = "TCDD sekmesi açık değil. Tarama için sekmenin açık kalması gerekir.";
    }
  }

  (async function init() {
    const data = await chrome.storage.local.get([KEYS.settings, KEYS.stations]);
    els.date.min = todayISO();
    els.date.value = todayISO();
    writeForm(data[KEYS.settings]);
    renderStations(data[KEYS.stations]);
    await refresh();
  })();
})();
