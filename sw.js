const CACHE="phoenix-pdf2epub-v2.3.2";
const ASSETS=["./?v=232","index.html?v=232","style.css?v=232","app.js?v=232","manifest.webmanifest?v=232","pdf.min.js?v=232","pdf.worker.min.js?v=232","jszip.min.js?v=232","tesseract.min.js?v=232","worker.min.js?v=232","icon-192.png?v=232","icon-512.png?v=232"];
self.addEventListener("install",e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",e=>e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(resp=>{const cp=resp.clone();caches.open(CACHE).then(c=>c.put(e.request,cp));return resp;}))));
