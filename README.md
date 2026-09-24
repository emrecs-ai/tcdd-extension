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
   Bu adım şart: token'lar, Captcha oturumu **ve API adresi** ancak gerçek bir istekten
   yakalanabilir. Popup'taki `JWT` / `XSRF` / `Captcha` / `Uç nokta` rozetlerinin dördü de
   yeşile döndüğünde hazırsınız.
3. Eklenti popup'ını açın, **"↺ Sayfadan doldur"** butonuna basın. Bu buton iki kaynağı
   birleştirir:
   - **Açık TCDD sayfasından (DOM):** istasyon adları, tarih ve ekranda listelenen
     **tüm sefer kalkış saatleri** — bunlar saat seçim listesini oluşturur.
   - **Yakalanan istekten:** istasyon ID'leri (DOM'da bulunmadıkları için).
4. Tarih, sefer saatleri, yolcu sayısı, **her yolcunun cinsiyeti** ve vagon tipini seçip
   **Taramayı Başlat**'a basın.
   Tekerlekli sandalye koltukları varsayılan olarak yok sayılır (bkz. aşağıdaki bölüm).
5. TCDD sekmesini **açık bırakın**. Tarama o sekmede çalışır.

Koltuk bulunduğunda: bildirim gelir → tarama durur → DOM otomasyonu koltuğu seçer →
"Bilet Seçildi, Ödeme Yapın" bildirimi gelir.

### Birden fazla yolcu

Yolcu sayısını artırdığınızda arayüzde her yolcu için ayrı bir cinsiyet seçici çıkar
(`1. Bay`, `2. Bayan`, …). TCDD koltuk seçiminde Bay/Bayan bilgisini **koltuk başına** sorduğu
için otomasyon da şu döngüyü kurar:

```
koltuk 1'e tıkla -> 1. yolcunun cinsiyetini seç
koltuk 2'ye tıkla -> 2. yolcunun cinsiyetini seç
...
```

- Koltuklar mümkünse **aynı vagondan** seçilir (vagon değiştirmeyi en aza indirir); tek vagon
  yetmezse listedeki sırayla devam edilir.
- API'den gelen koltuk listesi yetmezse haritadaki uygun boş koltuklarla tamamlanır.
- Yolcu sayısı kadar koltuk bulunamazsa kaç koltuk seçildiği log'a ve bildirime yazılır,
  kalanını siz tamamlarsınız.
- Yolcu sayısı azaltılıp artırıldığında mevcut cinsiyet seçimleri korunur; yeni yolcular
  son seçimi devralır.

### Uç nokta (API adresi) neden yakalanmalı?

Eklenti, taramada **sayfanın kendi kullandığı istek adresini birebir** kullanır; yapılandırmadaki
yollar yalnızca yedektir. Tahmini bir yola istek atmak şu zincire yol açar:

```
tahmini yol  ->  sunucu 404 (CORS başlığı olmadan)  ->  tarayıcı isteği düşürür
             ->  eklentide "HTTP 0 / Failed to fetch"
```

Aynı sonuç, gövde şeması tutmadığında da görülür: çoğu sunucu 4xx yanıtlarına CORS başlığı
eklemez, tarayıcı da bunu ağ hatası olarak raporlar. Bu yüzden eklenti, sizin manuel aramanızdan
hem **URL'yi** hem de **istek gövdesini** şablon olarak alır ve yalnızca tarih/istasyon/saat
alanlarını değiştirir.

`Uç nokta` rozeti kırmızıysa tarama tahmini adresi dener ve büyük ihtimalle ağ hatası alırsınız —
sayfada bir arama yapmanız yeterlidir. Ağ hatasında eklenti ayrıca **bir kez sadeleştirilmiş
başlıklarla** (yalnızca `Authorization`, `X-Tms-Xsrf-Token`, `Captcha-Session`) tekrar dener;
fazladan bir başlık CORS ön kontrolünde reddediliyorsa bu denemede başarılı olur ve log'a yazar.

### Sefer saatleri

YHT kalkış saatleri sabit olduğu için, tanımlı tarifesi olan güzergâhlarda popup "en erken / en geç"
yerine **sefer saati listesi** gösterir; taranacak seferleri tek tek işaretlersiniz. Hiçbiri
seçilmezse tüm seferler taranır.

- Sabit tarifeler: `src/config.js` → `KNOWN_TIMETABLES`, anahtar `"<kalkışID>-<varışID>"`.
  Hazır gelen: `1325-98` (İstanbul Söğütlüçeşme → Ankara Gar, 15 sefer).
- **Öğrenme:** her taramada dönen kalkış saatleri güzergâh bazında **değiştirilerek** kaydedilir
  (birikmez). Birleştirme, ayrıştırma mantığı değiştiğinde eski/yanlış okunmuş saatlerin
  (ör. saat dilimi düzeltmesinden önceki UTC değerlerinin) listede kalıcılaşmasına yol açıyordu;
  ayrıca eklenti her güncellendiğinde öğrenilen saatler sıfırlanır. Öğrenilen saatler yalnızca
  **sabit tarifesi olmayan** güzergâhlarda gösterilir;
  tanımlı tarifesi olmayan güzergâhlarda (ör. ters yön) liste bir taramadan sonra kendiliğinden
  oluşur. Tarifesi hiç bilinmeyen güzergâhta arayüz saat aralığına düşer.

