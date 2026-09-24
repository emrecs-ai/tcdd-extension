# TCDD e-Bilet Koltuk Tarayıcı (Chrome MV3)

TCDD e-bilet sisteminde belirlediğiniz güzergâh/tarih/saat aralığı için **boş koltuk taraması**
yapan ve koltuk bulunduğunda sayfa üzerindeki **seçim adımlarını otomatikleştiren** Manifest V3
tarayıcı eklentisi.

> Ödeme adımı bilinçli olarak otomatikleştirilmez. Eklenti koltuğu seçip cinsiyet adımını
> tamamlar, ardından durur ve size bildirim gönderir; ödemeyi siz yaparsınız.

---

## 1. Neden bu mimari? (403 problemi)

TCDD API'si isteklerde `Authorization` (JWT), `X-Tms-Xsrf-Token` ve `Captcha-Session`
başlıklarını ister; bu token'ların geçerli sayılabilmesi için tarayıcıdaki **oturum
çerezlerinin de istekle birlikte gitmesi** gerekir.

Manifest V3'te `background.js` bir Service Worker'dır ve buradan atılan `fetch` istekleri
cross-origin + SameSite kısıtları nedeniyle sayfanın çerezlerini taşımaz → **403 Forbidden**.

Bu yüzden görev dağılımı şöyledir:

| Dosya | Bağlam | Görev |
|---|---|---|
| `background.js` | Service Worker | `webRequest.onBeforeSendHeaders` ile token yakalar, sekmeyi/enjeksiyonu yönetir, bildirim gönderir. **Hiç API isteği atmaz.** |
| `content.js` | TCDD sekmesi (isolated world) | Tarama döngüsü, yanıt ayrıştırma, DOM otomasyonu. |
| `src/injected.js` | TCDD sekmesi (**page context / MAIN world**) | Tüm `fetch` çağrıları burada, `credentials: "include"` ile yapılır. Ayrıca sayfanın kendi `fetch`/`XHR` çağrılarını dinleyip token ve istek gövdelerini yakalar. |
| `popup.html/js/css` | Popup | Arama kriterleri, başlat/durdur, canlı kayıt. |

```
popup  ──START──▶  background ──CONTENT_START──▶  content.js
                        ▲                            │ postMessage
                        │                            ▼
              webRequest ile token           src/injected.js  ──fetch(credentials:include)──▶  TCDD API
```

## 2. Kurulum

1. Bu klasörü bilgisayarınıza indirin.
2. Chrome'da `chrome://extensions` adresini açın.
3. Sağ üstten **Geliştirici modu**'nu açın.
4. **Paketlenmemiş öğe yükle** → bu klasörü seçin.

## 3. Kullanım

