/**
 * dom-utils.js
 * -----------------------------------------------------------------------------
 * Content script tarafında kullanılan yardımcı fonksiyonlar.
 * Angular tabanlı arayüz asenkron render ettiği için tüm DOM erişimleri
 * MutationObserver destekli bekleme fonksiyonları üzerinden yapılır.
 * -----------------------------------------------------------------------------
 */
(function () {
  "use strict";

  const PREFIX = "%c[TCDD]";
  const STYLE = "color:#0b7285;font-weight:600";

  const U = {
    /** Basit log yardımcıları (hata ayıklama için bilinçli olarak bol log var). */
    log(...args) {
      console.log(PREFIX, STYLE, ...args);
    },
    warn(...args) {
      console.warn(PREFIX, STYLE, ...args);
    },
    error(...args) {
      console.error(PREFIX, STYLE, ...args);
    },

    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    /** Metni karşılaştırma için normalize eder (Türkçe karakter + boşluk + case). */
    normalize(text) {
      return String(text || "")
        .replace(/ /g, " ")
        .trim()
        .toLocaleLowerCase("tr-TR")
        .replace(/\s+/g, " ")
        .replace(/[iı]/g, "i")
        .replace(/[şs]/g, "s")
        .replace(/[ğg]/g, "g")
        .replace(/[üu]/g, "u")
        .replace(/[öo]/g, "o")
        .replace(/[çc]/g, "c");
    },

    textOf(el) {
      if (!el) return "";
      return (el.innerText || el.textContent || "").trim();
    },

    /** Element ekranda gerçekten görünüyor mu? */
    isVisible(el) {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    },

    isDisabled(el) {
      if (!el) return true;
      if (el.disabled) return true;
      if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
      const cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || "";
      return /\bdisabled\b|\bpassive\b/i.test(String(cls));
    },

    /** Aday seçici listesinden ilk eşleşen elemanları döndürür. */
    queryAllCandidates(selectors, root) {
      const scope = root || document;
      const out = [];
      for (const sel of [].concat(selectors || [])) {
        let found = [];
        try {
          found = Array.from(scope.querySelectorAll(sel));
        } catch (e) {
          U.warn("Geçersiz seçici atlandı:", sel, e.message);
          continue;
        }
        for (const el of found) {
          if (!out.includes(el)) out.push(el);
        }
      }
      return out;
    },

    /**
     * Verilen metinlerden birini içeren, tıklanabilir ve görünür elemanı bulur.
     * @param {object} spec { css: string[], text: string[] }
     */
    findByText(spec, root) {
      const scope = root || document;
      const wanted = (spec.text || []).map(U.normalize).filter(Boolean);
      const candidates = U.queryAllCandidates(spec.css && spec.css.length ? spec.css : ["button", "a", "label", "div", "span"], scope);

      // Önce birebir eşleşme, sonra "içeriyor" eşleşmesi denenir.
      for (const mode of ["exact", "contains"]) {
        for (const el of candidates) {
          if (!U.isVisible(el) || U.isDisabled(el)) continue;
          const txt = U.normalize(U.textOf(el));
          if (!txt) continue;
          for (const w of wanted) {
            if (mode === "exact" ? txt === w : txt.includes(w)) {
              return el;
            }
          }
        }
      }
      return null;
    },

    /**
     * Bir elemanı bekler. Önce anlık kontrol, sonra MutationObserver ile izleme,
     * ek olarak da düzenli aralıklı yoklama (bazı Angular güncellemeleri
     * observer'ı tetiklemeyebiliyor).
     *
     * @param {function(): Element|null} finder  Elemanı bulan fonksiyon
     * @param {object} opts { timeout, interval, label }
     * @returns {Promise<Element>}
     */
    waitFor(finder, opts) {
      const { timeout = 12000, interval = 350, label = "element" } = opts || {};
      return new Promise((resolve, reject) => {
        let done = false;

        const tryFind = () => {
          if (done) return true;
          let el = null;
          try {
            el = finder();
          } catch (e) {
            U.warn("waitFor finder hatası:", label, e.message);
          }
          if (el) {
            done = true;
            cleanup();
            U.log(`waitFor -> bulundu: ${label}`);
            resolve(el);
            return true;
          }
          return false;
        };

        const observer = new MutationObserver(() => tryFind());
        const poll = setInterval(() => tryFind(), interval);
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          cleanup();
          U.warn(`waitFor -> zaman aşımı: ${label}`);
          reject(new Error(`Zaman aşımı: ${label} bulunamadı (${timeout}ms)`));
        }, timeout);

        function cleanup() {
          observer.disconnect();
          clearInterval(poll);
          clearTimeout(timer);
        }

        if (tryFind()) return;
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true
        });
      });
    },

    /** Seçici listesinden görünür ilk elemanı bekler. */
    waitForSelector(selectors, opts) {
      const label = (opts && opts.label) || String(selectors);
      return U.waitFor(
        () => U.queryAllCandidates(selectors).find((el) => U.isVisible(el)) || null,
        Object.assign({ label }, opts)
      );
    },

    /** Metin eşleşmeli elemanı bekler. */
    waitForText(spec, opts) {
      const label = (opts && opts.label) || `metin: ${(spec.text || []).join("/")}`;
      return U.waitFor(() => U.findByText(spec, (opts && opts.root) || document), Object.assign({ label }, opts));
    },

    /**
     * Angular'ın dinlediği olayları da üreterek "gerçek" bir tıklama simüle eder.
     * Sadece el.click() bazı bileşenlerde yeterli olmuyor.
     */
    async clickReal(el, label) {
      if (!el) throw new Error(`Tıklanacak eleman yok: ${label || ""}`);
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      await U.sleep(250);

      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

      try {
        el.dispatchEvent(new PointerEvent("pointerdown", Object.assign({ pointerId: 1, isPrimary: true }, base)));
      } catch (e) {
        /* PointerEvent desteklenmiyorsa sorun değil */
      }
      el.dispatchEvent(new MouseEvent("mousedown", base));
      el.dispatchEvent(new MouseEvent("mouseup", base));
      el.dispatchEvent(new MouseEvent("click", base));
      if (typeof el.click === "function") {
        try {
          el.click();
        } catch (e) {
          /* çift tıklamayı engelleyen bileşenlerde hata yutulur */
        }
      }
      U.log("Tıklandı:", label || U.textOf(el).slice(0, 40) || el.tagName);
      await U.sleep(400);
      return true;
    },

    /** Input alanına Angular'ın algılayacağı şekilde değer yazar. */
    async setInputValue(input, value) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await U.sleep(200);
    },

    /**
     * Metindeki ilk saati "HH:mm" olarak çeker.
     * Desteklenen biçimler:
     *   "2026-09-25T08:15:00"      -> 08:15   (ISO)
     *   "25-09-2026 09:40:00"      -> 09:40   (TCDD API biçimi)
     *   "08:15 Ankara ..."         -> 08:15   (DOM metni)
     * Saniye kısmının saat sanılmaması için tarih bölümü ayrıca ele alınır.
     */
    extractTime(text) {
      const str = String(text || "");
      const pad = (v) => String(v).padStart(2, "0");

      let m = str.match(/(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):([0-5]\d)/);
      if (m) return `${pad(m[4])}:${m[5]}`;

      m = str.match(/(\d{1,2})[-./](\d{1,2})[-./](\d{4})[T\s](\d{1,2}):([0-5]\d)/);
      if (m) return `${pad(m[4])}:${m[5]}`;

      // Öncesinde rakam veya ':' olmayan ilk HH:mm
      m = str.match(/(?:^|[^\d:])([01]?\d|2[0-3])[:.]([0-5]\d)/);
      return m ? `${pad(m[1])}:${m[2]}` : null;
    },

    /** "HH:mm" -> dakika */
    toMinutes(hhmm) {
      if (!hhmm) return null;
      const m = String(hhmm).match(/(\d{1,2})[:.](\d{2})/);
      if (!m) return null;
      return Number(m[1]) * 60 + Number(m[2]);
    },

    /** Metinden koltuk numarasını çeker (ör. "12A" veya "34"). */
    extractSeatNo(text) {
      const m = String(text || "").trim().match(/\b(\d{1,3}[A-Fa-f]?)\b/);
      return m ? m[1].toUpperCase() : null;
    }
  };

  globalThis.TCDD_DOM = U;
})();
