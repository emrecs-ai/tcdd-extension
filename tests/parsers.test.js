/**
 * tests/parsers.test.js
 * -----------------------------------------------------------------------------
 * content.js içindeki şemadan bağımsız ayrıştırıcıları (extractTrains,
 * extractEmptySeats, buildSearchBody) tarayıcı olmadan sınar.
 *
 * Çalıştırma:  node tests/parsers.test.js
 *
 * TCDD API yanıt şeması değiştiğinde, gerçek yanıtı buraya örnek olarak
 * ekleyip ayrıştırıcıyı ona göre güncellemek en hızlı yoldur.
 * -----------------------------------------------------------------------------
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const noop = () => {};
const elStub = () => ({ id: "", src: "", onload: null, remove: noop, appendChild: noop, setAttribute: noop });

const sandbox = {};
sandbox.globalThis = sandbox;
sandbox.console = console;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.setInterval = setInterval;
sandbox.clearInterval = clearInterval;
sandbox.window = {
  addEventListener: noop,
  location: { origin: "https://ebilet.tcddtasimacilik.gov.tr", href: "https://ebilet.tcddtasimacilik.gov.tr/" },
  postMessage: noop
};
sandbox.document = {
  getElementById: () => null,
  createElement: elStub,
  querySelectorAll: () => [],
  head: { appendChild: noop },
  documentElement: { appendChild: noop }
};
sandbox.chrome = {
  runtime: {
    onMessage: { addListener: noop },
    getURL: (p) => "chrome-extension://test/" + p,
    sendMessage: async () => ({ ok: true })
  },
  storage: { local: { get: async () => ({}), set: async () => {} } }
};
sandbox.MutationObserver = class { observe() {} disconnect() {} };

vm.createContext(sandbox);
for (const f of ["src/config.js", "src/dom-utils.js", "content.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
}

const D = sandbox.window.__TCDD_DEBUG__;
let failed = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name, extra === undefined ? "" : JSON.stringify(extra));
  if (!cond) failed++;
};

/* ---- Örnek 1: TCDD benzeri sefer arama yanıtı ---- */
const availability = {
  trainLegs: [
    {
      trainAvailabilities: [
        {
          trains: [
            {
              id: 90001,
              commercialName: "YHT 12345",
              segments: [{ departureTime: "2026-09-25T08:15:00", arrivalTime: "2026-09-25T12:45:00" }],
              cabinClassAvailabilities: [
                { cabinClass: { name: "EKONOMİ" }, availabilityCount: 0 },
                { cabinClass: { name: "BUSINESS" }, availabilityCount: 0 }
              ]
            },
            {
              id: 90002,
              commercialName: "YHT 12347",
              segments: [{ departureTime: "2026-09-25T14:30:00" }],
              cabinClassAvailabilities: [
                { cabinClass: { name: "EKONOMİ" }, availabilityCount: 3 },
                { cabinClass: { name: "BUSINESS" }, availabilityCount: 1 }
              ]
            },
            {
              id: 90003,
              commercialName: "YHT 12349",
              segments: [{ departureTime: "2026-09-25T21:00:00" }],
              cabinClassAvailabilities: [{ cabinClass: { name: "EKONOMİ" }, availabilityCount: 12 }]
            }
          ]
        }
      ]
    }
  ]
};

const trains = D.extractTrains(availability);
check("3 sefer ayrıştırıldı", trains.length === 3, trains.map((t) => t.time));
check("saatler doğru", trains.map((t) => t.time).join(",") === "08:15,14:30,21:00");
check("dolu sefer 0 yer", trains[0].emptyCount === 0);
check("14:30 seferi 4 yer", trains[1].emptyCount === 4, trains[1].emptyCount);
check("tren adı okundu", trains[1].name === "YHT 12347", trains[1].name);

/* ---- Örnek 2: alternatif şema (Türkçe alan adları) ---- */
const availabilityTr = {
  seferler: [
    { trenId: 5, binisTarih: "25-09-2026 09:40:00", bosYerSayisi: 2, trenAdi: "ANADOLU EKSPRESİ" }
  ]
};
const trainsTr = D.extractTrains(availabilityTr);
check("Türkçe şema ayrıştırıldı", trainsTr.length === 1 && trainsTr[0].time === "09:40", trainsTr);
check("Türkçe şemada boş yer", trainsTr[0].emptyCount === 2, trainsTr[0].emptyCount);

