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
    automationRunning: false,
    /** API saatleri seçimlerden sabit bir fark gösteriyorsa hizalanmış liste. */
    alignedTimes: null,
    timeOffsetMin: 0
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
    // Öncelikli yol: background üzerinden chrome.scripting + world:"MAIN".
    // Sayfanın CSP'si <script src> ile enjeksiyonu engelleyebiliyor.
    send(MSG.INJECT_MAIN).catch(() => {});

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

    // Gerçek istek URL'sini ve gövdesini "şablon" olarak saklıyoruz.
    // URL'yi saklamak kritik: taramada tahmini yol yerine sayfanın kullandığı
    // adresin birebir aynısı kullanılır (yanlış yol -> 404 -> "Failed to fetch").
    if (msg.body && typeof msg.body === "object") {
      const url = String(msg.url);
      const match = CFG.ENDPOINT_PATTERNS.find((p) => p.re.test(url));
      if (match && match.kind !== "stationPairs") {
        U.log(`İstek şablonu yakalandı [${match.kind}]:`, url);
        send(MSG.CAPTURED_TEMPLATE, { kind: match.kind, url, body: msg.body });
      }
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
  async function apiRequest(url, body, method, opts) {
    await waitBridge();
    const headers = await buildHeaders(opts && opts.minimalHeaders);
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

  /**
   * storage'daki en güncel token'lardan istek başlıklarını kurar.
   *
   * @param {boolean} minimal Yalnızca zorunlu başlıklar gönderilir. Sunucunun
   *   CORS ön kontrolünde kabul etmediği bir başlık isteği düşürüyorsa
   *   ("Failed to fetch") bu mod ile bir kez daha denenir.
   */
  /** Tüm isteklerde gönderilen zorunlu güvenlik başlıkları. */
  const CORE_HEADER_MAP = {
    authorization: "Authorization",
    "x-tms-xsrf-token": "X-Tms-Xsrf-Token",
    "captcha-session": "Captcha-Session"
  };

  /** Sayfanın ek olarak gönderdiği, zorunlu olmayan başlıklar. */
  const EXTRA_HEADER_MAP = {
    "unit-id": "Unit-Id",
    "channel-code": "Channel-Code",
    "device-id": "Device-Id",
    "application-name": "Application-Name"
  };

  /**
   * storage'daki en güncel token'lardan istek başlıklarını kurar.
   *
   * @param {boolean} minimal Yalnızca zorunlu başlıklar gönderilir. Sunucunun
   *   CORS ön kontrolünde kabul etmediği fazladan bir başlık isteği düşürüyorsa
   *   ("Failed to fetch" / HTTP 0) bu mod ile bir kez daha denenir.
   */
  async function buildHeaders(minimal) {
    const data = await chrome.storage.local.get([KEYS.headers]);
    const captured = data[KEYS.headers] || {};
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/plain, */*" };

    const map = minimal ? CORE_HEADER_MAP : Object.assign({}, CORE_HEADER_MAP, EXTRA_HEADER_MAP);
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

  /**
   * Bir işlem için kullanılacak URL'yi çözer.
   *
   * Öncelik sırası:
   *   1. Kullanıcının sayfada yaptığı gerçek isteğin URL'si (yakalanmış şablon)
   *   2. Yakalanan API tabanı + yapılandırmadaki yedek yol
   *
   * 1. seçenek varken 2.'yi kullanmak, yol adı değişmişse sunucudan CORS
   * başlıksız 404 almaya ve isteğin HTTP 0 ile düşmesine yol açar.
   */
  async function resolveEndpoint(kind, fallbackPath) {
    const tpl = await getTemplate(kind);
    if (tpl && tpl.url) {
      return { url: tpl.url, source: "yakalanan" };
    }
    return { url: await endpointUrl(fallbackPath), source: "varsayılan" };
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
    cabinName: /(cabinClassName|className|vagonTipi|cabinName|typeName)$/i,
    cabinId: /(cabinClassId|classId|cabinId|vagonTipiId|ticketClassId|seatTypeId)$/i,
    // Koltuğun kendi tip/açıklama alanları (tekerlekli sandalye tespiti için)
    seatTypeName: /(seatType|seatClass|seatDescription|koltukTip|koltukTuru|facility|feature|description)/i
  };

  /* ---------------------------------------------------------------------- */
  /* Tekerlekli sandalye (engelli) koltuk tespiti                            */
  /* ---------------------------------------------------------------------- */

  /** Sınıf/koltuk adı tekerlekli sandalye sınıfına mı işaret ediyor? */
  function isWheelchairLabel(label) {
    if (!label) return false;
    const norm = U.normalize(label);
    if (!norm) return false;
    return CFG.WHEELCHAIR.namePatterns.some((patt) => norm.includes(U.normalize(patt)));
  }

  /** Sınıf ID'si, yapılandırmadaki bilinen tekerlekli sandalye ID'lerinden biri mi? */
  function isWheelchairId(id) {
    if (id === undefined || id === null || id === "") return false;
    return CFG.WHEELCHAIR.classIds.some((x) => String(x) === String(id));
  }

  /**
   * Bir düğüm (koltuk ya da kabin) tekerlekli sandalye sınıfına mı ait?
   * Ad, ID ve boolean bayrak olmak üzere üç kanaldan bakılır.
   * Not: "disabled: true" gibi çok anlamlı alanlar bilinçli olarak bayrak
   * sayılmaz; o alanlar bazı şemalarda "seçilemez" anlamına gelir.
   */
  function isWheelchairNode(node) {
    if (!node || typeof node !== "object") return false;

    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v === true && CFG.WHEELCHAIR.flagKeys.test(key)) return true;
      if (typeof v === "string" && (RE.cabinName.test(key) || RE.seatTypeName.test(key)) && isWheelchairLabel(v)) {
        return true;
      }
      if (RE.cabinId.test(key) && isWheelchairId(v)) return true;
    }
    return false;
  }

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
   * Örn: [{ label: "EKONOMİ", id: 1, count: 3, wheelchair: false }]
   * "wheelchair" işaretli kabinler varsayılan olarak sayıma katılmaz.
   */
  function extractCabins(trainNode) {
    const cabins = [];
    (function walk(n, depth) {
      if (!n || typeof n !== "object" || depth > 6) return;
      if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1));

      const countKey = Object.keys(n).find((k) => RE.empty.test(k) && typeof n[k] === "number");
      if (countKey) {
        let label = pick(n, RE.cabinName);
        let cabinId = pick(n, RE.cabinId);
        let wheelchair = isWheelchairNode(n);

        if (label === undefined || cabinId === undefined) {
          // { cabinClass: { id: 4, name: "EKONOMİ" }, availabilityCount: 3 } biçimi
          for (const k of Object.keys(n)) {
            const v = n[k];
            if (v && typeof v === "object" && !Array.isArray(v)) {
              const nested = pick(v, /^(name|ad|adi|cabinClassName)$/i);
              if (label === undefined && typeof nested === "string") label = nested;
              if (cabinId === undefined) {
                const nestedId = pick(v, /^(id|cabinClassId|classId)$/i);
                if (nestedId !== undefined) cabinId = nestedId;
              }
              if (!wheelchair && isWheelchairNode(v)) wheelchair = true;
              if (label !== undefined && cabinId !== undefined) break;
            }
          }
        }

        const labelText = String(label || "");
        cabins.push({
          label: labelText,
          id: cabinId === undefined ? null : cabinId,
          count: n[countKey],
          wheelchair: wheelchair || isWheelchairLabel(labelText) || isWheelchairId(cabinId)
        });
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

  /** Kullanıcı tekerlekli sandalye koltuklarını özellikle istedi mi? */
  function wantsWheelchair(s) {
    return !!(s && (s.includeWheelchair === true || isWheelchairLabel(s.cabinClass)));
  }

  /** Tarama yalnızca tekerlekli sandalye sınıfını mı hedefliyor? */
  function onlyWheelchair(s) {
    return !!(s && isWheelchairLabel(s.cabinClass));
  }

  /**
   * İstenen vagon tipine göre kullanılabilir yer sayısını döndürür.
   * Tekerlekli sandalye (engelli) kabinleri, kullanıcı özellikle istemedikçe
   * sayıma DAHİL EDİLMEZ; böylece sadece o koltuklar boşken alarm üretilmez.
   *
   * @param {object} opts { cabinClass, includeWheelchair }
   */
  function countForCabin(train, opts) {
    const s = opts || {};
    const cabins = train.cabins || [];
    const labeled = cabins.filter((c) => c.label || c.id !== null);

    // Kabin kırılımı yoksa filtre uygulanamaz; ikinci kapı koltuk haritasıdır.
    if (!labeled.length) {
      if (!wantsWheelchair(s) && train.emptyCount > 0) {
        U.warn("Kabin kırılımı yok: tekerlekli sandalye filtresi koltuk haritası adımında uygulanacak.");
      }
      return train.emptyCount;
    }

    let pool = labeled;
    if (onlyWheelchair(s)) {
      pool = pool.filter((c) => c.wheelchair);
    } else {
      if (!wantsWheelchair(s)) pool = pool.filter((c) => !c.wheelchair);
      if (s.cabinClass && s.cabinClass !== "AUTO") {
        const wanted = U.normalize(s.cabinClass);
        pool = pool.filter((c) => c.label && U.normalize(c.label).includes(wanted));
      }
    }

    return pool.reduce((acc, c) => acc + (c.count || 0), 0);
  }

  /**
   * Koltuk haritası yanıtından (purchasableSeats / seats / koltuklar ...)
   * boş koltukları çıkarır.
   *
   * Tekerlekli sandalye (engelli) koltukları varsayılan olarak ELENİR:
   *   - koltuğun kendi tip/açıklama alanı ya da boolean bayrağı,
   *   - veya bulunduğu vagon/kabin sınıfının adı ya da ID'si
   * tekerlekli sandalye sınıfına işaret ediyorsa koltuk atlanır.
   * Kabin bilgisi koltuk düğümünde değil üst düğümde durduğu için, ağaçta
   * aşağı inerken bağlam (ctx) olarak taşınır.
   *
   * @param {object} opts { includeWheelchair, onlyWheelchair }
   * @returns {{seats: Array, total: number, wheelchairSkipped: number}}
   */
  function extractEmptySeats(json, opts) {
    const o = opts || {};
    const seats = [];
    let total = 0;
    let wheelchairSkipped = 0;

    (function walk(node, ctx, depth) {
      if (!node || typeof node !== "object" || depth > 12) return;

      if (Array.isArray(node)) {
        node.forEach((x) => walk(x, ctx, depth + 1));
        return;
      }

      // Vagon / kabin bilgisi koltuğun kendisinde değil, üst düğümde durur;
      // bu yüzden ağaçta aşağı inerken bağlam olarak taşınır.
      const carVal = pick(node, RE.carNo);
      const carIdVal = pick(node, RE.carId);
      const cabinLabel = pick(node, RE.cabinName);
      const cabinIdVal = pick(node, RE.cabinId);

      const next = {
        wagon: carVal !== undefined && carVal !== null && String(carVal).length <= 12 ? String(carVal) : ctx.wagon,
        carId: carIdVal !== undefined && carIdVal !== null ? carIdVal : ctx.carId,
        cabinLabel: typeof cabinLabel === "string" && cabinLabel ? cabinLabel : ctx.cabinLabel,
        cabinId: cabinIdVal !== undefined && cabinIdVal !== null ? cabinIdVal : ctx.cabinId,
        // Bir üst kabin tekerlekli sandalye sınıfıysa altındaki tüm koltuklar da öyledir.
        wheelchair:
          ctx.wheelchair ||
          isWheelchairLabel(cabinLabel) ||
          isWheelchairId(cabinIdVal) ||
          (!Object.keys(node).some((k) => RE.seatNo.test(k)) && isWheelchairNode(node))
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
          total++;
          const isWheelchairSeat = next.wheelchair || isWheelchairNode(node);

          const skip = o.onlyWheelchair ? !isWheelchairSeat : isWheelchairSeat && !o.includeWheelchair;
          if (skip) {
            if (isWheelchairSeat) wheelchairSkipped++;
          } else {
            seats.push({
              wagon: next.wagon || "?",
              seatNo: String(seatNoRaw).toUpperCase(),
              carId: next.carId ?? null,
              cabin: next.cabinLabel || "",
              wheelchair: isWheelchairSeat
            });
          }
        }
      }

      Object.keys(node).forEach((k) => walk(node[k], next, depth + 1));
    })(json, { wagon: null, carId: null, cabinLabel: null, cabinId: null, wheelchair: false }, 0);

    // Tekilleştir
    const seen = new Set();
    const unique = seats.filter((x) => {
      const key = x.wagon + "-" + x.seatNo;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { seats: unique, total, wheelchairSkipped };
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

  /**
   * Sefer saati kullanıcının hedefiyle uyuşuyor mu?
   * Kullanıcı tarifeden belirli saatleri seçtiyse (ör. 11:10, 12:20) yalnızca
   * o seferler taranır; seçim yoksa "en erken - en geç" aralığına düşülür.
   */
  function matchesTime(time, s, alignedTimes) {
    if (Array.isArray(s.times) && s.times.length) {
      if (s.times.includes(time)) return true;
      return Array.isArray(alignedTimes) && alignedTimes.includes(time);
    }
    return timeInWindow(time, s);
  }

  /**
   * Seçilen sefer saatleri ile API'den dönen saatler arasında SABİT bir fark
   * var mı? (Saat dilimi farkı ya da tarifedeki saatin farklı bir istasyona ait
   * olması böyle bir kaymaya yol açar; ör. Halkalı kalkışı - Söğütlüçeşme.)
   *
   * Yalnızca TÜM seçimler aynı farkı gösteriyorsa hizalama yapılır; tek bir
   * saat seçiliyse yanlış sefere kilitlenmemek için sadece öneri döner.
   *
   * @returns {{offsetMin:number, times:string[], applied:boolean}|null}
   */
  function alignTimes(selected, parsed) {
    if (!Array.isArray(selected) || !selected.length || !Array.isArray(parsed) || !parsed.length) return null;

    const selMin = selected.map((t) => U.toMinutes(t));
    if (selMin.some((v) => v === null)) return null;

    const parsedMin = parsed.map((t) => U.toMinutes(t)).filter((v) => v !== null);
    if (!parsedMin.length) return null;
    const parsedSet = new Set(parsedMin);

    // Zaten birebir eşleşiyorsa hizalanacak bir şey yok.
    if (selMin.every((v) => parsedSet.has(v))) return null;

    // Aday kaymalar: ilk seçim ile dönen her saat arasındaki farklar.
    // En küçük kaymadan başlayarak, TÜM seçimleri aynı anda eşleyen ilk fark alınır;
    // "en yakın komşu" yaklaşımı farklı seferlere denk gelip yanlış sonuç verir.
    const offsets = Array.from(new Set(parsedMin.map((p) => p - selMin[0])))
      .filter((d) => d !== 0 && Math.abs(d) <= 240)
      .sort((a, b) => Math.abs(a) - Math.abs(b));

    for (const offset of offsets) {
      if (selMin.every((v) => parsedSet.has(v + offset))) {
        return {
          offsetMin: offset,
          times: selMin.map((v) => U.fromMinutes(v + offset)),
          applied: selected.length >= 2
        };
      }
    }
    return null;
  }

  /** Log/başlık için hedef saat açıklaması. */
  function timeCriteriaText(s) {
    return Array.isArray(s.times) && s.times.length ? s.times.join(", ") : `${s.timeFrom}-${s.timeTo}`;
  }

  async function runScanOnce() {
    if (state.busy || state.stopped) return;
    state.busy = true;
    const s = state.settings;

    try {
      state.scanCount++;
      report("info", `#${state.scanCount} tarama: ${s.fromName} -> ${s.toName} ${s.date} (${timeCriteriaText(s)})`, {
        scanTick: true
      });

      const ep = await resolveEndpoint("availability", CFG.ENDPOINTS.availability);
      if (state.scanCount === 1) report("info", `Arama uç noktası (${ep.source}): ${ep.url}`);

      const body = await buildSearchBody(s);
      let res = await apiRequest(ep.url, body, "POST");

      // Ağ düzeyinde düştüyse (CORS ön kontrolü / fazladan başlık) bir kez
      // sadeleştirilmiş başlıklarla dene. Yalnızca serideki ilk hatada.
      if (res.status === 0 && state.consecutiveErrors === 0) {
        report("warn", "İstek ağ düzeyinde düştü; başlıklar sadeleştirilip bir kez daha denenecek.");
        res = await apiRequest(ep.url, body, "POST", { minimalHeaders: true });
        if (res.ok) report("ok", "Sadeleştirilmiş başlıklarla başarılı. Fazladan bir başlık isteği düşürüyor olabilir.");
      }

      if (res.status === 401 || res.status === 403) {
        await handleAuthFailure(res.status);
        return;
      }
      if (!res.ok) {
        state.consecutiveErrors++;
        const attempt = `[${state.consecutiveErrors}/${CFG.DEFAULTS.maxConsecutiveErrors}]`;

        if (res.status === 0) {
          // Yanıt hiç alınamadı: yol yanlış (404 + CORS başlığı yok), sunucuya
          // ulaşılamıyor ya da istek CORS ön kontrolünde düştü.
          report(
            "error",
            `Ağ hatası ${attempt}: ${ep.url} adresine ulaşılamadı (${res.error || "Failed to fetch"}). ` +
              (ep.source === "varsayılan"
                ? "Uç nokta tahmini kullanılıyor. TCDD sayfasında bir kez MANUEL ARAMA yapın; eklenti gerçek adresi yakalayıp onu kullanacak."
                : "Sayfa bu adresi kullanıyor olsa da istek düştü; sayfayı yenileyip manuel arama yapın.")
          );
        } else {
          report("warn", `Arama başarısız (HTTP ${res.status}) ${res.error || ""} ${attempt}`);
        }

        if (state.consecutiveErrors >= CFG.DEFAULTS.maxConsecutiveErrors) {
          stopScan("error");
          await send(MSG.AUTOMATION_FAILED, {
            error:
              res.status === 0
                ? `İstek ağ düzeyinde başarısız oldu (${ep.url}). Uç nokta öğrenilemediği için tarama durduruldu: TCDD sayfasında bir kez manuel arama yapıp tekrar başlatın.`
                : "Ardışık ağ hataları nedeniyle tarama durduruldu."
          });
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

      // Gerçek yanıttaki kalkış saatlerini güzergâhın tarifesi olarak öğren;
      // popup bunları saat seçim listesinde gösterir (ters yön dahil).
      send(MSG.CAPTURED_TIMETABLE, {
        routeKey: `${s.fromId}-${s.toId}`,
        label: `${s.fromName} → ${s.toName}`,
        times: trains.map((t) => t.time)
      });

      let candidates = trains.filter((t) => matchesTime(t.time, s, state.alignedTimes));

      // Hiç eşleşme yoksa körlemesine devam etmek yerine ne döndüğünü göster.
      if (!candidates.length && Array.isArray(s.times) && s.times.length) {
        report(
          "warn",
          `Hedef saatlerle eşleşme yok. Dönen saatler: ${trains.map((t) => t.time).join(", ")} ` +
            `| API'nin ham değeri: "${trains[0].rawTime}"`
        );

        const align = alignTimes(s.times, trains.map((t) => t.time));
        if (align) {
          const sign = align.offsetMin > 0 ? "+" : "";
          if (align.applied) {
            state.alignedTimes = align.times;
            state.timeOffsetMin = align.offsetMin;
            report(
              "ok",
              `API saatleri seçimlerinizden sabit ${sign}${align.offsetMin} dk farklı ` +
                `(saat dilimi ya da farklı biniş istasyonu). Eşleşme hizalandı: ${align.times.join(", ")}`
            );
            candidates = trains.filter((t) => align.times.includes(t.time));
          } else {
            report(
              "warn",
              `Sabit ${sign}${align.offsetMin} dk fark olabilir (${align.times.join(", ")}). ` +
                "Otomatik hizalama için en az iki sefer saati seçin veya listeden doğru saatleri işaretleyin."
            );
          }
        }
      }

      report(
        "info",
        `${trains.length} sefer döndü, ${candidates.length} tanesi hedef saatlerde. ` +
          candidates.map((t) => `${t.time}:${countForCabin(t, s)}`).join(" ")
      );

      const need = Number(s.passengerCount) || 1;
      const hit = candidates.find((t) => countForCabin(t, s) >= need);
      if (!hit) {
        // Kabin kırılımında yalnızca tekerlekli sandalye kabini boşsa bunu görünür kıl.
        const wheelchairOnly = candidates.find(
          (t) => (t.cabins || []).some((c) => c.wheelchair && c.count > 0) && countForCabin(t, s) < need
        );
        if (wheelchairOnly && !wantsWheelchair(s)) {
          report(
            "info",
            `${wheelchairOnly.time} seferinde yalnızca tekerlekli sandalye koltuğu boş; ayarlar gereği yok sayıldı.`
          );
        }
        return;
      }

      /* --- Boş koltuk var: koltuk haritasını çek --- */
      report(
        "ok",
        `Boş yer sinyali: ${hit.time} seferinde ${countForCabin(hit, s)} yer` +
          (hit.cabins && hit.cabins.length
            ? ` (${hit.cabins.map((c) => `${c.label || "?"}${c.wheelchair ? "*" : ""}:${c.count}`).join(", ")})`
            : "") +
          (wantsWheelchair(s) ? "" : " [* = tekerlekli sandalye, sayıma dahil değil]")
      );

      let seats = [];
      let seatMapParsed = null;
      try {
        const seatEp = await resolveEndpoint("seatMap", CFG.ENDPOINTS.seatMap);
        const seatBody = await buildSeatMapBody(hit, s);
        const seatRes = await apiRequest(seatEp.url, seatBody, "POST");

        if (seatRes.status === 401 || seatRes.status === 403) {
          await handleAuthFailure(seatRes.status);
          return;
        }
        if (seatRes.ok) {
          if (s.debug) U.log("Koltuk haritası (ham):", seatRes.json);
          seatMapParsed = extractEmptySeats(seatRes.json, {
            includeWheelchair: wantsWheelchair(s),
            onlyWheelchair: onlyWheelchair(s)
          });
          seats = seatMapParsed.seats;

          if (s.preferredWagon) {
            const filtered = seats.filter((x) => String(x.wagon) === String(s.preferredWagon));
            if (filtered.length) seats = filtered;
          }
          report(
            "ok",
            `Koltuk haritası: ${seats.length} uygun koltuk` +
              (seatMapParsed.wheelchairSkipped
                ? ` (${seatMapParsed.wheelchairSkipped} tekerlekli sandalye koltuğu elendi)`
                : "") +
              "."
          );
        } else {
          report(
            "warn",
            `Koltuk haritası alınamadı (HTTP ${seatRes.status}, ${seatEp.source} uç nokta); DOM üzerinden devam edilecek.`
          );
        }
      } catch (e) {
        report("warn", "Koltuk haritası hatası: " + e.message);
      }

      /**
       * İkinci kapı: kabin kırılımı yoksa ya da yanıltıcıysa, koltuk haritası
       * kararı verir. Boş görünen koltukların TAMAMI tekerlekli sandalye
       * koltuğuysa alarm üretmeden taramaya devam edilir.
       */
      if (seatMapParsed && seatMapParsed.total > 0 && !seats.length && seatMapParsed.wheelchairSkipped > 0) {
        report(
          "info",
          `${hit.time} seferinde boş koltukların tamamı tekerlekli sandalye koltuğu ` +
            `(${seatMapParsed.wheelchairSkipped} adet); ayarlar gereği yok sayıldı, tarama sürüyor.`
        );
        return;
      }

      const result = {
        trainId: hit.id,
        trainLabel: `${hit.time} ${hit.name || ""}`.trim(),
        time: hit.time,
        emptyCount: countForCabin(hit, s),
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
    state.alignedTimes = null;
    state.timeOffsetMin = 0;

    const intervalSec = Math.max(CFG.DEFAULTS.minIntervalSec, Number(settings.intervalSec) || CFG.DEFAULTS.intervalSec);
    report(
      "ok",
      `Tarama başladı. Periyot: ${intervalSec} sn. Hedef saatler: ${timeCriteriaText(settings)}.`
    );

    getTemplate("availability").then((tpl) => {
      if (!tpl) {
        report(
          "warn",
          "Sayfanın gerçek arama isteği henüz yakalanmadı; tahmini uç nokta denenecek. " +
            "Hata alırsanız TCDD sayfasında bir kez manuel arama yapın."
        );
      }
    });

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

  /** Bir koltuk elemanının sınıf/etiket bilgisini toplar. */
  function seatElementSignature(cell) {
    const cls = String(
      cell.className && cell.className.baseVal !== undefined ? cell.className.baseVal : cell.className || ""
    );
    return [cls, cell.getAttribute("aria-label") || "", cell.getAttribute("title") || "", cell.id || ""].join(" ");
  }

  /**
   * DOM'daki koltuk tekerlekli sandalye koltuğu mu?
   * API filtresi kaçırırsa diye son kontrol noktasıdır.
   */
  function isWheelchairSeatElement(cell) {
    const sig = seatElementSignature(cell);
    return CFG.SELECTORS.wheelchairSeatMarkers.some((m) => new RegExp(m, "i").test(sig));
  }

  /**
   * Koltuk haritasında istenen koltuğu bulur.
   * @param {boolean} allowWheelchair Tekerlekli sandalye koltuğuna tıklanabilir mi?
   */
  function findSeatElement(seatNo, allowWheelchair) {
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

      if (!allowWheelchair && isWheelchairSeatElement(cell)) {
        U.log(`Koltuk ${no} tekerlekli sandalye koltuğu olarak işaretli, atlandı.`);
        continue;
      }

      return cell;
    }
    return null;
  }

  /**
   * Yolcu başına cinsiyet listesi. Eksikse son değerle tamamlanır; eski
   * sürümlerden gelen tek "gender" alanı da desteklenir.
   */
  function passengerGenders(s, need) {
    const list =
      Array.isArray(s.genders) && s.genders.length ? s.genders.slice() : [s.gender || "E"];
    while (list.length < need) list.push(list[list.length - 1] || "E");
    return list.slice(0, need);
  }

  /**
   * Yolcu sayısı kadar koltuğu seçerken vagon değiştirmeyi en aza indirir:
   * hepsini barındıran bir vagon varsa o vagondaki koltuklar tercih edilir.
   */
  function pickSeatsForPassengers(seats, need, preferredWagon) {
    const list = (seats || []).filter((x) => x && x.seatNo);
    if (!list.length) return [];

    const byWagon = new Map();
    for (const seat of list) {
      const key = String(seat.wagon || "?");
      if (!byWagon.has(key)) byWagon.set(key, []);
      byWagon.get(key).push(seat);
    }

    // Kullanıcının tercih ettiği vagon yeterliyse önce o denenir.
    if (preferredWagon) {
      const pref = byWagon.get(String(preferredWagon));
      if (pref && pref.length >= need) return pref.slice(0, need).concat(list);
    }

    for (const group of byWagon.values()) {
      if (group.length >= need) return group.slice(0, need).concat(list);
    }
    return list; // tek vagonda yetmiyor: sırayla dene
  }

  /** İlgili vagon sekmesine geçer (zaten açıksa bir şey yapmaz). */
  async function ensureWagonTab(wagon) {
    if (!wagon || wagon === "?") return false;
    const wantedNo = String(wagon).match(/\d+/);
    if (!wantedNo) return false;

    const tab = U.queryAllCandidates(CFG.SELECTORS.wagonTab)
      .filter(U.isVisible)
      .find((el) => {
        const no = (U.textOf(el).match(/\d+/) || [])[0];
        return no && no === wantedNo[0];
      });

    if (!tab) {
      report("warn", `Vagon sekmesi bulunamadı: ${wagon}`);
      return false;
    }
    await U.clickReal(tab, `${wagon}. vagon sekmesi`);
    await U.sleep(900);
    return true;
  }

  /**
   * Koltuk tıklandıktan sonra açılan Bay/Bayan adımını o yolcunun cinsiyetiyle
   * tamamlar. Ekran açılmadıysa (bazı akışlarda cinsiyet sorulmaz) sessizce geçer.
   */
  async function chooseGenderFor(code, label) {
    const texts = CFG.SELECTORS.genderButton.text[code] || CFG.SELECTORS.genderButton.text.E;
    try {
      const el = await U.waitForText(
        { css: CFG.SELECTORS.genderButton.css, text: texts },
        { timeout: CFG.WAIT.short, label: `cinsiyet ${texts[0]} (${label})` }
      );
      await U.clickReal(el, `cinsiyet ${texts[0]} (${label})`);

      const confirm = U.findByText(CFG.SELECTORS.genderConfirmButton);
      if (confirm) await U.clickReal(confirm, "cinsiyet onay");
      return true;
    } catch (e) {
      report("warn", `${label}: cinsiyet seçimi yapılamadı (ekran çıkmamış olabilir).`);
      return false;
    }
  }

  /** Haritadaki ilk uygun boş koltuk (API listesi yetmediğinde yedek yol). */
  function findFreeSeatElement(allowWheelchair, s, usedEls) {
    return (
      U.queryAllCandidates(CFG.SELECTORS.seatCell)
        .filter(U.isVisible)
        .find((el) => {
          if (usedEls.has(el)) return false;
          const cls = String(
            el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || ""
          );
          if (CFG.SELECTORS.occupiedSeatMarkers.some((m) => new RegExp(m, "i").test(cls))) return false;
          if (U.isDisabled(el)) return false;
          if (!allowWheelchair && isWheelchairSeatElement(el)) return false;
          if (allowWheelchair && onlyWheelchair(s) && !isWheelchairSeatElement(el)) return false;
          return !!U.extractSeatNo(U.textOf(el) || el.id);
        }) || null
    );
  }

  /**
   * Bulunan koltuk için sayfa üzerindeki adımları otomatik yürütür.
   * Hiçbir aşamada bilet satın alma / ödeme yapılmaz; işlem cinsiyet
   * seçiminden sonra kullanıcıya devredilir.
   */
  async function runAutomation(result, s) {
    if (state.automationRunning) return;
    state.automationRunning = true;

    const allowWheelchair = wantsWheelchair(s);

    try {
      report(
        "info",
        "DOM otomasyonu başlıyor..." +
          (allowWheelchair ? " (tekerlekli sandalye koltukları dahil)" : " (tekerlekli sandalye koltukları hariç)")
      );

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

      /* --- 6) Yolcu sayısı kadar koltuk + her koltuk için kendi cinsiyeti --- */
      const need = Math.max(1, Number(s.passengerCount) || 1);
      const genders = passengerGenders(s, need);
      report("info", `${need} yolcu için koltuk seçilecek. Cinsiyetler: ${genders.join(", ")}`);

      const plan = pickSeatsForPassengers(result.seats, need, s.preferredWagon);
      const selected = [];
      const usedEls = new Set();
      let lastWagon = null;

      for (const seat of plan) {
        if (selected.length >= need) break;
        if (selected.some((x) => x.wagon === seat.wagon && x.seatNo === seat.seatNo)) continue;

        if (seat.wagon && seat.wagon !== lastWagon) {
          await ensureWagonTab(seat.wagon);
          lastWagon = seat.wagon;
        }

        try {
          const seatEl = await U.waitFor(() => findSeatElement(seat.seatNo, allowWheelchair), {
            timeout: CFG.WAIT.short,
            label: `koltuk ${seat.seatNo}`
          });
          const passengerNo = selected.length + 1;
          await U.clickReal(seatEl, `koltuk ${seat.wagon}/${seat.seatNo} (yolcu ${passengerNo})`);
          usedEls.add(seatEl);

          // TCDD koltuk seçiminden hemen sonra o koltuk için Bay/Bayan sorar.
          await chooseGenderFor(genders[passengerNo - 1], `yolcu ${passengerNo}`);
          selected.push(seat);
        } catch (e) {
          report("warn", `Koltuk ${seat.wagon}/${seat.seatNo} tıklanamadı, sıradaki deneniyor.`);
        }
      }

      /* --- 7) API listesi yetmediyse haritadaki boş koltuklarla tamamla --- */
      while (selected.length < need) {
        const el = findFreeSeatElement(allowWheelchair, s, usedEls);
        if (!el) break;

        const passengerNo = selected.length + 1;
        const seatNo = U.extractSeatNo(U.textOf(el) || el.id) || "?";
        await U.clickReal(el, `haritadan boş koltuk ${seatNo} (yolcu ${passengerNo})`);
        usedEls.add(el);

        await chooseGenderFor(genders[passengerNo - 1], `yolcu ${passengerNo}`);
        selected.push({ wagon: lastWagon || "?", seatNo });
      }

      if (!selected.length) throw new Error("Uygun koltuk elemanı sayfada bulunamadı.");
      if (selected.length < need) {
        report("warn", `${need} yolcu isteniyordu, ${selected.length} koltuk seçilebildi. Kalanını manuel tamamlayın.`);
      }

      /* --- 8) Dur ve kullanıcıya bırak --- */
      const seatList = selected.map((x, i) => `${x.wagon}/${x.seatNo} (${genders[i]})`).join(", ");
      const detail = `${result.trainLabel} | ${selected.length}/${need} koltuk seçildi: ${seatList}`;
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
  /* Sayfadan okuma (istasyon / tarih / sefer saatleri)                     */
  /* ====================================================================== */

  /** Metin bir istasyon adına benziyor mu? */
  function looksLikeStation(text) {
    const t = String(text || "").trim();
    if (t.length < 3 || t.length > 60) return false;
    if (/^\d/.test(t)) return false;
    if (U.extractTime(t)) return false;
    return (t.match(/[A-Za-zÇĞİÖŞÜçğıöşü]/g) || []).length >= 3;
  }

  /**
   * Metni yalnızca bir saatten ibaret olan görünür elemanlar ("05:30" hücreleri).
   * Kartları metin üzerinden aramak kırılgan: innerText bitişik gelebiliyor
   * ("05:3009:59") ve kelime sınırları çöküyor.
   */
  function findTimeCells() {
    return Array.from(document.querySelectorAll("span,div,td,p,b,strong,time,h4,h5"))
      .filter(U.isVisible)
      .filter((el) => /^([01]?\d|2[0-3])[:.][0-5]\d$/.test(U.textOf(el).trim()));
  }

  /**
   * Sefer kartları: içinde 2-4 saat hücresi bulunan EN DIŞ ata.
   * Daha yukarısı birden fazla kartı kapsayacağı için sınır 4 hücredir.
   */
  function findTripCards() {
    const cells = findTimeCells();
    if (cells.length < 2) return [];

    const cards = new Set();
    for (const cell of cells) {
      let node = cell.parentElement;
      let chosen = null;
      let depth = 0;

      while (node && depth < 10) {
        const count = cells.filter((c) => node.contains(c)).length;
        if (count > 4) break;
        if (count >= 2) chosen = node;
        node = node.parentElement;
        depth++;
      }
      if (chosen) cards.add(chosen);
    }
    return Array.from(cards);
  }

  /**
   * Açık TCDD sayfasından arama bağlamını okur:
   * istasyon adları, tarih ve listelenen tüm sefer kalkış saatleri.
   *
   * İstasyon ID'leri DOM'da bulunmadığı için onlar yakalanan istek
   * şablonundan gelir; burada yalnızca ekranda görünen bilgiler okunur.
   */
  function readPageContext() {
    const ctx = { fromName: "", toName: "", date: "", times: [], notes: [] };

    /* --- İstasyonlar: önce arama çubuğundaki input değerleri --- */
    const values = U.queryAllCandidates(CFG.SELECTORS.stationInput)
      .filter(U.isVisible)
      .map((el) => String(el.value || "").trim())
      .filter(looksLikeStation);

    if (values.length >= 2) {
      ctx.fromName = values[0];
      ctx.toName = values[1];
      ctx.notes.push("istasyonlar: arama çubuğu");
    } else {
      // Yedek: "İSTANBUL(SÖĞÜTLÜÇEŞME) ⇄ ANKARA GAR" gibi başlık metinleri
      const arrow = /\s(?:⇄|⇆|↔|→|➔|->)\s/;
      const header = Array.from(document.querySelectorAll("h1,h2,h3,h4,div,span,p"))
        .filter(U.isVisible)
        .map((el) => U.textOf(el))
        .find((text) => text && text.length < 120 && arrow.test(text));

      if (header) {
        const parts = header.split(arrow).map((x) => x.replace(/^Gidiş\s*-\s*/i, "").trim());
        if (parts.length >= 2 && looksLikeStation(parts[0]) && looksLikeStation(parts[1])) {
          ctx.fromName = parts[0];
          ctx.toName = parts[1];
          ctx.notes.push("istasyonlar: sayfa başlığı");
        }
      }
    }

    /* --- Tarih: kartlarda geçen en sık gg.aa.yyyy --- */
    // \b kullanılmıyor: "27.09.2026Direkt" gibi bitişik metinlerde sınır oluşmaz.
    const dates = document.body.innerText.match(/(?<!\d)\d{2}\.\d{2}\.\d{4}(?!\d)/g) || [];
    if (dates.length) {
      const counts = new Map();
      for (const d of dates) counts.set(d, (counts.get(d) || 0) + 1);
      const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
      const m = best.match(/(\d{2})\.(\d{2})\.(\d{4})/);
      ctx.date = `${m[3]}-${m[2]}-${m[1]}`;
      ctx.notes.push("tarih: sefer kartları");
    }

    /* --- Sefer saatleri: her kartın İLK saati kalkış saatidir --- */
    const cards = findTripCards();
    const cells = findTimeCells();
    const times = [];
    for (const card of cards) {
      // Kart içindeki İLK saat hücresi kalkış, ikincisi varış saatidir.
      const first = cells.find((c) => card.contains(c));
      const time = first ? U.extractTime(U.textOf(first)) : null;
      if (time && !times.includes(time)) times.push(time);
    }
    ctx.times = times.sort();
    if (times.length) ctx.notes.push(`${times.length} sefer saati okundu`);

    U.log("Sayfadan okunan bağlam:", ctx);
    return ctx;
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

      case MSG.READ_PAGE:
        try {
          sendResponse({ ok: true, context: readPageContext() });
        } catch (e) {
          U.error("Sayfa okuma hatası:", e);
          sendResponse({ ok: false, error: String(e.message || e) });
        }
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
    isWheelchairLabel,
    isWheelchairId,
    isWheelchairNode,
    isWheelchairSeatElement,
    wantsWheelchair,
    passengerGenders,
    pickSeatsForPassengers,
    findTrainRow,
    findSeatElement,
    buildSearchBody,
    buildSeatMapBody,
    resolveEndpoint,
    readPageContext,
    findTripCards,
    findTimeCells,
    matchesTime,
    alignTimes,
    apiRequest,
    runScanOnce,
    stopScan
  };

  injectPageScript();
  U.log("content.js hazır. Tarama komutu bekleniyor.");
})();
