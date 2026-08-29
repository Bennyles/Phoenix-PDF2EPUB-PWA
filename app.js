pdfjsLib.GlobalWorkerOptions.workerSrc = "pdf.worker.min.js";
let selectedFile=null, extractedText="", deferredPrompt=null;
const $=id=>document.getElementById(id);
const status=s=>$("status").textContent=s;
const progress=n=>$("progress").value=n;

window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferredPrompt=e;$("installBtn").hidden=false;});
$("installBtn").onclick=async()=>{if(!deferredPrompt)return;deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;$("installBtn").hidden=true;};

if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

$("pdfFile").addEventListener("change",e=>{
  selectedFile=e.target.files[0]||null; extractedText="";
  $("fileName").textContent=selectedFile?`${selectedFile.name} — ${(selectedFile.size/1048576).toFixed(1)} MB`:"Belum ada PDF dipilih.";
  if(selectedFile&&!$("title").value) $("title").value=selectedFile.name.replace(/\.pdf$/i,"").replace(/[_-]+/g," ");
  $("analyzeBtn").disabled=!selectedFile;$("convertBtn").disabled=true;progress(0);status("Siap dianalisis.");
});

function cleanText(lines){
  let out=[], buf="";
  for(let raw of lines){
    let s=(raw||"").replace(/\s+/g," ").trim();
    if(!s) continue;
    if(/^\d{1,4}$/.test(s)) continue;
    if(buf.endsWith("-") && /^[a-zà-ž]/i.test(s)){buf=buf.slice(0,-1)+s;continue;}
    const heading = s.length<90 && (s===s.toUpperCase() || /^(bab|chapter|bagian|part)\s+([ivxlcdm]+|\d+)/i.test(s));
    if(heading){
      if(buf){out.push(buf);buf="";}
      out.push("\n## "+s+"\n"); continue;
    }
    if(!buf) buf=s;
    else if(/[.!?:"”)]$/.test(buf) || s.length<35){out.push(buf);buf=s;}
    else buf+=" "+s;
  }
  if(buf) out.push(buf);
  return out.join("\n\n").replace(/\n{3,}/g,"\n\n");
}

async function extract(){
  if(!selectedFile) throw new Error("Pilih PDF dahulu.");
  status("Membaca PDF…");progress(2);
  const data=new Uint8Array(await selectedFile.arrayBuffer());
  const pdf=await pdfjsLib.getDocument({data}).promise;
  let all=[];
  for(let p=1;p<=pdf.numPages;p++){
    status(`Membaca halaman ${p}/${pdf.numPages}…`);
    const page=await pdf.getPage(p);
    const content=await page.getTextContent();
    const lines=content.items.map(x=>x.str);
    all.push(...lines,"\n");
    progress(Math.round(p/pdf.numPages*85));
  }
  const text=cleanText(all);
  if(text.replace(/\s/g,"").length<300) throw new Error("PDF ini tampaknya scan/image-only atau text layer terlalu sedikit. v2.0 belum OCR.");
  extractedText=text;
  $("preview").textContent=text.slice(0,5000)+(text.length>5000?"\n\n…":"");
  $("convertBtn").disabled=false; progress(100);status(`Analyze selesai — ${pdf.numPages} halaman.`);
  return text;
}

$("analyzeBtn").onclick=async()=>{try{await extract()}catch(e){status("ERROR: "+e.message);progress(0)}};

function esc(s){return s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function uuid(){return "urn:uuid:"+crypto.randomUUID();}
function contentHtml(text,title,lang){
  const chunks=text.split(/\n\n+/);
  let body="";
  for(const c of chunks){
    if(c.startsWith("## ")) body+=`<h2>${esc(c.slice(3))}</h2>`;
    else body+=`<p>${esc(c)}</p>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="${lang}" xml:lang="${lang}">
<head><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`;
}

async function makeEpub(){
  if(!extractedText) await extract();
  status("Membuat EPUB reflowable…");progress(10);
  const title=$("title").value.trim()||"Untitled";
  const author=$("author").value.trim()||"";
  const lang=$("lang").value;
  const id=uuid(), zip=new JSZip();
  zip.file("mimetype","application/epub+zip",{compression:"STORE"});
  zip.file("META-INF/container.xml",`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file("OEBPS/style.css","body{font-family:serif;line-height:1.45;margin:5%;}p{margin:.7em 0;text-indent:1.2em;}h1,h2{page-break-after:avoid;text-indent:0;}h2{margin-top:1.6em;}");
  zip.file("OEBPS/book.xhtml",contentHtml(extractedText,title,lang));
  zip.file("OEBPS/nav.xhtml",`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol><li><a href="book.xhtml">${esc(title)}</a></li></ol></nav></body></html>`);
  zip.file("OEBPS/content.opf",`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${id}</dc:identifier><dc:title>${esc(title)}</dc:title>
<dc:language>${lang}</dc:language><dc:creator>${esc(author)}</dc:creator>
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/,"Z")}</meta></metadata>
<manifest><item id="book" href="book.xhtml" media-type="application/xhtml+xml"/>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/></manifest>
<spine><itemref idref="book"/></spine></package>`);
  progress(70);
  const blob=await zip.generateAsync({type:"blob",mimeType:"application/epub+zip",compression:"DEFLATE",compressionOptions:{level:6}});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download=title.replace(/[\\/:*?"<>|]+/g,"_")+".epub"; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),5000);
  progress(100);status("EPUB selesai dan disimpan.");
}
$("convertBtn").onclick=async()=>{try{await makeEpub()}catch(e){status("ERROR: "+e.message);progress(0)}};