1. `https://ebilet.tcddtasimacilik.gov.tr` adresini açın.
2. **Sayfada bir kez manuel arama yapın** (gerekirse Captcha'yı çözün).
   Bu adım şart: token'lar ve Captcha oturumu ancak gerçek bir istekten yakalanabilir.
   Popup'taki `JWT` / `XSRF` / `Captcha` rozetleri yeşile döndüğünde hazırsınız.
3. Eklenti popup'ını açın, **"↺ Son manuel aramadan doldur"** butonuna basın — kalkış/varış
   istasyonları ve ID'leri yaptığınız aramadan otomatik doldurulur.
4. Tarih, saat aralığı, yolcu sayısı, cinsiyet ve vagon tipini seçip **Taramayı Başlat**'a basın.
   Tekerlekli sandalye koltukları varsayılan olarak yok sayılır (bkz. aşağıdaki bölüm).
5. TCDD sekmesini **açık bırakın**. Tarama o sekmede çalışır.

Koltuk bulunduğunda: bildirim gelir → tarama durur → DOM otomasyonu koltuğu seçer →
"Bilet Seçildi, Ödeme Yapın" bildirimi gelir.

### Tekerlekli sandalye (engelli) koltukları

Standart sınıflar dolu olsa bile bu koltuklar boş kalabildiği için **varsayılan olarak
tamamen yok sayılır**: alarm üretmezler ve otomatik seçimi başlatmazlar. Filtre üç katmanda
çalışır:

1. **Kabin sayımı** — sefer yanıtındaki vagon tipi kırılımında tekerlekli sandalye sınıfına
   ait boş yerler toplama katılmaz. Sadece o sınıf boşsa tarama "boş yer yok" kabul edip
   devam eder (log'a bilgi satırı düşer).
2. **Koltuk haritası** — kabin kırılımı yoksa ya da yanıltıcıysa ikinci kapı burasıdır.
   `purchasableSeats` içindeki koltuklar; koltuğun kendi tip/açıklama alanı, boolean bayrağı
   (`isWheelchairSeat` vb.) veya bulunduğu vagonun sınıf adı/ID'si üzerinden elenir.
   Boş koltukların tamamı bu sınıftaysa alarm verilmez, tarama sürer.
3. **DOM otomasyonu** — son kontrol noktası. Koltuk haritasındaki `engelli` / `tekerlekli` /
   `wheelchair` işaretli elemanlara tıklanmaz (yedek "ilk boş koltuk" seçimi dahil).

Bu koltukları taramaya dahil etmek için popup'taki **"Tekerlekli sandalye (engelli)
koltuklarını dahil et"** kutusunu işaretleyin. Vagon tipi olarak **"Tekerlekli Sandalye"**
seçerseniz tarama yalnızca bu koltukları hedefler (kutu otomatik işaretlenir ve kilitlenir).

Eşleştirme `src/config.js` → `WHEELCHAIR` altındadır:

| Alan | Görev |
|---|---|
| `namePatterns` | Sınıf/koltuk adı eşleşmeleri ("tekerlekli sandalye", "engelli", "wheelchair" ...) |
| `classIds` | Bilinen sınıf ID'leri. TCDD adı değiştirirse ID eklemek filtreyi ayakta tutar. |
| `flagKeys` | Boolean bayrak anahtarları. `disabled` gibi çok anlamlı alanlar bilinçli olarak dışarıda (bazı şemalarda "seçilemez" demek). |

`SELECTORS.wheelchairSeatMarkers` ise DOM tarafındaki işaretleri tutar.

### Captcha / oturum süresi dolarsa

API 401 veya 403 döndüğünde tarama **anında** durdurulur (`clearInterval`) ve şu bildirim gelir:

> Güvenlik süresi doldu. Lütfen TCDD sayfasını yenileyip manuel bir arama yaparak Captcha'yı çözün.

Siz sayfada manuel arama yaptığınız anda `background.js` yeni token'ları yakalar ve tarama
**kaldığı yerden kendiliğinden devam eder** (popup'ı tekrar açmanıza gerek yoktur).

## 4. Ayarlar ve uyarlama

Tüm uç noktalar, başlık adları, bekleme süreleri ve DOM seçicileri tek dosyadadır:
**`src/config.js`**.

### API uç noktaları
`ENDPOINTS` altındadır. `API_BASE_FALLBACK` yalnızca ilk açılış içindir; gerçek adres
yakalanan trafikten otomatik öğrenilir.

### İstek gövdeleri
Eklenti, sizin yaptığınız gerçek aramanın gövdesini **şablon** olarak saklar
(`CAPTURED_TEMPLATE`) ve taramada bu şablonun yalnızca tarih/istasyon alanlarını değiştirir.
Böylece API şeması değişse bile istek doğru biçimde gider. Şablon yoksa `content.js`
içindeki varsayılan gövde kullanılır.

### DOM seçicileri
`SELECTORS` altında her adım için **birden fazla aday seçici + metin eşleşmesi** tanımlıdır.
Bir adım çalışmazsa DevTools'ta doğru seçiciyi bulup ilgili listeye eklemeniz yeterlidir.
Tüm beklemeler `MutationObserver` + periyodik yoklama ile yapılır (`src/dom-utils.js` →
`waitFor`, `waitForSelector`, `waitForText`).

## 5. Hata ayıklama

- **Sayfa konsolu** (TCDD sekmesi): `[TCDD]` ve `[TCDD/page]` etiketli loglar.
- **Service Worker konsolu**: `chrome://extensions` → eklenti → "Service Worker" bağlantısı.
- **Popup**: "Canlı Kayıt" paneli tüm adımları gösterir.
- Popup'ta **Debug log** kutusunu işaretlerseniz ham API yanıtları konsola basılır.
- Sayfa konsolundan ayrıştırıcıları doğrudan deneyebilirsiniz:

```js
__TCDD_DEBUG__.extractTrains(yanitJson);            // [{ time, emptyCount, cabins: [{label,id,count,wheelchair}] }]
__TCDD_DEBUG__.extractEmptySeats(koltukHaritasiJson, {});  // { seats, total, wheelchairSkipped }
__TCDD_DEBUG__.isWheelchairLabel("Tekerlekli Sandalye");   // true
__TCDD_DEBUG__.state;
```

### Testler

Tarayıcı olmadan çalışan birim testleri:

```bash
node tests/parsers.test.js    # yanıt ayrıştırıcıları + şablon yamalama
node tests/manifest.test.js   # manifest ve dosya referansları
```

API yanıt şeması değişirse, gerçek yanıtı `tests/parsers.test.js` içine örnek olarak ekleyip
ayrıştırıcıyı ona göre güncellemek en hızlı yoldur.

## 6. Sık karşılaşılan durumlar

| Belirti | Sebep / Çözüm |
|---|---|
| "Güvenlik bilgileri henüz yakalanmadı" | Sayfada henüz manuel arama yapmadınız. Bir arama yapın. |
| 403 / 401 döngüsü | Captcha süresi doluyor. Sayfayı yenileyip manuel arama yapın; tarama otomatik devam eder. |
| "Yanıt ayrıştırılamadı veya sefer bulunamadı" | API şeması değişmiş olabilir. Debug modunu açıp ham yanıta bakın, `RE` desenlerini güncelleyin. |
| Koltuk bulunuyor ama DOM adımları takılıyor | `src/config.js` → `SELECTORS` içindeki aday seçicileri güncelleyin. |
| Tarama kendiliğinden durdu | Sekme kapandı ya da ardışık ağ hatası sınırı aşıldı (`DEFAULTS.maxConsecutiveErrors`). |
| "Yalnızca tekerlekli sandalye koltuğu boş" logu geliyor | Beklenen davranış. Bu koltukları da istiyorsanız popup'taki kutuyu işaretleyin. |
| Engelli koltuğu alarm üretiyor | Sınıf adı beklenenden farklı olabilir. Debug modunda ham yanıttaki sınıf adını/ID'sini görüp `WHEELCHAIR.namePatterns` veya `classIds` listesine ekleyin. |

## 7. Sorumlu kullanım

- Tarama periyodu **en az 8 saniyedir** ve her istekte rastgele sapma (jitter) eklenir;
  bu sınırı düşürmeyin. Gereksiz yük oluşturmamak için makul bir periyot (20 sn ve üzeri) seçin.
- Eklenti yalnızca **sizin kendi oturumunuz** üzerinden, sizin görebileceğiniz verilerle çalışır;
  Captcha'yı çözmeye veya güvenlik kontrollerini atlatmaya çalışmaz — süresi dolduğunda durur
  ve sizden manuel çözüm ister.
- Ödeme/satın alma adımı otomatikleştirilmez.
- Tekerlekli sandalye (engelli) koltukları varsayılan olarak hiç taranmaz; bu koltukların
  ihtiyaç sahiplerine kalması için filtre bilinçli olarak "varsayılan açık" tasarlanmıştır.
- Kişisel kullanım içindir; TCDD'nin kullanım koşullarına uymak kullanıcının sorumluluğundadır.

## 8. Dosya düzeni

```
manifest.json          MV3 tanımı (webRequest, scripting, activeTab, storage, notifications)
background.js          Token dinleyici + orkestratör (API isteği atmaz)
content.js             Tarama motoru + DOM otomasyonu
popup.html/.css/.js    Arayüz
src/config.js          Uç noktalar, başlıklar, seçiciler, varsayılanlar
src/dom-utils.js       waitFor / clickReal / metin-saat ayrıştırma yardımcıları
src/injected.js        Sayfa bağlamı köprüsü (fetch + token/şablon yakalama)
tests/                 Tarayıcısız birim testleri
icons/                 Eklenti ikonları
```
