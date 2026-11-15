/* طبقة الاتصال بـ Google Drive للتطبيق المستقل.
   توفر نفس الواجهة التي يستخدمها التطبيق: claude.use("db" | "mcp" | "downloads" | "user"). */
(function () {
  const CFG = window.APP_CONFIG || {};
  const ROOT = CFG.rootFolderId;
  const DATA_NAME = "kadr-data.json";
  const INBOX_PREFIX = "تحديثات Claude";
  const API = "https://www.googleapis.com/drive/v3";
  const UP = "https://www.googleapis.com/upload/drive/v3";
  const FOLDER = "application/vnd.google-apps.folder";
  const CONVERT = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "application/vnd.google-apps.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "application/vnd.google-apps.spreadsheet",
  };

  /* ---------- المصادقة ---------- */
  const AUTH_KEY = "kadr-auth";
  let token = null, tokenExp = 0, tokenClient = null, pendingAuth = null, email = "";
  try { const a = JSON.parse(localStorage.getItem(AUTH_KEY) || "{}"); email = a.email || ""; if (a.token && a.exp > Date.now()) { token = a.token; tokenExp = a.exp; } } catch (e) {}
  function saveAuth() { try { localStorage.setItem(AUTH_KEY, JSON.stringify({ token, exp: tokenExp, email })); } catch (e) {} }
  function initClient() {
    if (tokenClient) return tokenClient;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.clientId,
      scope: "https://www.googleapis.com/auth/drive",
      callback: (r) => {
        const p = pendingAuth; pendingAuth = null;
        if (r && r.access_token) { token = r.access_token; tokenExp = Date.now() + (Number(r.expires_in) || 3500) * 1000 - 60000; saveAuth(); p && p.res(token); }
        else p && p.rej(r);
      },
      error_callback: (e) => { const p = pendingAuth; pendingAuth = null; p && p.rej(e); },
    });
    return tokenClient;
  }
  function requestToken(prompt) {
    return new Promise((res, rej) => { pendingAuth = { res, rej }; const o = { prompt }; if (email && !/select_account/.test(prompt)) o.hint = email; initClient().requestAccessToken(o); });
  }
  async function getToken() {
    if (token && Date.now() < tokenExp) return token;
    try { return await requestToken(""); } catch (e) { return requestToken("consent"); }
  }

  async function gfetch(url, opts = {}, retry = true) {
    const t = await getToken();
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + t } });
    if (r.status === 401 && retry) { token = null; return gfetch(url, opts, false); }
    if (!r.ok) { const txt = await r.text().catch(() => ""); throw { code: "tool_error", message: `Drive ${r.status}: ${txt.slice(0, 300)}` }; }
    return r;
  }

  function b64ToBlob(b64, type) { const bin = atob(String(b64).replace(/\s/g, "")); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); }
  async function blobToB64(blob) {
    const u = new Uint8Array(await blob.arrayBuffer()); let s = "";
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function multipart(meta, blob, method = "POST", id = "") {
    const fd = new FormData();
    fd.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
    fd.append("file", blob);
    const url = id ? `${UP}/files/${id}?uploadType=multipart&fields=id,name,modifiedTime` : `${UP}/files?uploadType=multipart&fields=id,name,modifiedTime`;
    return (await gfetch(url, { method, body: fd })).json();
  }

  /* ---------- أدوات الدرايف (بنفس أسماء أداة Claude) ---------- */
  const tools = {
    async create_file(i) {
      const meta = { name: i.title };
      if (i.parentId) meta.parents = [i.parentId];
      const content = i.base64Content;
      if (!content) {
        meta.mimeType = i.contentMimeType || FOLDER;
        const r = await (await gfetch(`${API}/files?fields=id,name`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(meta) })).json();
        return { id: r.id, title: r.name };
      }
      const type = i.contentMimeType || "application/octet-stream";
      const blob = content && content.$file ? new Blob([content.$file.data], { type }) : b64ToBlob(content, type);
      if (!i.disableConversionToGoogleType && CONVERT[type]) meta.mimeType = CONVERT[type];
      const r = await multipart(meta, blob);
      return { id: r.id, title: r.name };
    },
    async trash_file(i) { await gfetch(`${API}/files/${i.fileId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) }); return {}; },
    async download_file_content(i) {
      let url = i.exportMimeType ? `${API}/files/${i.fileId}/export?mimeType=${encodeURIComponent(i.exportMimeType)}` : `${API}/files/${i.fileId}?alt=media`;
      if (i.sheetPdf) {
        const o = i.sheetPdf;
        url = `https://docs.google.com/spreadsheets/d/${i.fileId}/export?format=pdf&size=A4&portrait=${o.portrait ? "true" : "false"}&scale=${o.scale || 4}&gridlines=false&printtitle=false&sheetnames=false&pagenum=UNDEFINED&fzr=false&horizontal_alignment=CENTER&vertical_alignment=TOP&top_margin=0.4&bottom_margin=0.4&left_margin=0.3&right_margin=0.3` + (o.range ? (o.range.length === 4 ? `&r1=${o.range[0]}&c1=${o.range[1]}&r2=${o.range[2]}&c2=${o.range[3]}` : `&r1=0&c1=0&r2=${o.range[0]}&c2=${o.range[1]}`) : "");
      }
      const blob = await (await gfetch(url)).blob();
      return { __raw: true, content: [{ type: "resource", resource: { blob: await blobToB64(blob) } }] };
    },
    async update_file(i) {
      const body = {}; let q = "";
      if (i.title) body.name = i.title;
      if (typeof i.readOnly === "boolean") body.contentRestrictions = [i.readOnly ? { readOnly: true, reason: i.readOnlyReason || "" } : { readOnly: false }];
      if (i.parentId) {
        const cur = await (await gfetch(`${API}/files/${i.fileId}?fields=parents`)).json();
        q = `&addParents=${i.parentId}&removeParents=${(cur.parents || []).join(",")}`;
      }
      const r = await (await gfetch(`${API}/files/${i.fileId}?fields=id,name${q}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
      return { id: r.id, title: r.name };
    },
    async copy_file(i) {
      const body = {}; if (i.title) body.name = i.title; if (i.parentId) body.parents = [i.parentId];
      const r = await (await gfetch(`${API}/files/${i.fileId}/copy?fields=id,name`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
      return { id: r.id, title: r.name };
    },
  };
  const mcp = {
    async callTool(server, tool, input) {
      if (!tools[tool]) throw { code: "bad_request", message: "أداة غير معروفة: " + tool };
      const r = await tools[tool](input || {});
      return r && r.__raw ? r : { payload: r, content: [{ type: "text", text: JSON.stringify(r) }] };
    },
    async listTools() { return { servers: [{ server: "Google Drive", tools: Object.keys(tools).map((name) => ({ name })) }], fileArgs: true }; },
  };

  /* ---------- مخزن البيانات (ملف JSON على الدرايف) ---------- */
  let store = { docs: {} }, dataFileId = null, saveTimer = null, saving = Promise.resolve();
  const docL = new Map(), colL = new Map();
  const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  const segs = (p) => p.split("/");
  const isObj = (o) => o && typeof o === "object" && !Array.isArray(o);
  function deepMerge(t, s) { const o = { ...(t || {}) }; for (const k of Object.keys(s)) o[k] = isObj(s[k]) && isObj(o[k]) ? deepMerge(o[k], s[k]) : clone(s[k]); return o; }
  const snapDoc = (path) => { const d = store.docs[path]; const id = segs(path).pop(); return { id, exists: d !== undefined, data: () => clone(d), metadata: { fromCache: false, hasPendingWrites: false } }; };
  function snapCol(col) {
    const n = segs(col).length + 1;
    const docs = Object.keys(store.docs).filter((p) => p.startsWith(col + "/") && segs(p).length === n).sort().map(snapDoc);
    return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false }, docChanges: () => [] };
  }
  function notify(path) {
    queueMicrotask(() => {
      (docL.get(path) || []).forEach((f) => f(snapDoc(path)));
      const col = segs(path).slice(0, -1).join("/");
      (colL.get(col) || []).forEach((f) => f(snapCol(col)));
    });
  }
  function notifyAll() { queueMicrotask(() => { docL.forEach((fs, p) => fs.forEach((f) => f(snapDoc(p)))); colL.forEach((fs, c) => fs.forEach((f) => f(snapCol(c)))); }); }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saving = saving.then(saveNow).catch((e) => console.error("save failed", e)); }, 500);
  }
  async function saveNow() {
    const blob = new Blob([JSON.stringify(store)], { type: "application/json" });
    setStatus("جارٍ الحفظ…");
    if (dataFileId) await multipart({}, blob, "PATCH", dataFileId);
    else { const r = await multipart({ name: DATA_NAME, parents: [ROOT], mimeType: "application/json" }, blob); dataFileId = r.id; }
    setStatus("");
  }
  async function flush() { clearTimeout(saveTimer); saving = saving.then(saveNow); return saving; }
  window.addEventListener("beforeunload", (e) => { if (saveTimer) { e.preventDefault(); e.returnValue = ""; } });

  function write(path, fn) { store.docs[path] = fn(store.docs[path]); if (store.docs[path] === undefined) delete store.docs[path]; notify(path); scheduleSave(); }
  function docRef(path) {
    return {
      id: segs(path).pop(), path,
      get: async () => snapDoc(path),
      set: async (data) => write(path, () => clone(data)),
      update: async (data) => { if (store.docs[path] === undefined) throw { code: "invalid_argument", message: "المستند غير موجود" }; write(path, (cur) => deepMerge(cur, data)); },
      delete: async () => write(path, () => undefined),
      onSnapshot: (next) => { const a = docL.get(path) || []; a.push(next); docL.set(path, a); queueMicrotask(() => next(snapDoc(path))); return () => docL.set(path, (docL.get(path) || []).filter((f) => f !== next)); },
      collection: (sub) => colRef(path + "/" + sub),
    };
  }
  function colRef(path) {
    return {
      path,
      doc: (id) => docRef(path + "/" + (id || Math.random().toString(36).slice(2, 12))),
      get: async () => snapCol(path),
      onSnapshot: (next) => { const a = colL.get(path) || []; a.push(next); colL.set(path, a); queueMicrotask(() => next(snapCol(path))); return () => colL.set(path, (colL.get(path) || []).filter((f) => f !== next)); },
    };
  }
  const db = { doc: docRef, collection: colRef, flush };

  async function findFiles(q) {
    const r = await (await gfetch(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=50`)).json();
    return r.files || [];
  }
  async function loadData() {
    const f = await findFiles(`'${ROOT}' in parents and name = '${DATA_NAME}' and trashed = false`);
    if (f.length) { dataFileId = f[0].id; store = await (await gfetch(`${API}/files/${dataFileId}?alt=media`)).json(); if (!store.docs) store = { docs: {} }; }
    await applyInbox();
  }
  async function applyInbox() {
    const files = await findFiles(`'${ROOT}' in parents and name contains '${INBOX_PREFIX}' and trashed = false`);
    if (!files.length) return 0;
    let n = 0;
    for (const file of files.reverse()) {
      try {
        const ops = await (await gfetch(`${API}/files/${file.id}?alt=media`)).json();
        for (const o of (Array.isArray(ops) ? ops : ops.ops || [])) {
          if (o.op === "set") store.docs[o.path] = clone(o.data);
          else if (o.op === "merge" || o.op === "update") store.docs[o.path] = deepMerge(store.docs[o.path], o.data || {});
          else if (o.op === "delete") delete store.docs[o.path];
          n++;
        }
        await tools.trash_file({ fileId: file.id });
      } catch (e) { console.error("inbox", e); }
    }
    if (n) { notifyAll(); await saveNow(); }
    return n;
  }
  window.addEventListener("focus", () => { if (token) applyInbox().then((n) => n && setStatus(`تم دمج ${n} تحديث من Claude`, 4000)).catch(() => {}); });

  /* ---------- التنزيل ---------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      return { status: "saved" };
    },
  };

  /* ---------- الحالة وشاشة الاتصال ---------- */
  let statusTimer;
  function setStatus(t, ms) { const el = document.getElementById("syncStatus"); if (!el) return; el.textContent = t; clearTimeout(statusTimer); if (ms) statusTimer = setTimeout(() => (el.textContent = ""), ms); }

  let readyResolve; const ready = new Promise((r) => (readyResolve = r));
  async function fetchEmail() {
    try { const r = await (await gfetch(`${API}/about?fields=user(emailAddress)`)).json(); email = (r.user && r.user.emailAddress) || email; saveAuth(); } catch (e) {}
    const el = document.getElementById("acctEmail"); if (el) el.textContent = email;
  }
  async function start(g) { await loadData(); if (g) g.remove(); readyResolve(true); fetchEmail(); }
  function showGate() {
    const g = document.createElement("div"); g.id = "gate";
    g.innerHTML = `<div class="gate-card"><h2>التوثيقات المالية</h2><p>${email ? "انتهت جلسة الدرايف. اضغط للمتابعة بحساب " + email + "." : "اضغط للاتصال بـ Google Drive. يطلب Google موافقتك في أول مرة فقط."}</p><button type="button" id="gateBtn">${email ? "متابعة" : "الاتصال بالدرايف"}</button><p id="gateMsg" class="msg"></p></div>`;
    document.body.appendChild(g);
    document.getElementById("gateBtn").onclick = async () => {
      const m = document.getElementById("gateMsg"); m.textContent = "جارٍ الاتصال…";
      try { await requestToken(email ? "" : "consent"); m.textContent = "جارٍ تحميل البيانات…"; await start(g); }
      catch (e) { m.textContent = "تعذّر الاتصال: " + (e && (e.message || e.type || e.error) || e); }
    };
  }
  window.addEventListener("load", async () => {
    if (!CFG.clientId || !window.google) { document.body.insertAdjacentHTML("afterbegin", '<div class="notice err">إعدادات الاتصال ناقصة (Client ID).</div>'); return; }
    if (token && Date.now() < tokenExp) { try { await start(null); return; } catch (e) { token = null; } }
    showGate();
  });
  window.appAuth = {
    email: () => email,
    async switchAccount() { if (window.appStore) await flush().catch(() => {}); try { localStorage.removeItem(AUTH_KEY); } catch (e) {} token = null; email = "";
      await requestToken("select_account consent"); await fetchEmail(); location.reload(); },
  };

  window.claude = {
    async use(name) {
      await ready;
      if (name === "db") return db;
      if (name === "mcp") return mcp;
      if (name === "downloads") return downloads;
      return null;
    },
  };
  window.appStore = { flush, applyInbox };
})();
