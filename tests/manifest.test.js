/**
 * tests/manifest.test.js
 * -----------------------------------------------------------------------------
 * manifest.json'un geçerliliğini ve içinde adı geçen tüm dosyaların gerçekten
 * var olduğunu doğrular.  Çalıştırma:  node tests/manifest.test.js
 * -----------------------------------------------------------------------------
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let failed = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name, extra === undefined ? "" : JSON.stringify(extra));
  if (!cond) failed++;
};

const m = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

check("manifest_version 3", m.manifest_version === 3);
check("service worker module", m.background && m.background.type === "module");

const needPerms = ["storage", "scripting", "activeTab", "notifications", "webRequest"];
needPerms.forEach((p) => check(`izin: ${p}`, m.permissions.includes(p)));
check("host_permissions tanımlı", (m.host_permissions || []).some((h) => h.includes("tcddtasimacilik")));

const files = [
  m.background.service_worker,
  m.action.default_popup,
  ...Object.values(m.icons || {}),
  ...(m.content_scripts || []).flatMap((c) => c.js || []),
  ...(m.web_accessible_resources || []).flatMap((w) => w.resources || [])
];

files.forEach((f) => check(`dosya var: ${f}`, fs.existsSync(path.join(ROOT, f))));

// popup.html içinde adı geçen yerel kaynaklar
const html = fs.readFileSync(path.join(ROOT, "popup.html"), "utf8");
[...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((x) => x[1])
  .filter((u) => !/^https?:/.test(u))
  .forEach((f) => check(`popup kaynağı var: ${f}`, fs.existsSync(path.join(ROOT, f))));

// Inline script/handler CSP'ye takılır
check("popup.html'de inline <script> yok", !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(html));
check("popup.html'de inline on* handler yok", !/\son[a-z]+\s*=\s*"/i.test(html));

console.log(failed ? `\n${failed} test BAŞARISIZ` : "\nTüm testler geçti");
process.exit(failed ? 1 : 0);
