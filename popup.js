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
    includeWheelchair: $("includeWheelchair"),
    wheelchairHint: $("wheelchairHint"),
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
    chipEndpoint: $("chipEndpoint"),
    tokenHint: $("tokenHint"),
    stats: $("stats"),
    log: $("log"),
    stationList: $("stationList"),
    timetableWrap: $("timetableWrap"),
    timetableLabel: $("timetableLabel"),
    timetableHint: $("timetableHint"),
    timeChips: $("timeChips"),
    btnTimesAll: $("btnTimesAll"),
    btnTimesNone: $("btnTimesNone"),
    timeFromField: $("timeFromField"),
    timeToField: $("timeToField")
  };

  /** Tarifeden seçilen sefer saatleri. Boşsa saat aralığı kullanılır. */
  let selectedTimes = new Set();

  /** Taramalardan öğrenilmiş tarifeler: { "<fromId>-<toId>": { label, times } } */
  let learnedTimetables = {};

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
  /* Vagon tipleri ve tarife                                                */
  /* ====================================================================== */

  function renderCabinClasses() {
    els.cabinClass.innerHTML = "";
    for (const c of CFG.CABIN_CLASSES) {
      const opt = document.createElement("option");
      opt.value = c.value;
      opt.textContent = c.label;
      els.cabinClass.appendChild(opt);
    }
  }

  /**
   * Seçili güzergâhın tarifesi.
   * Önce yapılandırmadaki sabit tarife, yoksa önceki taramalardan öğrenilen
   * kalkış saatleri kullanılır; ikisi de yoksa saat aralığına düşülür.
   */
  function currentTimetable() {
    const key = `${els.fromId.value}-${els.toId.value}`;
    const known = CFG.KNOWN_TIMETABLES[key];
    const learned = learnedTimetables[key];

    if (known && learned) {
      const times = Array.from(new Set(known.times.concat(learned.times || []))).sort();
      return { label: known.label, times };
    }
    if (known) return known;
    if (learned && learned.times && learned.times.length) {
      return { label: (learned.label || "Önceki taramalardan") + " (öğrenildi)", times: learned.times };
    }
    return null;
  }

  /**
   * Tarifeli güzergâhta sefer saatleri doğrudan seçilir; tanımlı tarife yoksa
   * "en erken / en geç" aralığı gösterilir.
   */
  function renderTimetable() {
    const tt = currentTimetable();
    const hasTt = !!(tt && tt.times && tt.times.length);

    els.timetableWrap.hidden = !hasTt;
    els.timeFromField.hidden = hasTt;
    els.timeToField.hidden = hasTt;

    if (!hasTt) {
      selectedTimes.clear();
      return;
    }

    els.timetableLabel.textContent = tt.label || "Sefer saatleri";

    // Tarifede olmayan eski seçimleri temizle
    for (const t of Array.from(selectedTimes)) {
      if (!tt.times.includes(t)) selectedTimes.delete(t);
    }

    els.timeChips.innerHTML = "";
    for (const time of tt.times) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip-time" + (selectedTimes.has(time) ? " on" : "");
      chip.textContent = time;
      chip.addEventListener("click", () => {
        if (selectedTimes.has(time)) selectedTimes.delete(time);
        else selectedTimes.add(time);
        renderTimetable();
      });
      els.timeChips.appendChild(chip);
    }

    els.timetableHint.textContent = selectedTimes.size
      ? `${selectedTimes.size} sefer taranacak: ${Array.from(selectedTimes).sort().join(", ")}`
      : "Hiçbiri seçilmezse tüm seferler taranır.";
    els.timetableHint.classList.toggle("on", selectedTimes.size > 0);
  }

  /* ====================================================================== */
  /* Form <-> storage                                                       */
  /* ====================================================================== */

  function readForm() {
    const hasTt = !!currentTimetable();
    const times = hasTt ? Array.from(selectedTimes).sort() : [];
    return {
      fromName: els.fromName.value.trim(),
      fromId: Number(els.fromId.value),
      toName: els.toName.value.trim(),
      toId: Number(els.toId.value),
      date: els.date.value,
      // Tarife modunda seçim yoksa saat filtresi uygulanmaz.
      timeFrom: hasTt ? "00:00" : els.timeFrom.value || "00:00",
      timeTo: hasTt ? "23:59" : els.timeTo.value || "23:59",
      times,
      passengerCount: Number(els.passengerCount.value) || 1,
      gender: els.gender.value,
      cabinClass: els.cabinClass.value,
      intervalSec: Number(els.intervalSec.value) || CFG.DEFAULTS.intervalSec,
      preferredWagon: els.preferredWagon.value ? Number(els.preferredWagon.value) : null,
      autoSelect: els.autoSelect.checked,
      // Tekerlekli sandalye sınıfı özellikle seçilmişse dahil etme zaten zorunludur.
      includeWheelchair: els.includeWheelchair.checked || isWheelchairClass(els.cabinClass.value),
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
    if (Array.isArray(s.times)) selectedTimes = new Set(s.times);
    if (s.passengerCount) els.passengerCount.value = s.passengerCount;
    if (s.gender) els.gender.value = s.gender;
    if (s.cabinClass) {
      // Eski sürümlerden kalan değerler ("Ekonomi") yeni listeyle eşleştirilir.
      const options = Array.from(els.cabinClass.options).map((o) => o.value);
      const exact = options.find((v) => v === s.cabinClass);
      const loose = options.find(
        (v) => v.toLocaleLowerCase("tr-TR") === String(s.cabinClass).toLocaleLowerCase("tr-TR")
      );
      els.cabinClass.value = exact || loose || "AUTO";
    }
    if (s.intervalSec) els.intervalSec.value = s.intervalSec;
    if (s.preferredWagon) els.preferredWagon.value = s.preferredWagon;
    if (typeof s.autoSelect === "boolean") els.autoSelect.checked = s.autoSelect;
    if (typeof s.includeWheelchair === "boolean") els.includeWheelchair.checked = s.includeWheelchair;
    if (typeof s.debug === "boolean") els.debug.checked = s.debug;
  }

  /** Seçilen vagon tipi tekerlekli sandalye sınıfı mı? */
  function isWheelchairClass(value) {
    const norm = String(value || "").toLocaleLowerCase("tr-TR");
    return CFG.WHEELCHAIR.namePatterns.some((patt) => norm.includes(String(patt).toLocaleLowerCase("tr-TR")));
  }

  /**
   * Vagon tipi olarak "Tekerlekli Sandalye" seçildiyse dahil etme kutusu
   * zorunlu olarak işaretlenir ve kilitlenir (aksi halde tarama boş dönerdi).
   */
  function syncWheelchairUi() {
    const forced = isWheelchairClass(els.cabinClass.value);
    els.includeWheelchair.disabled = forced;
    if (forced) els.includeWheelchair.checked = true;

    const on = forced || els.includeWheelchair.checked;
    els.wheelchairHint.classList.toggle("on", on);
    els.wheelchairHint.textContent = forced
      ? "Vagon tipi olarak bu sınıf seçildiği için tarama yalnızca tekerlekli sandalye koltuklarını hedefliyor."
      : on
      ? "Tekerlekli sandalye koltukları da taramaya dahil edilecek."
      : "Varsayılan olarak bu koltuklar yok sayılır; yalnızca onlar boşken alarm verilmez ve otomatik seçim başlatılmaz.";
  }

  function validate(s) {
    if (!s.fromName || !s.fromId) return "Kalkış istasyonu ve ID'si zorunlu.";
    if (!s.toName || !s.toId) return "Varış istasyonu ve ID'si zorunlu.";
    if (s.fromId === s.toId) return "Kalkış ve varış istasyonu aynı olamaz.";
    if (!s.date) return "Tarih seçin.";
    if (s.date < todayISO()) return "Geçmiş bir tarih seçilemez.";
    if (!(s.times && s.times.length) && s.timeFrom >= s.timeTo) {
      return "Saat aralığı hatalı (en erken < en geç olmalı).";
    }
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
    renderTimetable();
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
    if (hit) {
      idInput.value = hit.id;
      renderTimetable();
    }
  }

  /* ====================================================================== */
  /* Durum gösterimi                                                        */
  /* ====================================================================== */

  /** Yakalanan uç nokta bilgisi (null ise tahmini adres kullanılacak). */
  let endpointInfo = null;

  function renderTokens(present, meta, templates) {
    const set = (el, on) => {
      el.classList.toggle("on", !!on);
      el.classList.toggle("off", !on);
    };
    set(els.chipAuth, present.authorization);
    set(els.chipXsrf, present["x-tms-xsrf-token"]);
    set(els.chipCaptcha, present["captcha-session"]);

    if (templates !== undefined) endpointInfo = (templates && templates.availability) || null;
    set(els.chipEndpoint, !!endpointInfo);

    const missing = [];
    if (!present.authorization) missing.push("Authorization");
    if (!present["x-tms-xsrf-token"]) missing.push("X-Tms-Xsrf-Token");

    if (missing.length) {
      els.tokenHint.textContent = `Eksik: ${missing.join(", ")} — TCDD sayfasında bir kez manuel arama yapın.`;
      return;
    }

    if (!endpointInfo) {
      // Uç nokta öğrenilmeden tahmini adres denenir; bu çoğu zaman
      // "Failed to fetch" (HTTP 0) ile sonuçlanır.
      els.tokenHint.textContent =
        "Token'lar hazır, ancak sayfanın arama isteği henüz yakalanmadı. " +
        "Sayfada bir kez MANUEL ARAMA yapın; aksi halde tahmini adres denenir ve ağ hatası alınabilir.";
      return;
    }

    let path = endpointInfo.url;
    try {
      path = new URL(endpointInfo.url).pathname;
    } catch (e) {
      /* yoksay */
    }
    els.tokenHint.textContent = `Hazır. Uç nokta: ${path} · Son token: ${fmtTime(meta && meta.capturedAt)}`;
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

  els.cabinClass.addEventListener("change", syncWheelchairUi);
  els.fromId.addEventListener("change", renderTimetable);
  els.toId.addEventListener("change", renderTimetable);
  els.btnTimesAll.addEventListener("click", () => {
    const tt = currentTimetable();
    if (tt) selectedTimes = new Set(tt.times);
    renderTimetable();
  });
  els.btnTimesNone.addEventListener("click", () => {
    selectedTimes.clear();
    renderTimetable();
  });
  els.includeWheelchair.addEventListener("change", syncWheelchairUi);
  els.fromName.addEventListener("change", () => autofillId(els.fromName, els.fromId));
  els.toName.addEventListener("change", () => autofillId(els.toName, els.toId));

  // Background'dan gelen canlı güncellemeler
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === MSG.LOG && msg.line) appendLogLine(msg.line);
    if (msg.type === MSG.STATE_CHANGED) {
      if (msg.state) renderState(msg.state);
      if (msg.headersPresent) renderTokens(msg.headersPresent, msg.headersMeta, msg.templates);
      else if (msg.templates) {
        endpointInfo = msg.templates.availability || null;
        els.chipEndpoint.classList.toggle("on", !!endpointInfo);
        els.chipEndpoint.classList.toggle("off", !endpointInfo);
      }
    }
  });

  /* ====================================================================== */
  /* Başlangıç                                                              */
  /* ====================================================================== */

  async function refresh() {
    const res = await send(MSG.GET_STATUS);
    if (!res || !res.ok) return;
    renderState(res.state || {});
    renderTokens(res.headersPresent || {}, res.headersMeta || {}, res.templates || {});
    renderLog(res.log);
    if (!res.tabOpen) {
      els.tokenHint.textContent = "TCDD sekmesi açık değil. Tarama için sekmenin açık kalması gerekir.";
    }
  }

  (async function init() {
    const data = await chrome.storage.local.get([KEYS.settings, KEYS.stations, KEYS.timetables]);
    learnedTimetables = data[KEYS.timetables] || {};
    els.date.min = todayISO();
    els.date.value = todayISO();
    renderCabinClasses();
    writeForm(data[KEYS.settings]);
    renderTimetable();
    syncWheelchairUi();
    renderStations(data[KEYS.stations]);
    await refresh();
  })();
})();
