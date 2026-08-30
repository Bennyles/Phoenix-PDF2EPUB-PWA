const CACHE="phoenix-pdf2epub-v2.2.0";
const ASSETS=["./?v=220","index.html?v=220","style.css?v=220","app.js?v=220","manifest.webmanifest?v=220","pdf.min.js?v=220","pdf.worker.min.js?v=220","jszip.min.js?v=220","tesseract.min.js?v=220","worker.min.js?v=220","icon-192.png?v=220","icon-512.png?v=220"];
self.addEventListener("install",e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",e=>e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(resp=>{const cp=resp.clone();caches.open(CACHE).then(c=>c.put(e.request,cp));return resp;}))));