/* ---- Örnek 3: koltuk haritası ---- */
const seatMap = {
  trainCars: [
    {
      trainCarId: 11,
      carName: "1",
      cabinClassName: "EKONOMİ",
      seats: [
        { seatNumber: "1A", status: "OCCUPIED" },
        { seatNumber: "1B", status: "AVAILABLE" },
        { seatNumber: "2A", isAvailable: false },
        { seatNumber: "2B", isAvailable: true }
      ]
    },
    {
      trainCarId: 12,
      carName: "2",
      seats: [
        { seatNumber: "5C", occupied: true },
        { seatNumber: "5D", occupied: false },
        { seatNumber: "5D", occupied: false } // tekrar eden kayıt
      ]
    }
  ]
};
const seats = D.extractEmptySeats(seatMap).seats;
check("boş koltuklar bulundu", seats.length === 3, seats);
check("vagon id'si üst düğümden taşındı", seats.every((s) => s.carId === 11 || s.carId === 12), seats);
check("vagon bilgisi taşınıyor", seats.every((s) => s.wagon === "1" || s.wagon === "2"), seats);
check("dolu koltuk elenmiş", !seats.some((s) => s.seatNo === "1A" || s.seatNo === "2A" || s.seatNo === "5C"));
check("tekrar eden koltuk tekilleşti", seats.filter((s) => s.seatNo === "5D").length === 1);

/* ---- Örnek 3c: tekerlekli sandalye (engelli) koltuk filtresi ---- */

// Kabin seviyesi: standart sınıflar dolu, yalnızca tekerlekli sandalye boş.
const wheelchairOnlyTrain = D.extractTrains({
  trains: [
    {
      id: 7001,
      commercialName: "YHT 90",
      departureTime: "2026-09-25T10:00:00",
      cabinClassAvailabilities: [
        { cabinClass: { id: 1, name: "EKONOMİ" }, availabilityCount: 0 },
        { cabinClass: { id: 2, name: "BUSINESS" }, availabilityCount: 0 },
        { cabinClass: { id: 9, name: "TEKERLEKLİ SANDALYE" }, availabilityCount: 2 }
      ]
    }
  ]
})[0];

check("tekerlekli sandalye kabini işaretlendi", wheelchairOnlyTrain.cabins.some((c) => c.wheelchair), wheelchairOnlyTrain.cabins);
check("kabin id'si okundu", wheelchairOnlyTrain.cabins.map((c) => c.id).join(",") === "1,2,9", wheelchairOnlyTrain.cabins.map((c) => c.id));
check(
  "varsayılanda tekerlekli sandalye sayılmıyor",
  D.countForCabin(wheelchairOnlyTrain, { cabinClass: "AUTO" }) === 0,
  D.countForCabin(wheelchairOnlyTrain, { cabinClass: "AUTO" })
);
check(
  "kullanıcı isterse sayılıyor",
  D.countForCabin(wheelchairOnlyTrain, { cabinClass: "AUTO", includeWheelchair: true }) === 2
);
check(
  "sınıf olarak seçilirse sadece o sayılıyor",
  D.countForCabin(wheelchairOnlyTrain, { cabinClass: "Tekerlekli Sandalye" }) === 2
);
check(
  "ekonomi istenince tekerlekli sandalye sızmıyor",
  D.countForCabin(wheelchairOnlyTrain, { cabinClass: "Ekonomi" }) === 0
);

// Sınıf adı bilinmese bile yapılandırmadaki ID ile eşleşmeli.
sandbox.TCDD_CONFIG.WHEELCHAIR.classIds = [4242];
const byIdTrain = D.extractTrains({
  trains: [
    {
      id: 7002,
      departureTime: "2026-09-25T11:00:00",
      cabinClassAvailabilities: [{ cabinClass: { id: 4242, name: "BELİRSİZ SINIF" }, availabilityCount: 5 }]
    }
  ]
})[0];
check("sınıf ID'si ile tespit", byIdTrain.cabins[0].wheelchair === true, byIdTrain.cabins[0]);
check("ID ile eşleşen kabin sayılmıyor", D.countForCabin(byIdTrain, { cabinClass: "AUTO" }) === 0);
sandbox.TCDD_CONFIG.WHEELCHAIR.classIds = [];

