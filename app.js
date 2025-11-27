import { V9_COORD } from "./v9_coord.js";
import { buildStep1Prompt, buildStep2Prompt, buildStep5SynthesisPrompt } from "./prompts.js";

const el = (id) => document.getElementById(id);
const logEl = el("log");
const outEl = el("out");
const statusEl = el("runStatus");
const runBtn = el("runBtn");
const downloadBtn = el("downloadBtn");
const modeEl = el("mode");
const openaiKeyEl = el("openaiKey");
const geminiKeyEl = el("geminiKey");
const keysRow = el("keysRow");
const rememberKeysEl = el("rememberKeys");
const rememberRow = el("rememberRow");

const LS_KEY = "iris_local_settings_v1";

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

async function callDirectOpenAI({model, system, user, imageDataUrl, apiKey, payloadOverride=null, returnRaw=false}){
  if(!apiKey) throw new Error("Въведи OpenAI API key за директен режим.");
  let payload = payloadOverride;
  if(!payload){
    const mime = guessMime(imageDataUrl);
    const b64 = dataUrlToBase64(imageDataUrl);
    if(!b64) throw new Error("Липсва изображение за заявката.");
    payload = {
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
  }

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type":"application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });
  if(!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${await r.text()}`);
  const json = await r.json();
  if(returnRaw) return json;
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

async function callDirectGemini({model, system, user, imageDataUrl, apiKey, payloadOverride=null, returnRaw=false}){
  if(!apiKey) throw new Error("Въведи Gemini API key за директен режим.");
  let payload = payloadOverride;
  if(!payload){
    const mime = guessMime(imageDataUrl);
    const b64 = dataUrlToBase64(imageDataUrl);
    if(!b64) throw new Error("Липсва изображение за заявката.");
    payload = {
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
  }

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  if(!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${await r.text()}`);
  const json = await r.json();
  if(returnRaw) return json;
  const text = json?.candidates?.[0]?.content?.parts?.map(p=>p.text).join("") ?? "";
  if(!text) throw new Error("Празен отговор от Gemini.");
  return safeJsonParse(text);
}

function currentSettings(){
  return {
    mode: modeEl.value,
    provider: el("provider").value,
    model: el("model").value.trim(),
    openaiKey: openaiKeyEl.value.trim(),
    geminiKey: geminiKeyEl.value.trim(),
    rememberKeys: rememberKeysEl.checked
  };
}

function loadSettings(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return;
    const s = JSON.parse(raw);
    if(s.mode) modeEl.value = s.mode;
    if(s.provider) el("provider").value = s.provider;
    if(s.model) el("model").value = s.model;
    rememberKeysEl.checked = Boolean(s.rememberKeys);
    if(s.rememberKeys){
      if(s.openaiKey) openaiKeyEl.value = s.openaiKey;
      if(s.geminiKey) geminiKeyEl.value = s.geminiKey;
    }
  } catch(e){
    console.warn("Неуспешно зареждане на настройки", e);
  }
}

function saveSettings(){
  const rememberKeys = rememberKeysEl.checked;
  const payload = {
    mode: modeEl.value,
    provider: el("provider").value,
    model: el("model").value,
    rememberKeys
  };
  if(rememberKeys){
    payload.openaiKey = openaiKeyEl.value.trim();
    payload.geminiKey = geminiKeyEl.value.trim();
  }
  localStorage.setItem(LS_KEY, JSON.stringify(payload));
}

async function lpCall({settings, system, user, imageDataUrl}){
  const { mode, provider, model, openaiKey, geminiKey } = settings;
  if(provider === "gemini"){
    return mode === "direct"
      ? callDirectGemini({model, system, user, imageDataUrl, apiKey: geminiKey})
      : callLocalGemini({model, system, user, imageDataUrl});
  }

  return mode === "direct"
    ? callDirectOpenAI({model, system, user, imageDataUrl, apiKey: openaiKey})
    : callLocalOpenAI({model, system, user, imageDataUrl});
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

async function runSide(side, file, settings){
  const { model } = settings;
  if(!model) throw new Error("Липсва модел.");

  const dataUrl = await fileToDataUrl(file);

  log(`${side}: Етап 1 (годност + оси)`, "info");
  const p1 = buildStep1Prompt({side});
  const r1 = await lpCall({settings, system: p1.system, user: p1.user, imageDataUrl: dataUrl});
  log(`${side}: Етап 1 OK (ok=${r1?.quality?.ok})`, "ok");

  const groups = ["LESIONS","RADIAL","RINGS","PIGMENT","COLLARETTE"];
  const dets = [];
  for(const g of groups){
    log(`${side}: Етап 2 (${g})`, "info");
    const p2 = buildStep2Prompt({side, group: g});
    const r2 = await lpCall({settings, system: p2.system, user: p2.user, imageDataUrl: dataUrl});
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

  const settings = currentSettings();
  if(settings.mode === "direct"){ 
    if(settings.provider === "openai" && !settings.openaiKey){
      setStatus("Добави OpenAI ключ за директен режим.", "warn");
      return;
    }
    if(settings.provider === "gemini" && !settings.geminiKey){
      setStatus("Добави Gemini ключ за директен режим.", "warn");
      return;
    }
  }

  runBtn.disabled = true;
  setStatus("Работи...", "");
  try{
    const R = await runSide("R", fileR, settings);
    const L = await runSide("L", fileL, settings);

    const { provider, model } = settings;
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

    const { mode, openaiKey, geminiKey } = settings;
    let raw = null;
    if(provider === "gemini"){
      if(mode === "direct"){
        raw = await callDirectGemini({ model, system: p5.system, user: p5.user, imageDataUrl: "", apiKey: geminiKey, payloadOverride: payload, returnRaw: true });
      } else {
        const r = await fetch("/api/gemini", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload)});
        if(!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        raw = await r.json();
      }

      const reportText = raw?.candidates?.[0]?.content?.parts?.map(p=>p.text).join("") ?? "";
      lastReport = safeJsonParse(reportText);
    } else {
      if(mode === "direct"){
        raw = await callDirectOpenAI({ model, system: p5.system, user: p5.user, imageDataUrl: "", apiKey: openaiKey, payloadOverride: payload, returnRaw: true });
      } else {
        const r = await fetch("/api/openai", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload)});
        if(!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        raw = await r.json();
      }

      const reportText = raw?.choices?.[0]?.message?.content ?? "";
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

function updateKeysVisibility(){
  const show = modeEl.value === "direct";
  keysRow.style.display = show ? "grid" : "none";
  rememberRow.style.display = show ? "block" : "none";
}

modeEl.addEventListener("change", ()=>{ updateKeysVisibility(); saveSettings(); });
el("provider").addEventListener("change", saveSettings);
el("model").addEventListener("input", saveSettings);
openaiKeyEl.addEventListener("input", saveSettings);
geminiKeyEl.addEventListener("input", saveSettings);
rememberKeysEl.addEventListener("change", saveSettings);

loadSettings();
updateKeysVisibility();
saveSettings();
