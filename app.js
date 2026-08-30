pdfjsLib.GlobalWorkerOptions.workerSrc = "pdf.worker.min.js";
let selectedFile=null, extractedText="", deferredPrompt=null;
const $=id=>document.getElementById(id);
const status=s=>$("status").textContent=s;
const progress=n=>$("progress").value=Math.max(0,Math.min(100,n));

window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferredPrompt=e;$("installBtn").hidden=false;});
$("installBtn").onclick=async()=>{if(!deferredPrompt)return;deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;$("installBtn").hidden=true;};
if("serviceWorker" in navigator){
  (async()=>{
    try{
      const keys=await caches.keys();
      await Promise.all(keys.filter(k=>k.startsWith("phoenix-pdf2epub-")&&k!=="phoenix-pdf2epub-v2.3.2").map(k=>caches.delete(k)));
      const reg=await navigator.serviceWorker.register("sw.js?v=232",{updateViaCache:"none"});
      await reg.update();
    }catch(e){console.warn("SW update",e);}
  })();
}

$("pdfFile").addEventListener("change",e=>{
  selectedFile=e.target.files[0]||null; extractedText="";
  $("fileName").textContent=selectedFile?`${selectedFile.name} — ${(selectedFile.size/1048576).toFixed(1)} MB`:"Belum ada PDF dipilih.";
  if(selectedFile) $("title").value=selectedFile.name.replace(/\.pdf$/i,"").replace(/[_-]+/g," ").replace(/\s+/g," ").trim();
  $("analyzeBtn").disabled=!selectedFile;$("convertBtn").disabled=true;progress(0);status("Siap dianalisis.");
});

function cleanText(lines){
  let out=[],buf="";
  for(let raw of lines){
    let s=(raw||"").replace(/\s+/g," ").trim();
    if(!s) continue;
    if(/^\d{1,4}$/.test(s)) continue;
    if(buf.endsWith("-") && /^[a-zà-ž]/i.test(s)){buf=buf.slice(0,-1)+s;continue;}
    const heading=s.length<90 && (s===s.toUpperCase() || /^(bab|chapter|bagian|part)\s+([ivxlcdm]+|\d+)/i.test(s));
    if(heading){if(buf){out.push(buf);buf="";}out.push("\n## "+s+"\n");continue;}
    if(!buf) buf=s;
    else if(/[.!?:"”)]$/.test(buf) || s.length<35){out.push(buf);buf=s;}
    else buf+=" "+s;
  }
  if(buf) out.push(buf);
  return out.join("\n\n").replace(/\n{3,}/g,"\n\n");
}

function usefulChars(s){return (s||"").replace(/\s/g,"").length;}
function ocrLang(){return $("lang").value==="id"?"ind+eng":"eng";}

async function ocrPageWithWorker(worker,page){
  const viewport=page.getViewport({scale:1.05});
  const canvas=document.createElement("canvas");
  const ctx=canvas.getContext("2d",{alpha:false});
  canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height);
  try{
    await page.render({canvasContext:ctx,viewport,background:"white"}).promise;
    const result=await worker.recognize(canvas);
    return (result&&result.data&&result.data.text)||"";
  }finally{canvas.width=1;canvas.height=1;}
}

const PHX_DB="phoenix-pdf2epub-v232"; // sengaja sama: checkpoint v2.3.2 dipakai ulang
function cpOpen(){
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open(PHX_DB,1);
    r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains("pages"))db.createObjectStore("pages");};
    r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
  });
}
async function cpGet(k){
  try{const db=await cpOpen();return await new Promise((res,rej)=>{const r=db.transaction("pages","readonly").objectStore("pages").get(k);r.onsuccess=()=>res(r.result||"");r.onerror=()=>rej(r.error);});}catch(e){return "";}
}
async function cpPut(k,v){
  try{const db=await cpOpen();await new Promise((res,rej)=>{const r=db.transaction("pages","readwrite").objectStore("pages").put(v,k);r.onsuccess=()=>res();r.onerror=()=>rej(r.error);});}catch(e){}
}
async function makeOCRWorker(){
  if(!window.Tesseract) throw new Error("Mesin OCR gagal dimuat. Reload aplikasi lalu coba lagi.");
  return await Tesseract.createWorker(ocrLang(),1,{workerPath:"./worker.min.js"});
}
async function extract(){
  if(!selectedFile) throw new Error("Pilih PDF dahulu.");
  status("Membaca PDF…"); progress(2);
  const data=new Uint8Array(await selectedFile.arrayBuffer());
  const pdf=await pdfjsLib.getDocument({data}).promise;
  const total=pdf.numPages;
  const pages=new Array(total).fill("");
  const needOCR=[];
  let digitalCount=0,resumed=0,ocrDone=0;
  const baseKey=[selectedFile.name,selectedFile.size,selectedFile.lastModified,$("lang").value].join("|");

  for(let pageno=1;pageno<=total;pageno++){
    status(`Deteksi teks ${pageno}/${total}…`);
    progress(Math.round((pageno/total)*15));
    const page=await pdf.getPage(pageno);
    try{
      const content=await page.getTextContent();
      const raw=content.items.map(x=>x.str).join(" ").replace(/\s+/g," ").trim();
      if(usefulChars(raw)>=80){pages[pageno-1]=raw;digitalCount++;}
      else needOCR.push(pageno);
    }finally{try{page.cleanup();}catch(e){}}
  }

  const pending=[];
  for(const pageno of needOCR){
    const saved=await cpGet(baseKey+"|p"+pageno);
    if(usefulChars(saved)>=20){pages[pageno-1]=saved;resumed++;}
    else pending.push(pageno);
  }

  if(pending.length){
    const hc=navigator.hardwareConcurrency||4;
    const dm=navigator.deviceMemory||4;
    const workerCount=(hc>=8 && dm>=6 && pending.length>=30)?3:2;
    status(`Menyiapkan ${workerCount} OCR worker permanen…`);
    const workers=await Promise.all(Array.from({length:workerCount},()=>makeOCRWorker()));
    let next=0;
    const started=Date.now();
    try{
      await Promise.all(workers.map(async worker=>{
        while(true){
          const idx=next++;
          if(idx>=pending.length) return;
          const pageno=pending[idx];
          const page=await pdf.getPage(pageno);
          try{
            const txt=await ocrPageWithWorker(worker,page);
            pages[pageno-1]=txt;
            await cpPut(baseKey+"|p"+pageno,txt);
            ocrDone++;
            const done=resumed+ocrDone;
            const elapsed=Math.max(1,(Date.now()-started)/1000);
            const rate=ocrDone/elapsed;
            const left=Math.max(0,pending.length-ocrDone);
            const eta=rate>0?Math.ceil(left/rate):0;
            progress(15+Math.round((done/Math.max(1,needOCR.length))*75));
            status(`FAST OCR ${done}/${needOCR.length} — ${workerCount} worker tetap — ETA ~${Math.ceil(eta/60)} menit`);
          }finally{try{page.cleanup();}catch(e){}}
        }
      }));
    }finally{
      await Promise.all(workers.map(w=>w.terminate().catch(()=>{})));
    }
  }

  const text=cleanText(pages.flatMap(x=>[x,"\n"]));
  if(usefulChars(text)<80) throw new Error("Teks tidak cukup terbaca.");
  extractedText=text;
  $("preview").textContent=text.slice(0,5000)+(text.length>5000?"\n\n…":"");
  $("convertBtn").disabled=false; progress(100);
  status(`Analyze selesai — ${total} halaman; digital ${digitalCount}, OCR baru ${ocrDone}, resume ${resumed}.`);
  return text;
}
$("analyzeBtn").onclick=async()=>{try{$("analyzeBtn").disabled=true;await extract()}catch(e){status("ERROR: "+e.message);progress(0)}finally{$("analyzeBtn").disabled=!selectedFile;}};

