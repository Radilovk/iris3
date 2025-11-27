import { V9_COORD } from "./v9_coord.js";
import { buildStep1Prompt, buildStep2Prompt, buildStep5SynthesisPrompt } from "./prompts.js";

const el = (id) => document.getElementById(id);
const logEl = el("log");
const outEl = el("out");
const statusEl = el("runStatus");
const runBtn = el("runBtn");
const downloadBtn = el("downloadBtn");

let lastReport = null;

function log(line, level="info"){
  const ts = new Date().toISOString().slice(11,19);
  const prefix = level === "err" ? "✖" : level === "ok" ? "✔" : level === "warn" ? "⚠" : "•";
  logEl.textContent += `[${ts}] ${prefix} ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}
function setStatus(text, cls=""){
  statusEl.textContent = text;
  statusEl.className = "status " + cls;
}
function safeJsonParse(str){
  try { return JSON.parse(str); } catch(e){}
  const m = str.match(/\{[\s\S]*\}/);
  if(!m) throw new Error("Не е намерен JSON в отговора.");
  return JSON.parse(m[0]);
}
async function fileToDataUrl(file){
  return new Promise((resolve,reject)=>{
    const fr = new FileReader();
    fr.onload = ()=> resolve(fr.result);
    fr.onerror = ()=> reject(new Error("Грешка при четене на файл."));
    fr.readAsDataURL(file);
  });
}
function dataUrlToBase64(dataUrl){
  const idx = dataUrl.indexOf("base64,");
  if(idx === -1) return null;
  return dataUrl.slice(idx + "base64,".length);
}
function guessMime(dataUrl){
  const m = /^data:(.*?);base64,/.exec(dataUrl);
  return m ? m[1] : "image/jpeg";
}

async function callLocalOpenAI({model, system, user, imageDataUrl}){
  const mime = guessMime(imageDataUrl);
  const b64 = dataUrlToBase64(imageDataUrl);
  const payload = {
    model,
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: user },
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }
        ]
      }
    ]
  };
  const r = await fetch("/api/openai", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) });
  if(!r.ok) throw new Error(`OpenAI proxy HTTP ${r.status}: ${await r.text()}`);
  const json = await r.json();
  const content = json?.choices?.[0]?.message?.content;
  if(!content) throw new Error("Празен отговор от OpenAI.");
  return safeJsonParse(content);
}

async function callLocalGemini({model, system, user, imageDataUrl}){
  const mime = guessMime(imageDataUrl);
  const b64 = dataUrlToBase64(imageDataUrl);
  const payload = {
    model,
    contents: [{
      role: "user",
      parts: [
        { text: system + "\n\n" + user },
        { inline_data: { mime_type: mime, data: b64 } }
      ]
    }],
    generationConfig: { temperature: 0, responseMimeType: "application/json" }
  };
  const r = await fetch("/api/gemini", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) });
  if(!r.ok) throw new Error(`Gemini proxy HTTP ${r.status}: ${await r.text()}`);
  const json = await r.json();
  const text = json?.candidates?.[0]?.content?.parts?.map(p=>p.text).join("") ?? "";
  if(!text) throw new Error("Празен отговор от Gemini.");
  return safeJsonParse(text);
}

async function lpCall({provider, model, system, user, imageDataUrl}){
  if(provider === "gemini") return callLocalGemini({model, system, user, imageDataUrl});
  return callLocalOpenAI({model, system, user, imageDataUrl});
}

function questionnaireText(){
  const age = Number(el("age").value || 0);
  const gender = el("gender").value;
  const complaints = el("complaints").value.trim();
  const habits = el("habits").value.trim();
  return `възраст=${age}; пол=${gender}; оплаквания=${complaints}; навици=${habits}`;
}

function compressCoordForPrompt(coord){
  const max = 14000;
  const s = JSON.stringify(coord);
  return s.length <= max ? s : s.slice(0, max) + "...";
}

async function runSide(side, file){
  const provider = el("provider").value;
  const model = el("model").value.trim();
  if(!model) throw new Error("Липсва модел.");

  const dataUrl = await fileToDataUrl(file);

  log(`${side}: Етап 1 (годност + оси)`, "info");
  const p1 = buildStep1Prompt({side});
  const r1 = await lpCall({provider, model, system: p1.system, user: p1.user, imageDataUrl: dataUrl});
  log(`${side}: Етап 1 OK (ok=${r1?.quality?.ok})`, "ok");

  const groups = ["LESIONS","RADIAL","RINGS","PIGMENT","COLLARETTE"];
  const dets = [];
  for(const g of groups){
    log(`${side}: Етап 2 (${g})`, "info");
    const p2 = buildStep2Prompt({side, group: g});
    const r2 = await lpCall({provider, model, system: p2.system, user: p2.user, imageDataUrl: dataUrl});
    dets.push(r2);
    log(`${side}: Етап 2 ${g} OK (findings=${(r2?.findings||[]).length})`, "ok");
  }

  return { side, step1: r1, step2: dets };
}

async function runAll(){
  logEl.textContent = "";
  outEl.textContent = "";
  lastReport = null;
  downloadBtn.disabled = true;

  const fileR = el("imgR").files?.[0] || null;
  const fileL = el("imgL").files?.[0] || null;
  if(!fileR || !fileL){
    setStatus("Качи и двата ириса (R и L).", "warn");
    return;
  }

  runBtn.disabled = true;
  setStatus("Работи...", "");
  try{
    const R = await runSide("R", fileR);
    const L = await runSide("L", fileL);

    const provider = el("provider").value;
    const model = el("model").value.trim();
    const q = questionnaireText();
    const coordSmall = compressCoordForPrompt(V9_COORD);

    const detMerged = {
      frames: { R: R.step1, L: L.step1 },
      R: R.step2,
      L: L.step2
    };

    const p5 = buildStep5SynthesisPrompt({
      coordJSON: coordSmall,
      questionnaire: q,
      detections: JSON.stringify(detMerged)
    });

    log(`Етап 5 (синтез + доклад)`, "info");

    const endpoint = provider === "gemini" ? "/api/gemini" : "/api/openai";
    const payload = provider === "gemini"
      ? {
          model,
          contents: [{ role:"user", parts:[{text: p5.system + "\n\n" + p5.user}] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" }
        }
      : {
          model,
          response_format: { type: "json_object" },
          temperature: 0,
          messages: [
            { role:"system", content: p5.system },
            { role:"user", content: p5.user }
          ]
        };

    const r = await fetch(endpoint, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload)});
    if(!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const raw = await r.json();

    let reportText = "";
    if(provider === "gemini"){
      reportText = raw?.candidates?.[0]?.content?.parts?.map(p=>p.text).join("") ?? "";
      lastReport = safeJsonParse(reportText);
    } else {
      reportText = raw?.choices?.[0]?.message?.content ?? "";
      lastReport = safeJsonParse(reportText);
    }

    outEl.textContent = JSON.stringify(lastReport, null, 2);
    downloadBtn.disabled = false;
    setStatus("Готово.", "ok");
    log("Готово.", "ok");
  } catch(e){
    console.error(e);
    setStatus("Грешка: " + (e?.message || String(e)), "bad");
    log("Грешка: " + (e?.message || String(e)), "err");
  } finally{
    runBtn.disabled = false;
  }
}

function downloadJson(){
  if(!lastReport) return;
  const blob = new Blob([JSON.stringify(lastReport, null, 2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "iris_report.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

runBtn.addEventListener("click", runAll);
downloadBtn.addEventListener("click", downloadJson);
