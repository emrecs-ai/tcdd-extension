/**
 * injected.js  (MAIN world / sayfa bağlamı)
 * -----------------------------------------------------------------------------
 * NEDEN VAR?
 *   MV3'te service worker (background.js) üzerinden atılan fetch istekleri
 *   cross-origin + SameSite kısıtları nedeniyle sayfanın oturum çerezlerini
 *   taşımaz ve TCDD API'si 403 döner.
 *
 *   Bu dosya content script tarafından <script src=...> ile sayfanın kendi
 *   bağlamına enjekte edilir. Böylece buradan atılan istekler, kullanıcının
 *   sayfada yaptığı gerçek isteklerle birebir aynı şekilde (aynı origin,
 *   aynı çerezler, aynı referrer) gider.
 *
 * İKİ GÖREVİ VAR:
 *   1) Content script'ten postMessage ile gelen API isteklerini çalıştırmak.
 *   2) Sayfanın kendi fetch/XHR çağrılarını dinleyip güncel Authorization,
 *      X-Tms-Xsrf-Token ve Captcha-Session başlıklarını + gerçek istek
 *      gövdelerini (şablon olarak) content script'e iletmek.
 * -----------------------------------------------------------------------------
 */
(function () {
  "use strict";

  if (window.__TCDD_INJECTED__) return;
  window.__TCDD_INJECTED__ = true;

  const CS = "TCDD_EXT_CS";    // content script -> page
  const PAGE = "TCDD_EXT_PAGE"; // page -> content script
  const INTEREST = /\/tms\//i;  // sadece TCDD API çağrıları ile ilgileniyoruz
  const WANTED = [
    "authorization",
    "x-tms-xsrf-token",
    "captcha-session",
    "unit-id",
    "channel-code",
    "device-id",
    "application-name"
  ];

  let selfCallDepth = 0; // kendi isteklerimizi yakalama döngüsüne sokmamak için

  const log = (...a) => console.log("%c[TCDD/page]", "color:#5f3dc4;font-weight:600", ...a);

  function post(type, data) {
    window.postMessage(Object.assign({ source: PAGE, type }, data), window.location.origin);
  }

  /** Header koleksiyonunu (Headers | object | array) düz objeye çevirir. */
  function normalizeHeaders(init) {
    const out = {};
    if (!init) return out;
    try {
      if (typeof Headers !== "undefined" && init instanceof Headers) {
        init.forEach((v, k) => (out[String(k).toLowerCase()] = v));
      } else if (Array.isArray(init)) {
        init.forEach(([k, v]) => (out[String(k).toLowerCase()] = v));
      } else if (typeof init === "object") {
        Object.keys(init).forEach((k) => (out[String(k).toLowerCase()] = init[k]));
      }
    } catch (e) {
      /* yoksay */
    }
    return out;
  }

  function reportCapture(url, headers, body) {
    const picked = {};
    for (const k of WANTED) {
      if (headers[k]) picked[k] = headers[k];
    }
    if (!Object.keys(picked).length) return;

    let parsedBody = null;
    if (typeof body === "string" && body.length && body.length < 60000) {
      try {
        parsedBody = JSON.parse(body);
      } catch (e) {
        parsedBody = null;
      }
    }

    post("CAPTURE", {
      url: String(url),
      headers: picked,
      body: parsedBody,
      at: Date.now()
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 1) Sayfanın fetch çağrılarını dinle                                     */
  /* ---------------------------------------------------------------------- */
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (selfCallDepth === 0) {
        const url = typeof input === "string" ? input : input && input.url;
        if (url && INTEREST.test(url)) {
          const headers = Object.assign(
            {},
            normalizeHeaders(input && input.headers),
            normalizeHeaders(init && init.headers)
          );
          const body = init && typeof init.body === "string" ? init.body : null;
          reportCapture(url, headers, body);
        }
      }
    } catch (e) {
      /* dinleme hatası asıl isteği bozmamalı */
    }
    return originalFetch.apply(this, arguments);
  };

  /* ---------------------------------------------------------------------- */
  /* 2) Sayfanın XMLHttpRequest çağrılarını dinle                            */
  /* ---------------------------------------------------------------------- */
  const XHR = window.XMLHttpRequest;
  const originalOpen = XHR.prototype.open;
  const originalSetHeader = XHR.prototype.setRequestHeader;
  const originalSend = XHR.prototype.send;

  XHR.prototype.open = function (method, url) {
    this.__tcddUrl = url;
    this.__tcddHeaders = {};
    return originalOpen.apply(this, arguments);
  };

  XHR.prototype.setRequestHeader = function (key, value) {
    try {
      if (this.__tcddHeaders) this.__tcddHeaders[String(key).toLowerCase()] = value;
    } catch (e) {
      /* yoksay */
    }
    return originalSetHeader.apply(this, arguments);
  };

  XHR.prototype.send = function (body) {
    try {
      if (this.__tcddUrl && INTEREST.test(this.__tcddUrl)) {
        reportCapture(this.__tcddUrl, this.__tcddHeaders || {}, typeof body === "string" ? body : null);
      }
    } catch (e) {
      /* yoksay */
    }
    return originalSend.apply(this, arguments);
  };

  /* ---------------------------------------------------------------------- */
  /* 3) Content script'ten gelen API isteklerini sayfa bağlamında çalıştır   */
  /* ---------------------------------------------------------------------- */
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== CS) return;

    if (msg.type === "PING") {
      post("PONG", { id: msg.id });
      return;
    }

    if (msg.type !== "API_REQUEST") return;

    const { id, url, method, headers, body, timeoutMs } = msg;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 20000);

    selfCallDepth++;
    try {
      log("API isteği:", method || "POST", url);
      const res = await originalFetch(url, {
        method: method || "POST",
        headers: headers || {},
        body: body ? JSON.stringify(body) : undefined,
        // Kritik nokta: çerezler gönderilsin.
        credentials: "include",
        mode: "cors",
        cache: "no-store",
        referrer: window.location.href,
        signal: controller.signal
      });

      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (e) {
        json = null;
      }

      post("API_RESPONSE", {
        id,
        ok: res.ok,
        status: res.status,
        json,
        text: json ? null : String(text || "").slice(0, 2000)
      });
    } catch (err) {
      post("API_RESPONSE", {
        id,
        ok: false,
        status: 0,
        error: err && err.name === "AbortError" ? "Zaman aşımı" : String((err && err.message) || err)
      });
    } finally {
      selfCallDepth--;
      clearTimeout(timer);
    }
  });

  post("READY", {});
  log("Sayfa bağlamı köprüsü hazır.");
})();
