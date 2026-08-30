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
      await Promise.all(keys.filter(k=>k.startsWith("phoenix-pdf2epub-")&&k!=="phoenix-pdf2epub-v2.2.0").map(k=>caches.delete(k)));
      const reg=await navigator.serviceWorker.register("sw.js?v=220",{updateViaCache:"none"});
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

async function ocrPage(page,pageno,total){
  if(!window.Tesseract) throw new Error("Mesin OCR gagal dimuat. Pastikan internet aktif lalu reload aplikasi.");
  status(`OCR halaman ${pageno}/${total}…`);
  const viewport=page.getViewport({scale:1.65});
  const canvas=document.createElement("canvas");
  const ctx=canvas.getContext("2d",{alpha:false});
  canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height);
  await page.render({canvasContext:ctx,viewport}).promise;
  const result=await Tesseract.recognize(canvas,ocrLang(),{
    logger:m=>{
      if(m.status==="recognizing text" && typeof m.progress==="number"){
        const base=(pageno-1)/total*88;
        progress(Math.round(base+(m.progress*(88/total))));
      }
    },
    workerPath:"worker.min.js"
  });
  canvas.width=1;canvas.height=1;
  return (result&&result.data&&result.data.text)||"";
}

async function extract(){
  if(!selectedFile) throw new Error("Pilih PDF dahulu.");
  status("Membaca PDF…");progress(2);
  const data=new Uint8Array(await selectedFile.arrayBuffer());
  const pdf=await pdfjsLib.getDocument({data}).promise;
  let pages=[],ocrCount=0,digitalCount=0;
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p);
    status(`Analisa halaman ${p}/${pdf.numPages}…`);
    const content=await page.getTextContent();
    const raw=content.items.map(x=>x.str).join(" ").replace(/\s+/g," ").trim();
    let pageText=raw;
    // PDF campuran: text layer yang sangat tipis biasanya hanya nomor halaman/watermark.
    if(usefulChars(raw)<80){
      pageText=await ocrPage(page,p,pdf.numPages);ocrCount++;
    }else{
      digitalCount++;
    }
    pages.push(pageText,"\n");
    progress(Math.max($("progress").value,Math.round(p/pdf.numPages*88)));
  }
  const text=cleanText(pages);
  if(usefulChars(text)<80) throw new Error("Teks tidak cukup terbaca. Coba PDF lain atau pastikan halaman scan cukup jelas.");
  extractedText=text;
  $("preview").textContent=text.slice(0,5000)+(text.length>5000?"\n\n…":"");
  $("convertBtn").disabled=false;progress(100);
  status(`Analyze selesai — ${pdf.numPages} halaman; digital ${digitalCount}, OCR ${ocrCount}.`);
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
