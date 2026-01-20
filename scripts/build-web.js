/**
 * Build estático para Appflow/Capacitor:
 * copia os arquivos do site para ./www
 */
const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const OUT = path.join(ROOT, "www");

// ajuste aqui se você tiver outros arquivos
const INCLUDE = [
  "index.html",
  "app.js",
  "styles.css",
  "manifest.json",
  "service-worker.js",
  "news.json",
  "rss.xml",
  "feed.xml",
  "privacy.html",
  "evknews.png",
  "evknews.svg",
  "icon-192.png",
  "icon-512.png",
  "mitoc.png",
  "bird.jpg",
  "prone.jpeg",
  "sgs.jpeg",
  "valid-rss-rogers.png",
  "consent.js"
];

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

let copied = 0;
for (const f of INCLUDE) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src) && fs.statSync(src).isFile()) {
    copyFile(src, path.join(OUT, f));
    copied++;
  }
}

if (copied === 0) {
  console.error("Nada copiado. Verifique nomes/arquivos na raiz do projeto.");
  process.exit(1);
}

console.log(`Build OK: ${copied} arquivos em ./www`);
