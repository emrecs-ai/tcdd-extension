/**
 * config.js
 * -----------------------------------------------------------------------------
 * Eklentinin tek merkezden yönetilen ayar dosyası.
 *
 * Bu dosya bilerek "klasik script" olarak yazılmıştır (import/export YOK):
 *   - content script olarak doğrudan enjekte edilebilir,
 *   - service worker (type: module) içinden `import "./src/config.js"` ile
 *     yüklendiğinde de globalThis üzerine yazdığı için erişilebilir olur.
 *
 * TCDD arayüzü/endpoint'leri değiştiğinde ilk bakılacak yer burasıdır.
 * -----------------------------------------------------------------------------
 */
(function () {
  "use strict";

  const CONFIG = {
    /** Sayfanın kendi origin'i (content script bu adreste çalışır). */
    SITE_ORIGIN: "https://ebilet.tcddtasimacilik.gov.tr",

    /**
     * API tabanı. Background, webRequest ile yakaladığı gerçek isteklerden
     * bu değeri otomatik olarak günceller; aşağıdaki sadece ilk açılış için
     * kullanılan yedek (fallback) değerdir.
     */
    API_BASE_FALLBACK: "https://web-api-prod-ytp.tcddtasimacilik.gov.tr",

    /** Kullanılan uç noktalar (path). */
    ENDPOINTS: {
      stationPairs: "/tms/station/station-pairs-INTERNET",
      availability: "/tms/train/train-availability",
      seatMap: "/tms/seat-maps/load-by-train-id"
    },

    /**
     * Yakalanan (capture edilen) başlıklar. Küçük harf ile tutulur.
     * REQUIRED olanlar olmadan tarama başlatılmaz.
     */
    CAPTURE_HEADERS: [
      "authorization",
      "x-tms-xsrf-token",
      "captcha-session",
      "unit-id",
      "channel-code",
      "device-id",
      "application-name",
      "content-type"
    ],
    REQUIRED_HEADERS: ["authorization", "x-tms-xsrf-token"],

    /** chrome.storage.local anahtarları. */
    KEYS: {
      headers: "tcdd_headers",        // { authorization, x-tms-xsrf-token, captcha-session, ... }
      headersMeta: "tcdd_headers_meta", // { apiBase, capturedAt, source }
      templates: "tcdd_templates",    // sayfadan yakalanan gerçek istek gövdeleri
      settings: "tcdd_settings",      // popup form verileri
      state: "tcdd_state",            // { running, paused, reason, startedAt, ... }
      stations: "tcdd_stations",      // { fetchedAt, list: [{id, name}] }
      log: "tcdd_log"                 // son N log satırı
    },

    /** Mesaj tipleri (popup <-> background <-> content). */
    MSG: {
      // popup -> background
      START: "START_SCAN",
      STOP: "STOP_SCAN",
      GET_STATUS: "GET_STATUS",
      CLEAR_LOG: "CLEAR_LOG",
      OPEN_TCDD: "OPEN_TCDD",
      // background -> content
      CONTENT_START: "CONTENT_START",
      CONTENT_STOP: "CONTENT_STOP",
      CONTENT_PING: "CONTENT_PING",
      // content -> background
      AUTH_EXPIRED: "AUTH_EXPIRED",
      SEATS_FOUND: "SEATS_FOUND",
      TICKET_SELECTED: "TICKET_SELECTED",
      AUTOMATION_FAILED: "AUTOMATION_FAILED",
      CAPTURED_HEADERS: "CAPTURED_HEADERS",
      CAPTURED_TEMPLATE: "CAPTURED_TEMPLATE",
      LOG: "LOG",
      // background -> popup (broadcast)
      STATE_CHANGED: "STATE_CHANGED"
    },

    /**
     * TEKERLEKLİ SANDALYE / ENGELLİ KOLTUKLARI
     * -------------------------------------------------------------------------
     * Standart sınıflar dolu olsa bile bu koltuklar boş kalabildiği için
     * varsayılan olarak TAMAMEN yok sayılır: ne alarm üretirler ne de otomasyonu
     * başlatırlar. Yalnızca kullanıcı popup'tan "Tekerlekli sandalye koltuklarını
     * dahil et" kutusunu işaretlerse (veya vagon tipi olarak bu sınıfı seçerse)
     * taramaya dahil edilirler.
     *
     * Eşleştirme üç kanaldan yapılır:
     *   1) Sınıf/koltuk adı  -> namePatterns
     *   2) Sınıf ID'si       -> classIds  (TCDD tarafında ID değişirse buraya ekleyin)
     *   3) Boolean bayraklar -> flagKeys  (ör. { isWheelchair: true })
     */
    WHEELCHAIR: {
      /** Karşılaştırma normalize edilmiş metin üzerinden yapılır (bkz. dom-utils.normalize). */
      namePatterns: [
        "tekerlekli sandalye",
        "tekerlekli",
        "engelli",
        "ozurlu",
        "wheelchair",
        "handicap",
        "handicapped",
        "disabled",
        "accessible",
        "ozel ihtiyac"
      ],
      /**
       * Bilinen sınıf ID'leri. TCDD, tekerlekli sandalye sınıfına ayrı bir
       * cabinClassId verdiğinde buraya eklemek, ad değişse bile filtrenin
       * çalışmasını sağlar. Debug modunda ham yanıttan okunabilir.
       */
      classIds: [],
      /** Sadece boolean bayrak anahtarları; "disabled" gibi çok anlamlı alanlar bilinçli olarak yok. */
      flagKeys: /(wheelchair|engelli|ozurlu|özürlü|handicap|tekerlekli|accessib)/i,
      /** popup'taki vagon tipi seçeneğinin etiketi. */
      optionLabel: "Tekerlekli Sandalye"
    },

    /** Varsayılan tarama parametreleri. */
    DEFAULTS: {
      intervalSec: 20,        // taramalar arası bekleme
      jitterMs: 4000,         // rastgele sapma (aynı anda sabit ritimde istek atmamak için)
      requestTimeoutMs: 20000,
      maxConsecutiveErrors: 4, // ardışık ağ hatasında taramayı durdur
      minIntervalSec: 8
    },

    /**
     * DOM otomasyonu için aday seçiciler.
     * TCDD arayüzü Angular tabanlıdır ve sınıf isimleri sürüm sürüm değişebilir;
     * bu yüzden her adım için birden fazla aday + metin eşleşmesi tanımlıdır.
     * Bir adım çalışmıyorsa DevTools'tan doğru seçiciyi bulup buraya eklemek yeterlidir.
     */
    SELECTORS: {
      // Sefer listesi satırları
      trainRow: [
        "[class*='sefer-karti']",
        "[class*='seferKarti']",
        "[class*='train-card']",
        "[class*='trip-card']",
        ".card-sefer",
        "tr[class*='sefer']",
        "app-sefer-listesi > div"
      ],
      // Satır içindeki kalkış saati
      trainTime: [
        "[class*='kalkis-saat']",
        "[class*='departure-time']",
        "[class*='saat']",
        ".time"
      ],
      // Satırdaki "vagon tipi seç / koltuk seç" açma butonu
      trainExpandButton: {
        css: [
          "button[class*='vagon']",
          "button[class*='koltuk']",
          "button[class*='select']",
          "button.btn-primary",
          "button"
        ],
        text: ["Koltuk Seç", "Vagon Tipi Seç", "Seçin", "Seç", "Devam"]
      },
      // Vagon tipi (EKONOMİ / BUSINESS / YATAKLI ...) kartları
      cabinClassOption: {
        css: [
          "[class*='vagon-tip']",
          "[class*='cabin']",
          "[class*='class-card']",
          "[class*='kabin']",
          "label",
          "button"
        ],
        text: [] // çalışma anında ayarlardan gelir (ör. "EKONOMİ")
      },
      // Vagon tipi seçildikten sonraki onay butonu
      confirmCabinButton: {
        css: ["button", "a[role='button']"],
        text: ["Seçin", "Seç", "Devam Et", "Devam"]
      },
      // Koltuk haritası konteyneri
      seatMapContainer: [
        "[class*='koltuk-harita']",
        "[class*='seat-map']",
        "[class*='vagon-harita']",
        "app-koltuk-secim",
        "[class*='wagon-map']"
      ],
      // Vagon sekmeleri (1. Vagon, 2. Vagon ...)
      wagonTab: [
        "[class*='vagon-sekme']",
        "[class*='wagon-tab']",
        "[class*='vagon-no']",
        "[role='tab']",
        "button[class*='vagon']",
        "li[class*='vagon']"
      ],
      // Tek tek koltuk elemanları
      seatCell: [
        "[class*='koltuk']:not([class*='harita']):not([class*='vagon'])",
        "[class*='seat']:not([class*='map'])",
        "button[data-seat]",
        "g[class*='seat']",
        "[id^='koltuk']",
        "[id^='seat']"
      ],
      // Dolu koltuk işareti (class içinde geçen ifadeler)
      occupiedSeatMarkers: ["dolu", "occupied", "reserved", "disabled", "taken", "sold"],
      // Tekerlekli sandalye koltuğu işareti (class / aria-label / title içinde aranır).
      // Kullanıcı özellikle istemedikçe bu koltuklara tıklanmaz.
      wheelchairSeatMarkers: ["engelli", "tekerlekli", "wheelchair", "handicap", "accessible"],
      // Cinsiyet seçim ekranındaki butonlar
      genderButton: {
        css: ["button", "label", "[class*='cinsiyet']", "[class*='gender']"],
        text: { E: ["Bay", "Erkek", "BAY"], K: ["Bayan", "Kadın", "BAYAN"] }
      },
      // Cinsiyet modalındaki onay
      genderConfirmButton: {
        css: ["button"],
        text: ["Onayla", "Tamam", "Devam", "Seç"]
      }
    },

    /** Bekleme (waitForElement) varsayılan zaman aşımları. */
    WAIT: {
      short: 5000,
      normal: 12000,
      long: 25000
    },

    NOTIF: {
      AUTH: "tcdd-auth",
      FOUND: "tcdd-found",
      DONE: "tcdd-done",
      ERROR: "tcdd-error",
      INFO: "tcdd-info"
    },

    LOG_LIMIT: 200
  };

  globalThis.TCDD_CONFIG = CONFIG;
})();
