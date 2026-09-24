/**
 * content.js  (ISOLATED world / TCDD sekmesi)
 * -----------------------------------------------------------------------------
 * Eklentinin ANA MOTORU.
 *
 *  - Tüm API sorguları buradan yönetilir, ancak fetch çağrısı doğrudan burada
 *    değil, sayfanın kendi bağlamına enjekte edilen src/injected.js üzerinden
 *    yapılır (postMessage köprüsü). Böylece istekler sayfanın çerezleri ve
 *    güncel token'ları ile gider, 403 sorunu oluşmaz.
 *  - Tarama döngüsü (setInterval) burada çalışır; 401/403 alındığı anda
 *    clearInterval ile durdurulur ve background'a haber verilir.
 *  - Boş koltuk bulunduğunda DOM otomasyonu (sefer -> vagon tipi -> koltuk ->
 *    cinsiyet) yine buradan yürütülür.
 * -----------------------------------------------------------------------------
 */
(function () {
  "use strict";

  if (window.__TCDD_CONTENT_LOADED__) {
    console.log("[TCDD] content.js zaten yüklü, ikinci yükleme atlandı.");
    return;
  }
  window.__TCDD_CONTENT_LOADED__ = true;

  const CFG = globalThis.TCDD_CONFIG;
  const U = globalThis.TCDD_DOM;
  const { MSG, KEYS } = CFG;

  /* ====================================================================== */
  /* Durum                                                                  */
  /* ====================================================================== */

  const state = {
    settings: null,
    timerId: null,
    busy: false,
    consecutiveErrors: 0,
    scanCount: 0,
    stopped: true,
    automationRunning: false
  };

  /* ====================================================================== */
  /* Loglama (konsol + background)                                          */
  /* ====================================================================== */

  function report(level, text, extra) {
    U.log(`[${level}]`, text);
    chrome.runtime.sendMessage(Object.assign({ type: MSG.LOG, level, text }, extra || {})).catch(() => {});
  }

  function send(type, payload) {
    return chrome.runtime.sendMessage(Object.assign({ type }, payload || {})).catch((e) => {
      U.warn("Background'a mesaj gönderilemedi:", e && e.message);
      return null;
    });
  }

  /* ====================================================================== */
  /* 1) Sayfa bağlamı köprüsü                                               */
  /* ====================================================================== */

  const bridge = {
    ready: false,
    seq: 0,
    pending: new Map()
  };

  function injectPageScript() {
    if (document.getElementById("tcdd-ext-injected")) return;
    const script = document.createElement("script");
    script.id = "tcdd-ext-injected";
    script.src = chrome.runtime.getURL("src/injected.js");
    script.onload = () => script.remove(); // DOM'u temiz bırak
    (document.head || document.documentElement).appendChild(script);
    U.log("Sayfa bağlamı script'i enjekte edildi.");
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "TCDD_EXT_PAGE") return;

    switch (msg.type) {
      case "READY":
        bridge.ready = true;
        U.log("Köprü hazır.");
        break;

      case "API_RESPONSE": {
        const entry = bridge.pending.get(msg.id);
        if (!entry) return;
        bridge.pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
        break;
      }

      case "CAPTURE":
        handlePageCapture(msg);
        break;
    }
  });

  /** Sayfanın kendi isteklerinden yakalanan token + gövde bilgisi. */
  function handlePageCapture(msg) {
    let apiBase = null;
    try {
      apiBase = new URL(msg.url, location.href).origin;
    } catch (e) {
      /* yoksay */
    }
    send(MSG.CAPTURED_HEADERS, { headers: msg.headers, apiBase });

    // Gerçek istek gövdelerini "şablon" olarak saklıyoruz: API alan adları
    // değişse bile kullanıcının yaptığı aramayı taklit edebilmek için.
    if (msg.body && typeof msg.body === "object") {
      const url = String(msg.url);
      let kind = null;
      if (url.includes(CFG.ENDPOINTS.availability)) kind = "availability";
      else if (url.includes(CFG.ENDPOINTS.seatMap)) kind = "seatMap";
      if (kind) send(MSG.CAPTURED_TEMPLATE, { kind, url, body: msg.body });
    }
  }

  /** Köprünün hazır olmasını bekler (script yüklenmesi birkaç yüz ms sürebilir). */
  async function waitBridge(timeout) {
    injectPageScript();
    const started = Date.now();
    while (!bridge.ready && Date.now() - started < (timeout || 8000)) {
      await U.sleep(150);
    }
    if (!bridge.ready) {
      // READY mesajı kaçmış olabilir; yine de deneyelim.
      U.warn("Köprü READY mesajı alınamadı, yine de devam ediliyor.");
    }
    return true;
  }

  /**
   * Sayfa bağlamında API isteği atar.
   * @returns {Promise<{ok:boolean,status:number,json:any,error?:string}>}
   */
  async function apiRequest(url, body, method) {
    await waitBridge();
    const headers = await buildHeaders();
    const id = "req_" + ++bridge.seq;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        bridge.pending.delete(id);
        resolve({ ok: false, status: 0, error: "Köprü zaman aşımı" });
      }, CFG.DEFAULTS.requestTimeoutMs + 2000);

      bridge.pending.set(id, { resolve, timer });

      window.postMessage(
        {
          source: "TCDD_EXT_CS",
          type: "API_REQUEST",
          id,
          url,
          method: method || "POST",
          headers,
          body,
          timeoutMs: CFG.DEFAULTS.requestTimeoutMs
        },
        window.location.origin
      );
    });
  }

  /** storage'daki en güncel token'lardan istek başlıklarını kurar. */
  async function buildHeaders() {
    const data = await chrome.storage.local.get([KEYS.headers]);
    const captured = data[KEYS.headers] || {};
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/plain, */*" };

    const map = {
      authorization: "Authorization",
      "x-tms-xsrf-token": "X-Tms-Xsrf-Token",
      "captcha-session": "Captcha-Session",
      "unit-id": "Unit-Id",
      "channel-code": "Channel-Code",
      "device-id": "Device-Id",
      "application-name": "Application-Name"
    };
    for (const key of Object.keys(map)) {
      if (captured[key]) headers[map[key]] = captured[key];
    }
    return headers;
  }

  async function getApiBase() {
    const data = await chrome.storage.local.get([KEYS.headersMeta]);
    const meta = data[KEYS.headersMeta] || {};
    return meta.apiBase || CFG.API_BASE_FALLBACK;
  }

  async function endpointUrl(path) {
    return (await getApiBase()).replace(/\/+$/, "") + path;
  }

  /* ====================================================================== */
  /* 2) JSON gezgini (şema değişikliklerine dayanıklı ayrıştırma)           */
  /* ====================================================================== */

  /** Ağaçtaki tüm nesneleri gezer, predicate'e uyanları döndürür. */
  function deepCollect(root, predicate, maxDepth) {
    const out = [];
    const seen = new Set();
    (function walk(node, depth) {
      if (!node || typeof node !== "object" || depth > (maxDepth || 12)) return;
      if (seen.has(node)) return;
      seen.add(node);

      if (Array.isArray(node)) {
        node.forEach((item) => walk(item, depth + 1));
        return;
      }
      try {
        if (predicate(node)) out.push(node);
      } catch (e) {
        /* yoksay */
      }
      Object.keys(node).forEach((k) => walk(node[k], depth + 1));
    })(root, 0);
    return out;
  }

  /** Nesne içinde regex'e uyan ilk anahtarın değerini döndürür. */
  function pick(node, regex) {
    if (!node || typeof node !== "object") return undefined;
    const key = Object.keys(node).find((k) => regex.test(k));
    return key === undefined ? undefined : node[key];
  }

  /** Alt ağaçtaki, regex'e uyan anahtarların sayısal değerlerini toplar. */
  function sumNumbers(node, regex, maxDepth) {
    let total = 0;
    (function walk(n, depth) {
      if (!n || typeof n !== "object" || depth > (maxDepth || 6)) return;
      if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1));
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (typeof v === "number" && regex.test(k)) total += v;
        else if (v && typeof v === "object") walk(v, depth + 1);
      }
    })(node, 0);
    return total;
  }

  const RE = {
    trainId: /^(trainId|id|trenId)$/i,
    depTime: /(departure|binis|biniş|kalkis|kalkış|hareket|dep)/i,
    // Varış alanlarını dışla. Anahtar başında ya da camelCase sınırında eşleşir;
    // böylece "binisTarih" içindeki "inis" yanlışlıkla varış sayılmaz.
    arrivalTime: /^(arrival|inis|iniş|varis|varış|donus|dönüş|return|arr)|(Arrival|Inis|İniş|Varis|Varış|Donus|Dönüş|Return)/,
    trainName: /(commercialName|trainName|trenAdi|name)$/i,
    empty: /(availab|empty|bos|kalan|free|remaining).*?(seat|count|koltuk|sayi)?/i,
    seatNo: /(seatNumber|seatNo|koltukNo|seatName|number)$/i,
    seatStatus: /(status|seatStatus|durum|state)$/i,
    seatAvailable: /(isAvailable|available|bos|empty|selectable|musait)$/i,
    occupied: /(occupied|dolu|reserved|isSold|taken)$/i,
    carNo: /(carName|carNo|carNumber|trainCarName|vagonNo|wagonNo|wagonNumber|carIndex)$/i,
    carId: /(trainCarId|carId|vagonId)$/i,
    cabinName: /(cabinClassName|className|vagonTipi|cabinName|typeName)$/i
  };

  /** Alt ağaçta (sınırlı derinlikte) kalkış saati taşıyan ilk değeri bulur. */
  function findDepartureTime(node, maxDepth) {
    let found = null;
    (function walk(n, depth) {
      if (found || !n || typeof n !== "object" || depth > (maxDepth || 4)) return;
      if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1));
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (
          !found &&
          typeof v === "string" &&
          RE.depTime.test(k) &&
          !RE.arrivalTime.test(k) &&
          U.extractTime(v)
        ) {
          found = v;
          return;
        }
      }
      for (const k of Object.keys(n)) {
        if (n[k] && typeof n[k] === "object") walk(n[k], depth + 1);
      }
    })(node, 0);
    return found;
  }

  /**
   * Bir sefer düğümü içindeki vagon tipi (kabin) bazlı boş yer sayılarını çıkarır.
   * Örn: [{ label: "EKONOMİ", count: 3 }, { label: "BUSINESS", count: 1 }]
   */
  function extractCabins(trainNode) {
    const cabins = [];
    (function walk(n, depth) {
      if (!n || typeof n !== "object" || depth > 6) return;
      if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1));

      const countKey = Object.keys(n).find((k) => RE.empty.test(k) && typeof n[k] === "number");
      if (countKey) {
        let label = pick(n, RE.cabinName);
        if (label === undefined) {
          // { cabinClass: { name: "EKONOMİ" }, availabilityCount: 3 } biçimi
          for (const k of Object.keys(n)) {
            const v = n[k];
            if (v && typeof v === "object" && !Array.isArray(v)) {
              const nested = pick(v, /^(name|ad|adi|cabinClassName)$/i);
              if (typeof nested === "string") {
                label = nested;
                break;
              }
            }
          }
        }
        cabins.push({ label: String(label || ""), count: n[countKey] });
      }

      Object.keys(n).forEach((k) => walk(n[k], depth + 1));
    })(trainNode, 0);
    return cabins;
  }

  /**
   * Arama yanıtından sefer listesini çıkarır.
   * Alan adları sürümden sürüme değişebildiği için sabit bir şema varsaymak
   * yerine, "id + kalkış saati taşıyan en iç düğüm" mantığı ile çalışır.
   */
  function extractTrains(json) {
    const candidates = deepCollect(json, (n) => {
      const hasId = Object.keys(n).some((k) => RE.trainId.test(k));
      return hasId && !!findDepartureTime(n, 4);
    });
    if (!candidates.length) U.warn("Yanıtta sefer düğümü bulunamadı.");

    // İç içe eşleşmelerde en içteki (en spesifik) düğümü koru:
    // ör. { id: 1, trains: [{ id: 90001, ... }] } dış düğümü elenir.
    const set = new Set(candidates);
    const innermost = candidates.filter((n) => {
      const inner = deepCollect(n, (x) => x !== n && set.has(x), 8);
      return inner.length === 0;
    });

    const trains = [];
    for (const n of innermost) {
      const rawTime = findDepartureTime(n, 4);
      const time = U.extractTime(rawTime);
      if (!time) continue;

      const cabins = extractCabins(n);
      const emptyCount = cabins.length
        ? cabins.reduce((acc, c) => acc + (c.count || 0), 0)
        : sumNumbers(n, RE.empty);

      trains.push({
        raw: n,
        id: pick(n, RE.trainId),
        name: String(pick(n, RE.trainName) || "").slice(0, 60),
        rawTime,
        time,
        cabins,
        emptyCount
      });
    }

    // Aynı sefer birden çok kez yakalanabilir; saat + id ile tekilleştir.
    const uniq = new Map();
    for (const t of trains) {
      const key = `${t.id}|${t.time}`;
      const prev = uniq.get(key);
      if (!prev || t.emptyCount > prev.emptyCount) uniq.set(key, t);
    }
    return Array.from(uniq.values()).sort((a, b) => U.toMinutes(a.time) - U.toMinutes(b.time));
  }

  /** İstenen vagon tipine göre kullanılabilir yer sayısını döndürür. */
  function countForCabin(train, cabinClass) {
    if (!cabinClass || cabinClass === "AUTO" || !train.cabins || !train.cabins.length) {
      return train.emptyCount;
    }
    // Etiketsiz (vagon tipi bilgisi olmayan) yanıtlarda filtre uygulanamaz.
    const labeled = train.cabins.filter((c) => c.label);
    if (!labeled.length) return train.emptyCount;

    const wanted = U.normalize(cabinClass);
    const matched = labeled.filter((c) => U.normalize(c.label).includes(wanted));
    if (!matched.length) return 0;
    return matched.reduce((acc, c) => acc + (c.count || 0), 0);
  }

  /** Koltuk haritası yanıtından boş koltukları çıkarır. */
  function extractEmptySeats(json) {
    const seats = [];

    (function walk(node, ctx, depth) {
      if (!node || typeof node !== "object" || depth > 12) return;

      if (Array.isArray(node)) {
        node.forEach((x) => walk(x, ctx, depth + 1));
        return;
      }

      // Vagon bilgisi koltuğun kendisinde değil, üst düğümde durur;
      // bu yüzden ağaçta aşağı inerken bağlam olarak taşınır.
      const carVal = pick(node, RE.carNo);
      const carIdVal = pick(node, RE.carId);
      const next = {
        wagon: carVal !== undefined && carVal !== null && String(carVal).length <= 12 ? String(carVal) : ctx.wagon,
        carId: carIdVal !== undefined && carIdVal !== null ? carIdVal : ctx.carId
      };

      const seatNoRaw = pick(node, RE.seatNo);
      if (seatNoRaw !== undefined && seatNoRaw !== null && String(seatNoRaw).length <= 6) {
        const status = String(pick(node, RE.seatStatus) ?? "");
        const availFlag = pick(node, RE.seatAvailable);
        const occupiedFlag = pick(node, RE.occupied);

        let isEmpty = null;
        if (typeof availFlag === "boolean") isEmpty = availFlag;
        if (isEmpty === null && typeof occupiedFlag === "boolean") isEmpty = !occupiedFlag;
        if (isEmpty === null && status) {
          isEmpty = /(^0$|avail|bos|empty|free|musait|satilabilir)/i.test(status);
        }

        if (isEmpty === true) {
          seats.push({
            wagon: next.wagon || "?",
            seatNo: String(seatNoRaw).toUpperCase(),
            carId: next.carId ?? null
          });
        }
      }

      Object.keys(node).forEach((k) => walk(node[k], next, depth + 1));
    })(json, { wagon: null, carId: null }, 0);

    // Tekilleştir
    const seen = new Set();
    return seats.filter((s) => {
      const key = s.wagon + "-" + s.seatNo;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /* ====================================================================== */
  /* 3) İstek gövdeleri                                                     */
  /* ====================================================================== */

  /** "2026-09-25" -> "25-09-2026 00:00:00" (TCDD API'sinin beklediği biçim) */
  function toApiDate(isoDate, time) {
    const [y, m, d] = String(isoDate || "").split("-");
    if (!y || !m || !d) return "";
    return `${d}-${m}-${y} ${time || "00:00:00"}`;
  }

  /**
   * Şablon içindeki alanları (derinlik fark etmeksizin) günceller.
   * Kullanıcının gerçek aramasından yakalanan gövde varsa onu kullanmak,
   * API şeması değiştiğinde bile çalışmayı sürdürmenin en güvenli yoludur.
   */
  function patchTemplate(template, patches) {
    const clone = JSON.parse(JSON.stringify(template));
    (function walk(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      for (const key of Object.keys(node)) {
        for (const p of patches) {
          // Değeri belirsiz olan yamalar atlanır; şablondaki mevcut değer korunur.
          if (p.value === undefined || p.value === null) continue;
          if (p.key.test(key) && (p.type ? typeof node[key] === p.type : true)) {
            node[key] = p.value;
          }
        }
        walk(node[key]);
      }
    })(clone);
    return clone;
  }

  async function getTemplate(kind) {
    const data = await chrome.storage.local.get([KEYS.templates]);
    const t = (data[KEYS.templates] || {})[kind];
    return t && t.body ? t : null;
  }

  /** Sefer arama gövdesi. */
  async function buildSearchBody(s) {
    const tpl = await getTemplate("availability");
    if (tpl) {
      U.log("Arama şablonu (kullanıcının gerçek aramasından) kullanılıyor.");
      return patchTemplate(tpl.body, [
        { key: /^departureDate$/i, value: toApiDate(s.date), type: "string" },
        { key: /^(departureStationId|binisIstasyonId)$/i, value: Number(s.fromId) || undefined },
        { key: /^(arrivalStationId|inisIstasyonId)$/i, value: Number(s.toId) || undefined },
        { key: /^(departureStationName)$/i, value: s.fromName, type: "string" },
        { key: /^(arrivalStationName)$/i, value: s.toName, type: "string" }
      ]);
    }

    // Şablon yoksa bilinen varsayılan şema ile dene.
    return {
      searchRoutes: [
        {
          departureStationId: Number(s.fromId) || 0,
          departureStationName: s.fromName,
          arrivalStationId: Number(s.toId) || 0,
          arrivalStationName: s.toName,
          departureDate: toApiDate(s.date)
        }
      ],
      passengerTypeCounts: [{ id: 0, count: Number(s.passengerCount) || 1 }],
      searchReservation: false,
      searchType: "DOMESTIC"
    };
  }

  /** Koltuk haritası gövdesi. */
  async function buildSeatMapBody(train, s) {
    const tpl = await getTemplate("seatMap");
    if (tpl) {
      return patchTemplate(tpl.body, [
        { key: /^(trainId|trenId)$/i, value: train.id },
        { key: /^(departureStationId)$/i, value: Number(s.fromId) || undefined },
        { key: /^(arrivalStationId)$/i, value: Number(s.toId) || undefined }
      ]);
    }
    return {
      trainId: train.id,
      legIndex: 0,
      departureStationId: Number(s.fromId) || 0,
      arrivalStationId: Number(s.toId) || 0
    };
  }

  /* ====================================================================== */
  /* 4) Tarama döngüsü                                                      */
  /* ====================================================================== */

  /** 401/403 => Captcha/oturum süresi doldu. Taramayı anında durdur. */
  async function handleAuthFailure(status) {
    stopScan("auth");
    report("error", `Yetki hatası (HTTP ${status}). Tarama durduruldu.`);
    await send(MSG.AUTH_EXPIRED, { status });
  }

  function timeInWindow(time, s) {
    const mins = U.toMinutes(time);
    if (mins === null) return false;
    const from = U.toMinutes(s.timeFrom) ?? 0;
    const to = U.toMinutes(s.timeTo) ?? 24 * 60;
    return mins >= from && mins <= to;
  }

  async function runScanOnce() {
    if (state.busy || state.stopped) return;
    state.busy = true;
    const s = state.settings;

    try {
      state.scanCount++;
      report("info", `#${state.scanCount} tarama: ${s.fromName} -> ${s.toName} ${s.date} (${s.timeFrom}-${s.timeTo})`, {
        scanTick: true
      });

      const url = await endpointUrl(CFG.ENDPOINTS.availability);
      const body = await buildSearchBody(s);
      const res = await apiRequest(url, body, "POST");

      if (res.status === 401 || res.status === 403) {
        await handleAuthFailure(res.status);
        return;
      }
      if (!res.ok) {
        state.consecutiveErrors++;
        report("warn", `Arama başarısız (HTTP ${res.status}) ${res.error || ""} [${state.consecutiveErrors}/${CFG.DEFAULTS.maxConsecutiveErrors}]`);
        if (state.consecutiveErrors >= CFG.DEFAULTS.maxConsecutiveErrors) {
          stopScan("error");
          await send(MSG.AUTOMATION_FAILED, { error: "Ardışık ağ hataları nedeniyle tarama durduruldu." });
        }
        return;
      }

      state.consecutiveErrors = 0;
      if (s.debug) U.log("Arama yanıtı (ham):", res.json);

      const trains = extractTrains(res.json);
      if (!trains.length) {
        report("warn", "Yanıt ayrıştırılamadı veya sefer bulunamadı. (Ayrıntı için Debug modunu açın.)");
        return;
      }

      const candidates = trains.filter((t) => timeInWindow(t.time, s));
      report(
        "info",
        `${trains.length} sefer döndü, ${candidates.length} tanesi saat aralığında. ` +
          candidates.map((t) => `${t.time}:${countForCabin(t, s.cabinClass)}`).join(" ")
      );

      const need = Number(s.passengerCount) || 1;
      const hit = candidates.find((t) => countForCabin(t, s.cabinClass) >= need);
      if (!hit) return;

      /* --- Boş koltuk var: koltuk haritasını çek --- */
      report(
        "ok",
        `Boş yer sinyali: ${hit.time} seferinde ${countForCabin(hit, s.cabinClass)} yer` +
          (hit.cabins && hit.cabins.length ? ` (${hit.cabins.map((c) => `${c.label || "?"}:${c.count}`).join(", ")})` : "") +
          "."
      );

      let seats = [];
      try {
        const seatUrl = await endpointUrl(CFG.ENDPOINTS.seatMap);
        const seatBody = await buildSeatMapBody(hit, s);
        const seatRes = await apiRequest(seatUrl, seatBody, "POST");

        if (seatRes.status === 401 || seatRes.status === 403) {
          await handleAuthFailure(seatRes.status);
          return;
        }
        if (seatRes.ok) {
          if (s.debug) U.log("Koltuk haritası (ham):", seatRes.json);
          seats = extractEmptySeats(seatRes.json);
          if (s.preferredWagon) {
            const filtered = seats.filter((x) => String(x.wagon) === String(s.preferredWagon));
            if (filtered.length) seats = filtered;
          }
          report("ok", `Koltuk haritası: ${seats.length} boş koltuk bulundu.`);
        } else {
          report("warn", `Koltuk haritası alınamadı (HTTP ${seatRes.status}); DOM üzerinden devam edilecek.`);
        }
      } catch (e) {
        report("warn", "Koltuk haritası hatası: " + e.message);
      }

      const result = {
        trainId: hit.id,
        trainLabel: `${hit.time} ${hit.name || ""}`.trim(),
        time: hit.time,
        emptyCount: countForCabin(hit, s.cabinClass),
        seats: seats.slice(0, 20)
      };

      // Bulundu: taramayı durdur, bildir, otomasyona geç.
      stopScan("found");
      await send(MSG.SEATS_FOUND, { result });

      if (s.autoSelect === false) {
        report("info", "Otomatik seçim kapalı; sadece bildirim gönderildi.");
        return;
      }
      await runAutomation(result, s);
    } catch (e) {
      U.error("Tarama hatası:", e);
      report("error", "Tarama hatası: " + (e.message || e));
    } finally {
      state.busy = false;
    }
  }

  function startScan(settings) {
    stopScan("restart");
    state.settings = settings;
    state.stopped = false;
    state.consecutiveErrors = 0;
    state.scanCount = 0;

    const intervalSec = Math.max(CFG.DEFAULTS.minIntervalSec, Number(settings.intervalSec) || CFG.DEFAULTS.intervalSec);
    report("ok", `Tarama başladı. Periyot: ${intervalSec} sn.`);

    injectPageScript();
    // İlk tarama hemen, sonrakiler periyodik.
    setTimeout(() => runScanOnce(), 800);
    state.timerId = setInterval(() => {
      const jitter = Math.floor(Math.random() * CFG.DEFAULTS.jitterMs);
      setTimeout(() => runScanOnce(), jitter);
    }, intervalSec * 1000);

    return { ok: true };
  }

  function stopScan(reason) {
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
    state.stopped = true;
    if (reason && reason !== "restart") U.log("Tarama durduruldu:", reason);
    return { ok: true };
  }

  /* ====================================================================== */
  /* 5) DOM otomasyonu                                                      */
  /* ====================================================================== */

  /** Sefer listesinde hedef saate ait satırı bulur. */
  function findTrainRow(targetTime) {
    const rows = U.queryAllCandidates(CFG.SELECTORS.trainRow).filter(U.isVisible);
    for (const row of rows) {
      const text = U.textOf(row);
      const rowTime = U.extractTime(text);
      if (rowTime === targetTime) return row;
    }
    // Aday satır bulunamadıysa saati içeren en küçük tıklanabilir kapsayıcıyı ara.
    const all = Array.from(document.querySelectorAll("div,li,tr,article,section")).filter(U.isVisible);
    const matches = all.filter((el) => U.extractTime(U.textOf(el)) === targetTime && U.textOf(el).length < 800);
    matches.sort((a, b) => U.textOf(a).length - U.textOf(b).length);
    return matches[0] || null;
  }

  /** Koltuk haritasında istenen koltuğu bulur. */
  function findSeatElement(seatNo) {
    const cells = U.queryAllCandidates(CFG.SELECTORS.seatCell).filter(U.isVisible);
    const target = String(seatNo).toUpperCase();

    for (const cell of cells) {
      const label =
        cell.getAttribute("data-seat") ||
        cell.getAttribute("aria-label") ||
        cell.getAttribute("title") ||
        cell.id ||
        U.textOf(cell);
      const no = U.extractSeatNo(label);
      if (!no || no !== target) continue;

      const cls = String(cell.className && cell.className.baseVal !== undefined ? cell.className.baseVal : cell.className || "");
      const occupied = CFG.SELECTORS.occupiedSeatMarkers.some((m) => new RegExp(m, "i").test(cls));
      if (occupied || U.isDisabled(cell)) continue;

      return cell;
    }
    return null;
  }

  /**
   * Bulunan koltuk için sayfa üzerindeki adımları otomatik yürütür.
   * Hiçbir aşamada bilet satın alma / ödeme yapılmaz; işlem cinsiyet
   * seçiminden sonra kullanıcıya devredilir.
   */
  async function runAutomation(result, s) {
    if (state.automationRunning) return;
    state.automationRunning = true;

    try {
      report("info", "DOM otomasyonu başlıyor...");

      /* --- 1) Hedef sefer satırı --- */
      const row = await U.waitFor(() => findTrainRow(result.time), {
        timeout: CFG.WAIT.normal,
        label: `sefer satırı (${result.time})`
      });

      /* --- 2) Sefer içindeki "vagon tipi / koltuk seç" butonu --- */
      const expandBtn =
        U.findByText(CFG.SELECTORS.trainExpandButton, row) ||
        U.queryAllCandidates(CFG.SELECTORS.trainExpandButton.css, row).find((el) => U.isVisible(el) && !U.isDisabled(el)) ||
        row;
      await U.clickReal(expandBtn, "sefer/koltuk seç butonu");

      /* --- 3) Vagon tipi (EKONOMİ / BUSINESS ...) --- */
      const cabinText = s.cabinClass && s.cabinClass !== "AUTO" ? [s.cabinClass] : ["Ekonomi", "EKONOMİ", "Economy"];
      try {
        const cabinEl = await U.waitForText(
          { css: CFG.SELECTORS.cabinClassOption.css, text: cabinText },
          { timeout: CFG.WAIT.short, label: `vagon tipi (${cabinText[0]})` }
        );
        await U.clickReal(cabinEl, "vagon tipi");
      } catch (e) {
        report("warn", "Vagon tipi seçeneği bulunamadı, adım atlandı: " + e.message);
      }

      /* --- 4) "Seçin" onay butonu --- */
      try {
        const confirmEl = await U.waitForText(CFG.SELECTORS.confirmCabinButton, {
          timeout: CFG.WAIT.short,
          label: "Seçin butonu"
        });
        await U.clickReal(confirmEl, "Seçin");
      } catch (e) {
        report("warn", "'Seçin' butonu bulunamadı, adım atlandı: " + e.message);
      }

      /* --- 5) Koltuk haritasının yüklenmesi --- */
      await U.waitForSelector(CFG.SELECTORS.seatMapContainer, {
        timeout: CFG.WAIT.long,
        label: "koltuk haritası"
      }).catch((e) => report("warn", "Koltuk haritası konteyneri doğrulanamadı: " + e.message));
      await U.sleep(600);

      /* --- 6) İlgili vagon sekmesi + koltuk --- */
      const wanted = (result.seats && result.seats.length ? result.seats : [{ wagon: s.preferredWagon || "", seatNo: null }]);
      let selectedSeat = null;

      for (const seat of wanted) {
        // Vagon sekmesi
        if (seat.wagon && seat.wagon !== "?") {
          const tab = U.queryAllCandidates(CFG.SELECTORS.wagonTab)
            .filter(U.isVisible)
            .find((el) => {
              const no = (U.textOf(el).match(/\d+/) || [])[0];
              return no && String(no) === String(seat.wagon).match(/\d+/)?.[0];
            });
          if (tab) {
            await U.clickReal(tab, `${seat.wagon}. vagon sekmesi`);
            await U.sleep(900);
          } else {
            report("warn", `Vagon sekmesi bulunamadı: ${seat.wagon}`);
          }
        }

        if (!seat.seatNo) break;

        // Koltuk
        try {
          const seatEl = await U.waitFor(() => findSeatElement(seat.seatNo), {
            timeout: CFG.WAIT.short,
            label: `koltuk ${seat.seatNo}`
          });
          await U.clickReal(seatEl, `koltuk ${seat.wagon}/${seat.seatNo}`);
          selectedSeat = seat;
          break;
        } catch (e) {
          report("warn", `Koltuk ${seat.wagon}/${seat.seatNo} tıklanamadı, sıradaki deneniyor.`);
        }
      }

      if (!selectedSeat) {
        // API'den koltuk gelmediyse haritadaki ilk boş koltuğu dene.
        const firstFree = U.queryAllCandidates(CFG.SELECTORS.seatCell)
          .filter(U.isVisible)
          .find((el) => {
            const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || "");
            return !CFG.SELECTORS.occupiedSeatMarkers.some((m) => new RegExp(m, "i").test(cls)) && !U.isDisabled(el) && U.extractSeatNo(U.textOf(el) || el.id);
          });
        if (firstFree) {
          await U.clickReal(firstFree, "haritadaki ilk boş koltuk");
          selectedSeat = { wagon: "?", seatNo: U.extractSeatNo(U.textOf(firstFree) || firstFree.id) || "?" };
        }
      }

      if (!selectedSeat) throw new Error("Uygun koltuk elemanı sayfada bulunamadı.");

      /* --- 7) Cinsiyet seçimi --- */
      const genderTexts = CFG.SELECTORS.genderButton.text[s.gender] || CFG.SELECTORS.genderButton.text.E;
      try {
        const genderEl = await U.waitForText(
          { css: CFG.SELECTORS.genderButton.css, text: genderTexts },
          { timeout: CFG.WAIT.short, label: `cinsiyet (${genderTexts[0]})` }
        );
        await U.clickReal(genderEl, "cinsiyet");

        const confirm = U.findByText(CFG.SELECTORS.genderConfirmButton);
        if (confirm) await U.clickReal(confirm, "cinsiyet onay");
      } catch (e) {
        report("warn", "Cinsiyet seçimi yapılamadı (ekran çıkmamış olabilir): " + e.message);
      }

      /* --- 8) Dur ve kullanıcıya bırak --- */
      const detail = `${result.trainLabel} | ${selectedSeat.wagon}. vagon / ${selectedSeat.seatNo} nolu koltuk seçildi.`;
      report("ok", "Otomasyon tamamlandı. " + detail);
      await send(MSG.TICKET_SELECTED, { detail });
    } catch (e) {
      U.error("Otomasyon hatası:", e);
      report("error", "Otomasyon hatası: " + (e.message || e));
      await send(MSG.AUTOMATION_FAILED, { error: String(e.message || e) });
    } finally {
      state.automationRunning = false;
    }
  }

  /* ====================================================================== */
  /* 6) Background mesajları                                                */
  /* ====================================================================== */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case MSG.CONTENT_PING:
        sendResponse({ pong: true, scanning: !state.stopped });
        break;

      case MSG.CONTENT_START:
        sendResponse(startScan(msg.settings));
        break;

      case MSG.CONTENT_STOP:
        sendResponse(stopScan(msg.reason || "background"));
        break;

      default:
        sendResponse({ ok: false });
    }
    return true;
  });

  /* Sayfa kapanırken temizlik */
  window.addEventListener("pagehide", () => stopScan("pagehide"));

  /* ====================================================================== */
  /* 7) Hata ayıklama kancası                                               */
  /* ====================================================================== */
  /* Konsoldan `__TCDD_DEBUG__.extractTrains(json)` gibi çağrılarla          */
  /* ayrıştırıcıların gerçek yanıtlar üzerinde davranışı incelenebilir.      */
  window.__TCDD_DEBUG__ = {
    state,
    extractTrains,
    extractCabins,
    countForCabin,
    extractEmptySeats,
    findTrainRow,
    findSeatElement,
    buildSearchBody,
    buildSeatMapBody,
    apiRequest,
    runScanOnce,
    stopScan
  };

  injectPageScript();
  U.log("content.js hazır. Tarama komutu bekleniyor.");
})();
