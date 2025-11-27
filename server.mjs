import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

function loadEnv(){
  try{
    const txt = readFileSync(join(__dirname, ".env"), "utf8");
    for(const line of txt.split(/\r?\n/)){
      const t = line.trim();
      if(!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if(i === -1) continue;
      const k = t.slice(0,i).trim();
      const v = t.slice(i+1).trim();
      if(k && !(k in process.env)) process.env[k] = v;
    }
  }catch{}
}
loadEnv();

const PORT = Number(process.env.PORT || 5173);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const mimeMap = {
  ".html":"text/html; charset=utf-8",
  ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8",
  ".json":"application/json; charset=utf-8",
  ".png":"image/png",
  ".jpg":"image/jpeg",
  ".jpeg":"image/jpeg",
  ".svg":"image/svg+xml",
  ".ico":"image/x-icon"
};

function send(res, code, body, headers={}){
  res.writeHead(code, { "Content-Type":"text/plain; charset=utf-8", ...headers });
  res.end(body);
}

async function readBody(req){
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); } catch { throw new Error("Invalid JSON body"); }
}

function proxyHttpsJson({host, path, headers={}, bodyObj}){
  return new Promise((resolvePromise, rejectPromise)=>{
    const body = JSON.stringify(bodyObj ?? {});
    const req = https.request(
      { host, path, method: "POST", headers: { "Content-Type":"application/json", "Content-Length": Buffer.byteLength(body), ...headers } },
      (res)=>{
        const chunks=[];
        res.on("data",(d)=>chunks.push(d));
        res.on("end",()=>{
          const txt = Buffer.concat(chunks).toString("utf8");
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          if(!ok) return rejectPromise(new Error(`Upstream HTTP ${res.statusCode}: ${txt}`));
          try{ resolvePromise(JSON.parse(txt)); } catch { rejectPromise(new Error("Upstream non-JSON response")); }
        });
      }
    );
    req.on("error", rejectPromise);
    req.write(body);
    req.end();
  });
}

async function handleOpenAI(req, res){
  if(!OPENAI_API_KEY) return send(res, 500, "Missing OPENAI_API_KEY in .env");
  const body = await readBody(req);
  const json = await proxyHttpsJson({
    host: "api.openai.com",
    path: "/v1/chat/completions",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
    bodyObj: body
  });
  res.writeHead(200, {"Content-Type":"application/json; charset=utf-8"});
  res.end(JSON.stringify(json));
}

async function handleGemini(req, res){
  if(!GEMINI_API_KEY) return send(res, 500, "Missing GEMINI_API_KEY in .env");
  const body = await readBody(req);
  const model = body.model || "gemini-2.0-flash";
  const { model: _m, ...payload } = body;
  const path = `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const json = await proxyHttpsJson({
    host: "generativelanguage.googleapis.com",
    path,
    bodyObj: payload
  });
  res.writeHead(200, {"Content-Type":"application/json; charset=utf-8"});
  res.end(JSON.stringify(json));
}

async function serveStatic(req, res){
  let urlPath = (req.url || "/").split("?")[0];
  if(urlPath === "/") urlPath = "/index.html";

  const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const full = resolve(join(__dirname, safePath));
  if(!full.startsWith(__dirname)) return send(res, 403, "Forbidden");

  try{
    const st = await stat(full);
    if(st.isDirectory()) return send(res, 403, "Forbidden");
    const ext = extname(full).toLowerCase();
    const data = readFileSync(full);
    res.writeHead(200, {"Content-Type": mimeMap[ext] || "application/octet-stream"});
    res.end(data);
  }catch{
    send(res, 404, "Not Found");
  }
}

const server = http.createServer(async (req, res)=>{
  try{
    if(req.method === "POST" && req.url?.startsWith("/api/openai")) return await handleOpenAI(req, res);
    if(req.method === "POST" && req.url?.startsWith("/api/gemini")) return await handleGemini(req, res);
    if(req.method === "GET") return await serveStatic(req, res);
    send(res, 405, "Method Not Allowed");
  } catch(e){
    send(res, 500, "Server error: " + (e?.message || String(e)));
  }
});

server.listen(PORT, ()=> {
  console.log(`Iris local proxy running on http://localhost:${PORT}`);
});