function esc(s){return String(s||"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function uuid(){return "urn:uuid:"+(crypto.randomUUID?crypto.randomUUID():Date.now()+"-"+Math.random().toString(16).slice(2));}
function contentHtml(text,title,lang){
  const chunks=text.split(/\n\n+/);let body="";
  for(const c of chunks){if(c.startsWith("## ")) body+=`<h2>${esc(c.slice(3))}</h2>`;else body+=`<p>${esc(c)}</p>`;}
  return `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" lang="${lang}" xml:lang="${lang}"><head><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

async function makeEpub(){
  if(!extractedText) await extract();
  status("Membuat EPUB reflowable…");progress(10);
  const title=$("title").value.trim()||"Untitled",author=$("author").value.trim()||"",lang=$("lang").value,id=uuid(),zip=new JSZip();
  zip.file("mimetype","application/epub+zip",{compression:"STORE"});
  zip.file("META-INF/container.xml",`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file("OEBPS/style.css","body{font-family:serif;line-height:1.45;margin:5%;}p{margin:.7em 0;text-indent:1.2em;}h1,h2{page-break-after:avoid;text-indent:0;}h2{margin-top:1.6em;}");
  zip.file("OEBPS/book.xhtml",contentHtml(extractedText,title,lang));
  zip.file("OEBPS/nav.xhtml",`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol><li><a href="book.xhtml">${esc(title)}</a></li></ol></nav></body></html>`);
  zip.file("OEBPS/content.opf",`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">${id}</dc:identifier><dc:title>${esc(title)}</dc:title><dc:language>${lang}</dc:language><dc:creator>${esc(author)}</dc:creator><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/,"Z")}</meta></metadata><manifest><item id="book" href="book.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/></manifest><spine><itemref idref="book"/></spine></package>`);
  progress(70);
  const blob=await zip.generateAsync({type:"blob",mimeType:"application/epub+zip",compression:"DEFLATE",compressionOptions:{level:6}});
  const href=URL.createObjectURL(blob),a=document.createElement("a");a.href=href;a.download=title.replace(/[\\/:*?"<>|]+/g,"_")+".epub";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),5000);
  progress(100);status("EPUB selesai dan download dimulai.");
}
$("convertBtn").onclick=async()=>{try{$("convertBtn").disabled=true;await makeEpub()}catch(e){status("ERROR: "+e.message);progress(0)}finally{$("convertBtn").disabled=!extractedText;}};