// Koltuk seviyesi: purchasableSeats içinde hem normal hem engelli koltuk.
const seatMapWheelchair = {
  trainCars: [
    {
      trainCarId: 21,
      carName: "3",
      cabinClassName: "EKONOMİ",
      purchasableSeats: [
        { seatNumber: "10A", status: "OCCUPIED" },
        { seatNumber: "10B", status: "AVAILABLE", seatType: "Pencere kenarı" }
      ]
    },
    {
      trainCarId: 22,
      carName: "4",
      cabinClassName: "TEKERLEKLİ SANDALYE",
      purchasableSeats: [
        { seatNumber: "1C", status: "AVAILABLE" },
        { seatNumber: "1D", status: "AVAILABLE" }
      ]
    },
    {
      trainCarId: 23,
      carName: "5",
      cabinClassName: "EKONOMİ",
      purchasableSeats: [
        { seatNumber: "7A", status: "AVAILABLE", isWheelchairSeat: true },
        { seatNumber: "7B", status: "AVAILABLE", seatDescription: "Engelli koltuğu" }
      ]
    }
  ]
};

const def = D.extractEmptySeats(seatMapWheelchair, {});
check("varsayılanda sadece normal koltuk", def.seats.map((x) => x.seatNo).join(",") === "10B", def.seats);
check("elenen engelli koltuğu sayısı", def.wheelchairSkipped === 4, def.wheelchairSkipped);
check("toplam boş koltuk sayısı", def.total === 5, def.total);

const inc = D.extractEmptySeats(seatMapWheelchair, { includeWheelchair: true });
check("dahil edilince hepsi geliyor", inc.seats.length === 5, inc.seats.map((x) => x.seatNo));
check("vagon sınıfı koltuğa taşındı", inc.seats.find((x) => x.seatNo === "1C").cabin === "TEKERLEKLİ SANDALYE");

const only = D.extractEmptySeats(seatMapWheelchair, { includeWheelchair: true, onlyWheelchair: true });
check("yalnızca engelli koltukları", only.seats.map((x) => x.seatNo).sort().join(",") === "1C,1D,7A,7B", only.seats.map((x) => x.seatNo));

// Tümü engelli koltuğu olan harita: tarama alarm vermemeli (seats boş, skipped > 0).
const allWheelchair = D.extractEmptySeats(
  { cars: [{ carName: "1", cabinClassName: "Tekerlekli Sandalye", seats: [{ seatNumber: "2A", status: "AVAILABLE" }] }] },
  {}
);
check("tamamı engelli koltuğuysa boş dönüyor", allWheelchair.seats.length === 0 && allWheelchair.wheelchairSkipped === 1, allWheelchair);

// "disabled" alanı tek başına engelli koltuğu anlamına gelmemeli.
check("çok anlamlı 'disabled' bayrağı tetiklemiyor", D.isWheelchairNode({ seatNumber: "3A", disabled: true }) === false);
check("isWheelchairLabel Türkçe", D.isWheelchairLabel("Tekerlekli Sandalye") && D.isWheelchairLabel("ENGELLİ"));
check("isWheelchairLabel normal sınıf", !D.isWheelchairLabel("Ekonomi") && !D.isWheelchairLabel("Business"));
check("wantsWheelchair sınıf seçiminden", D.wantsWheelchair({ cabinClass: "Tekerlekli Sandalye" }) === true);
check("wantsWheelchair varsayılan", D.wantsWheelchair({ cabinClass: "AUTO" }) === false);

