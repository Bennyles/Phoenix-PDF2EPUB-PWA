const CACHE="phoenix-pdf2epub-v2.1.1";
const ASSETS=["./","index.html","style.css","manifest.webmanifest","app-v211.js","pdf.min.js","pdf.worker.min.js","jszip.min.js","tesseract.min.js","tesseract.worker.min.js","tesscore/tesseract-core.wasm.js","tesscore/tesseract-core-simd.wasm.js","tesscore/tesseract-core-lstm.wasm.js","tesscore/tesseract-core-simd-lstm.wasm.js","tessdata/eng.traineddata.gz","tessdata/ind.traineddata.gz","icon-192.png","icon-512.png"];
self.addEventListener("install",e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))).then(()=>self.clients.claim()));});
self.addEventListener("fetch",e=>{e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(resp=>{const cp=resp.clone();caches.open(CACHE).then(c=>c.put(e.request,cp));return resp;})));});