#### Saat dilimi: API UTC gönderiyor

TCDD API'si kalkış saatlerini **UTC olarak, saat dilimi eki olmadan** gönderir:

```
"2026-09-26T02:30:00"   ->   gerçek kalkış 05:30 (TSİ)
```

Bu yüzden ek taşımayan ISO değerleri UTC kabul edilip **sabit UTC+3** ile sefer saatine çevrilir
(`src/config.js` → `API_TIME`). Tarayıcının yerel saati kullanılmaz; yurt dışındaki bir
kullanıcıda da tarife doğru görünür. `…Z` / `…+03:00` taşıyan değerler de aynı sonuca çevrilir.
API bir gün yerel saat göndermeye başlarsa `API_TIME.naiveIsUtc = false` yapmak yeterlidir.

#### Kalkış saati hangi düğümden okunur?

Yanıt, seferin **tüm duraklarını** taşır ve her durakta bir kalkış saati vardır. Körlemesine
"ilk kalkış benzeri alan" aramak, ara durak ve varış saatlerini ayrı sefer sanmaya yol açıyordu
(ör. 05:30 seferinin Ankara varışı 09:59'un ayrı bir sefer gibi görünmesi). Bu yüzden:

- Sefer düğümü sayılmak için düğümün **yer/koltuk bilgisi taşıması** gerekir; duraklar böylece elenir.
- Kalkış saati, **kullanıcının biniş istasyonuna** ait düğümden okunur (istasyon ID'si, yoksa adı ile).
- Sabitlenemeyen düğümler, sabitlenebilen en az bir kayıt varsa tamamen elenir.
- Log'da saatin hangi alandan okunduğu yazılır: `API'nin ham değeri: "…" (alan: departureTime)`.

Aynı kural DOM tarafında da geçerlidir: sefer kartı eşleştirmesi kartın **ilk saat hücresine**
(kalkış) bakar. Saati kartın herhangi bir yerinde aramak, varış saatiyle eşleşip yanlış sefere
tıklanmasına yol açıyordu.

#### Saat yine de eşleşmiyorsa ("0 tanesi hedef saatlerde")

Geriye kalan olası sebep, tarifedeki saatin farklı bir biniş istasyonuna (ör. Halkalı) ait
olmasıdır; bu, tüm seferlerde **sabit** bir fark yaratır.

Eklenti bu durumda kör kalmaz:

- Eşleşme sıfırsa **dönen tüm saatler ve API'nin ham değeri** log'a yazılır.
- Seçimlerinizle dönen saatler arasında **sabit bir fark** varsa (≤ 4 saat) eşleşme otomatik
  hizalanır ve fark log'a yazılır. En az iki sefer saati seçiliyse uygulanır; tek saat seçiliyse
  yanlış sefere kilitlenmemek için yalnızca öneri olarak bildirilir.
- Fark sabit değilse log'daki listeden doğru saatleri (kesik çerçeveli çipler) işaretlemeniz yeterlidir.

Vagon tipi listesi de `src/config.js` → `CABIN_CLASSES` üzerinden üretilir
(Ekonomi, Business, Loca, Yataklı, Örtülü Kuşet, Tekerlekli Sandalye).

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
await __TCDD_DEBUG__.resolveEndpoint("availability", "/tms/train/train-availability");
__TCDD_DEBUG__.matchesTime("11:10", { times: ["11:10"] });  // true
__TCDD_DEBUG__.state;
```

### Testler

Tarayıcı olmadan çalışan birim testleri:

```bash
node tests/parsers.test.js    # ayrıştırıcılar, şablon yamalama, uç nokta çözümleme, saat eşleşmesi
node tests/manifest.test.js   # manifest ve dosya referansları
node tests/dom.test.js        # sayfadan okuma + sefer kartı eşleştirme (Chromium gerekir)
```

API yanıt şeması değişirse, gerçek yanıtı `tests/parsers.test.js` içine örnek olarak ekleyip
ayrıştırıcıyı ona göre güncellemek en hızlı yoldur.

## 6. Sık karşılaşılan durumlar

| Belirti | Sebep / Çözüm |
|---|---|
| "Güvenlik bilgileri henüz yakalanmadı" | Sayfada henüz manuel arama yapmadınız. Bir arama yapın. |
| **"0 tanesi hedef saatlerde"** | API farklı saatler döndürüyor (saat dilimi ya da farklı biniş istasyonu). Log'daki "Dönen saatler" satırına bakın; fark sabitse eşleşme otomatik hizalanır, değilse kesik çerçeveli çiplerden doğru saatleri seçin. |
| **"Ağ hatası … Failed to fetch" (HTTP 0)** | İstek hiç yanıt alamadı: uç nokta öğrenilmemiş (tahmini yol 404 veriyor), gövde şeması tutmuyor ya da bir başlık CORS ön kontrolünde reddediliyor. Çözüm: TCDD sayfasında bir kez **manuel arama** yapın — `Uç nokta` rozeti yeşile döner, eklenti gerçek adresi ve gövdeyi kullanır. |
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