/* ---- Örnek 3b: saf yardımcı fonksiyonlar ---- */
const DU = sandbox.TCDD_DOM;
check("ISO saat", DU.extractTime("2026-09-25T08:15:00") === "08:15", DU.extractTime("2026-09-25T08:15:00"));
check("TR tarih saat", DU.extractTime("25-09-2026 09:40:00") === "09:40");
check("düz saat", DU.extractTime("08:15 Ankara Gar") === "08:15");
check("saniye saat sanılmıyor", DU.extractTime("08:15:59") === "08:15");
check("saat yok", DU.extractTime("Ankara Gar") === null);
check("dakikaya çevirme", DU.toMinutes("14:30") === 870);
check("koltuk no", DU.extractSeatNo("Koltuk 12A") === "12A", DU.extractSeatNo("Koltuk 12A"));
check("normalize", DU.normalize("  EKONOMİ  ") === DU.normalize("ekonomi"));

/* ---- Örnek 3d: sefer saati eşleşmesi ---- */
const exactTimes = { times: ["11:10", "12:20"], timeFrom: "00:00", timeTo: "23:59" };
check("seçili sefer saati eşleşiyor", D.matchesTime("11:10", exactTimes) === true);
check("seçilmeyen sefer elenir", D.matchesTime("11:50", exactTimes) === false);
check("aralık modu (seçim yok)", D.matchesTime("11:50", { times: [], timeFrom: "11:00", timeTo: "12:00" }) === true);
check("aralık dışı elenir", D.matchesTime("12:20", { times: [], timeFrom: "11:00", timeTo: "12:00" }) === false);

/* ---- Örnek 4: şablon yamalama ve uç nokta çözümleme ---- */
(async () => {
  sandbox.chrome.storage.local.get = async (keys) => ({
    tcdd_templates: {
      availability: {
        body: {
          searchRoutes: [
            {
              departureStationId: 1,
              departureStationName: "X",
              arrivalStationId: 2,
              arrivalStationName: "Y",
              departureDate: "01-01-2026 00:00:00"
            }
          ],
          passengerTypeCounts: [{ id: 0, count: 1 }]
        }
      }
    }
  });

  const body = await D.buildSearchBody({
    fromId: 98,
    fromName: "ANKARA GAR",
    toId: 1135,
    toName: "İSTANBUL",
    date: "2026-09-25",
    passengerCount: 2
  });
  const route = body.searchRoutes[0];
  check("şablon: tarih yamalandı", route.departureDate === "25-09-2026 00:00:00", route.departureDate);
  check("şablon: istasyon id yamalandı", route.departureStationId === 98 && route.arrivalStationId === 1135, route);
  check("şablon: istasyon adı yamalandı", route.departureStationName === "ANKARA GAR", route.departureStationName);

  sandbox.chrome.storage.local.get = async () => ({});
  const fallback = await D.buildSearchBody({
    fromId: 98,
    fromName: "A",
    toId: 2,
    toName: "B",
    date: "2026-12-01",
    passengerCount: 3
  });
  check("şablonsuz varsayılan gövde", fallback.searchRoutes[0].departureDate === "01-12-2026 00:00:00", fallback.searchRoutes[0].departureDate);
  check("yolcu sayısı gövdeye yazıldı", fallback.passengerTypeCounts[0].count === 3);

  /* ---- Uç nokta çözümleme: yakalanan URL tahmine tercih edilmeli ---- */
  sandbox.chrome.storage.local.get = async () => ({
    tcdd_templates: {
      availability: { url: "https://web-api-prod-ytp.tcddtasimacilik.gov.tr/tms/gercek/yol", body: {} }
    }
  });
  const ep = await D.resolveEndpoint("availability", "/tms/tahmini/yol");
  check(
    "yakalanan URL kullanılıyor",
    ep.url === "https://web-api-prod-ytp.tcddtasimacilik.gov.tr/tms/gercek/yol" && ep.source === "yakalanan",
    ep
  );

  sandbox.chrome.storage.local.get = async () => ({ tcdd_headers_meta: { apiBase: "https://api.ornek" } });
  const ep2 = await D.resolveEndpoint("availability", "/tms/tahmini/yol");
  check("şablon yoksa yedek yol", ep2.url === "https://api.ornek/tms/tahmini/yol" && ep2.source === "varsayılan", ep2);

  console.log(failed ? `\n${failed} test BAŞARISIZ` : "\nTüm testler geçti");
  process.exit(failed ? 1 : 0);
})();
