/* =====================================================================
   studio-auth.js  —  Login + encrypted API client + paste-to-upload
   Pairs with: norelease/blog-api/src/worker.js
   Codes: 9981 = success, 88712 = fail
   Transport: RSA-OAEP-256 wrap + AES-256-GCM per request.
   ===================================================================== */

(function () {
  const OK  = 9981;
  const ERR = 88712;

  const API_BASE = "https://blog-api.contentltd.xyz";

  const TOKEN_KEY = "clt_studio_jwt";
  const EXP_KEY   = "clt_studio_jwt_exp";

  const te = new TextEncoder();
  const td = new TextDecoder();

  /* ============ input sanitization ============ */
  function sanitizeStr(s, maxLen) {
    if (typeof s !== "string") return "";
    return s
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
      .replace(/\x00/g, "")
      .trim()
      .slice(0, maxLen || 256);
  }

  /* ============ base64url ============ */
  function b64uEnc(bytes) {
    const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = ""; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  }
  function b64uDec(str) {
    str = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    const bin = atob(str); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ============ JWT store (encrypted at rest) ============
     The JWT never sits in sessionStorage as plaintext.
     A non-extractable AES-GCM CryptoKey is stored in IndexedDB, and
     only {iv, ct} ciphertext is written to sessionStorage. Even if an
     attacker reads sessionStorage, the bytes are useless without the
     IDB key handle, which cannot be exfiltrated in raw form. */
  const IDB_NAME = "clt_studio_auth";
  const IDB_STORE = "keys";
  const IDB_KEY_ID = "jwt-wrap-v1";

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const r = tx.objectStore(IDB_STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function idbPut(key, val) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbDel(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function getWrapKey() {
    let k = await idbGet(IDB_KEY_ID);
    if (k) return k;
    k = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false, // non-extractable
      ["encrypt", "decrypt"]
    );
    await idbPut(IDB_KEY_ID, k);
    return k;
  }

  const authStore = {
    get expires() { const v = parseInt(sessionStorage.getItem(EXP_KEY) || "0", 10); return v || 0; },
    isLikelyValid() { return !!sessionStorage.getItem(TOKEN_KEY) && this.expires > Math.floor(Date.now() / 1000) + 10; },
    async getToken() {
      const blob = sessionStorage.getItem(TOKEN_KEY);
      if (!blob) return null;
      try {
        const [ivB, ctB] = blob.split(".");
        if (!ivB || !ctB) return null;
        const key = await getWrapKey();
        const pt = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: b64uDec(ivB) }, key, b64uDec(ctB)
        );
        return td.decode(pt);
      } catch { return null; }
    },
    async set(token, expires) {
      try {
        const key = await getWrapKey();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt(
          { name: "AES-GCM", iv }, key, te.encode(String(token))
        ));
        sessionStorage.setItem(TOKEN_KEY, b64uEnc(iv) + "." + b64uEnc(ct));
        sessionStorage.setItem(EXP_KEY, String(expires));
      } catch {
        // Encryption failed: do not fall back to plaintext. Refuse to store.
        try { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(EXP_KEY); } catch {}
      }
    },
    async clear() {
      try { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(EXP_KEY); } catch {}
      try { await idbDel(IDB_KEY_ID); } catch {}
    },
  };

  /* ============ RSA public key bootstrap ============ */
  let _pubKey = null;
  async function getPubKey() {
    if (_pubKey) return _pubKey;
    const r = await fetch(API_BASE + "/auth/pubkey", { credentials: "omit" });
    const body = await r.json();
    if (!body || body.code !== OK || !body.pubkey) throw new Error("pubkey fetch failed");
    _pubKey = await crypto.subtle.importKey(
      "jwk", body.pubkey,
      { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]
    );
    return _pubKey;
  }

  /* ============ per-request session keys ============ */
  async function makeAesKey() {
    return crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
    );
  }
  async function wrapAesKey(aesKey) {
    const raw = await crypto.subtle.exportKey("raw", aesKey);
    const pub = await getPubKey();
    const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pub, raw);
    return b64uEnc(new Uint8Array(wrapped));
  }
  async function aesEncryptJson(aesKey, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, aesKey, te.encode(JSON.stringify(obj))
    );
    return { iv: b64uEnc(iv), ct: b64uEnc(new Uint8Array(ct)) };
  }
  async function aesDecryptJson(aesKey, ivB64u, ctB64u) {
    const iv = b64uDec(ivB64u);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, b64uDec(ctB64u));
    return JSON.parse(td.decode(pt));
  }

  /* ============ encrypted POST helper ============ */
  async function encPost(path, bodyObj, { auth = true } = {}) {
    const aesKey  = await makeAesKey();
    const wrapped = await wrapAesKey(aesKey);
    const { iv, ct } = await aesEncryptJson(aesKey, bodyObj || {});

    const headers = new Headers({ "content-type": "application/json" });
    if (auth) {
      const tok = await authStore.getToken();
      if (tok) headers.set("authorization", "Bearer " + tok);
    }

    const r = await fetch(API_BASE + path, {
      method: "POST",
      headers,
      body: JSON.stringify({ k: wrapped, iv, ct }),
      credentials: "omit",
    });

    let env = null; try { env = await r.json(); } catch {}
    if (!env) return { status: r.status, body: { code: ERR, reason: "parse" } };
    if (env.code === ERR && !env.iv) return { status: r.status, body: env };
    if (env.iv && env.ct) {
      try {
        const body = await aesDecryptJson(aesKey, env.iv, env.ct);
        return { status: r.status, body };
      } catch { return { status: r.status, body: { code: ERR, reason: "decrypt" } }; }
    }
    return { status: r.status, body: env };
  }

  /* ============ auth API ============ */
  async function login(username, password) {
    const u = sanitizeStr(username, 128);
    const p = sanitizeStr(password, 256);
    if (!u || !p) return { code: ERR, reason: "bad-input" };
    const { body } = await encPost("/auth/login", { username: u, password: p }, { auth: false });
    if (body && body.code === OK && body.token) {
      await authStore.set(body.token, body.expires || 0);
      return { code: OK };
    }
    return { code: ERR, reason: (body && body.reason) || "auth" };
  }
  async function verify() {
    if (!authStore.isLikelyValid()) return { code: ERR };
    const { body } = await encPost("/auth/verify", {});
    return { code: body && body.code === OK ? OK : ERR };
  }
  async function logout() {
    try { await encPost("/auth/logout", {}); } catch {}
    await authStore.clear();
  }

  /* ============ encrypted studio bundle loader ============
     The editor source is not served as a static file. After auth succeeds,
     we fetch it over the same RSA+AES envelope, decrypt it in memory, and
     execute it via a one-shot blob URL that is revoked immediately. An
     unauthenticated visitor sees only this auth shell and the login modal. */
  let _bundleLoaded = false;
  async function loadStudioBundle() {
    if (_bundleLoaded) return true;
    if (!authStore.isLikelyValid()) return false;
    const { body } = await encPost("/studio/bundle", {});
    if (!body || body.code !== OK || typeof body.source !== "string" || !body.source.length) {
      return false;
    }
    const src = body.source;
    const blob = new Blob([src], { type: "text/javascript" });
    const url  = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.onload  = () => resolve();
      s.onerror = () => reject(new Error("bundle exec failed"));
      document.body.appendChild(s);
    }).finally(() => { try { URL.revokeObjectURL(url); } catch {} });
    _bundleLoaded = true;
    return true;
  }

  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB — must match worker MAX_UPLOAD_BYTES
  const ALLOWED_MIME = new Set([
    "image/png", "image/jpeg", "image/webp", "image/gif",
    "image/avif", "image/svg+xml", "application/pdf",
  ]);
  const MEDIA_HOST_ALLOW = /^https:\/\/[a-z0-9.\-]+\.(contentltd\.xyz|r2\.dev|r2\.cloudflarestorage\.com)\//i;

  function isSafeMediaUrl(u) {
    return typeof u === "string" && u.length < 2048 && MEDIA_HOST_ALLOW.test(u);
  }

  /* ============ encrypted upload ============ */
  async function uploadBlob(blob, filename) {
    if (!authStore.isLikelyValid()) return { code: ERR, reason: "no-auth" };
    if (!blob || !blob.size)        return { code: ERR, reason: "empty" };
    if (blob.size > MAX_UPLOAD_BYTES) return { code: ERR, reason: "too-big" };
    const mime = (blob.type || "").toLowerCase().split(";")[0].trim();
    if (!ALLOWED_MIME.has(mime))    return { code: ERR, reason: "bad-mime" };

    const tok = await authStore.getToken();
    if (!tok) return { code: ERR, reason: "no-auth" };

    const aesKey  = await makeAesKey();
    const wrapped = await wrapAesKey(aesKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new Uint8Array(await blob.arrayBuffer());
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, aesKey, plain
    ));

    const body = new Uint8Array(iv.byteLength + ct.byteLength);
    body.set(iv, 0); body.set(ct, iv.byteLength);

    const headers = new Headers({
      "authorization": "Bearer " + tok,
      "content-type":  "application/octet-stream",
      "x-enc-key":     wrapped,
      "x-enc-mime":    mime,
    });
    if (filename) headers.set("x-file-name", sanitizeStr(filename, 120).replace(/[^a-zA-Z0-9._\-()\ ]/g, ""));

    const r = await fetch(API_BASE + "/upload", {
      method: "POST", headers, body, credentials: "omit",
    });

    let env = null; try { env = await r.json(); } catch {}
    if (!env) return { code: ERR, reason: "parse" };
    if (env.iv && env.ct) {
      try {
        const dec = await aesDecryptJson(aesKey, env.iv, env.ct);
        if (dec && dec.code === OK && dec.url) {
          if (!isSafeMediaUrl(dec.url)) return { code: ERR, reason: "bad-url" };
          return { code: OK, url: dec.url, key: dec.key };
        }
        return { code: ERR, reason: (dec && dec.reason) || "upload" };
      } catch { return { code: ERR, reason: "decrypt" }; }
    }
    return { code: ERR, reason: env.reason || "upload" };
  }

  /* ============ login modal UI ============ */
  const MODAL_HTML = `
    <div class="auth-scrim" id="auth-scrim" role="dialog" aria-modal="true" aria-label="Sign in">
      <div class="auth-card">
        <div class="auth-head">
          <div class="auth-title">Studio</div>
          <div class="auth-sub">Sign in to continue</div>
        </div>
        <form class="auth-form" id="auth-form" autocomplete="off">
          <label class="auth-lab">Username
            <input class="auth-inp" id="auth-u" type="text" autocomplete="username" spellcheck="false" required/>
          </label>
          <label class="auth-lab">Password
            <input class="auth-inp" id="auth-p" type="password" autocomplete="current-password" required/>
          </label>
          <div class="auth-err" id="auth-err" aria-live="polite"></div>
          <button class="auth-btn" id="auth-submit" type="submit">Sign in</button>
        </form>
      </div>
    </div>`;

  const MODAL_CSS = `
    .auth-scrim{position:fixed;inset:0;background:rgba(8,8,10,.82);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);display:flex;align-items:center;justify-content:center;z-index:9999;}
    .auth-card{width:min(420px, calc(100vw - 32px));background:var(--surface,#121214);border:1px solid var(--rule,#2a2a2e);border-radius:14px;padding:28px 26px;box-shadow:0 30px 80px rgba(0,0,0,.6);}
    .auth-head{margin-bottom:20px;}
    .auth-title{font-family:var(--font-display,serif);font-size:26px;letter-spacing:-.01em;color:var(--text,#eaeaea);}
    .auth-sub{font-family:var(--font-mono,monospace);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--text-3,#7a7a80);margin-top:4px;}
    .auth-form{display:flex;flex-direction:column;gap:14px;}
    .auth-lab{display:flex;flex-direction:column;gap:6px;font-family:var(--font-mono,monospace);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--text-3,#7a7a80);}
    .auth-inp{background:var(--surface-2,#1a1a1d);border:1px solid var(--rule,#2a2a2e);border-radius:8px;padding:11px 13px;color:var(--text,#eaeaea);font-family:var(--font-ui,system-ui);font-size:14px;outline:none;transition:border-color .2s;}
    .auth-inp:focus{border-color:var(--accent,#d4a259);}
    .auth-err{min-height:16px;font-family:var(--font-mono,monospace);font-size:11px;color:#e57373;letter-spacing:.04em;}
    .auth-btn{margin-top:6px;background:var(--accent,#d4a259);color:#0c0c0e;border:0;border-radius:8px;padding:12px;font-family:var(--font-ui,system-ui);font-weight:600;font-size:14px;cursor:pointer;transition:opacity .2s,transform .1s;}
    .auth-btn:hover{opacity:.92;} .auth-btn:active{transform:translateY(1px);}
    .auth-btn[disabled]{opacity:.5;cursor:progress;}
    body.auth-gated{overflow:hidden;}
  `;

  function mountModal() {
    if (document.getElementById("auth-scrim")) return;
    const style = document.createElement("style"); style.textContent = MODAL_CSS;
    document.head.appendChild(style);
    const wrap = document.createElement("div"); wrap.innerHTML = MODAL_HTML;
    document.body.appendChild(wrap.firstElementChild);
    document.body.classList.add("auth-gated");

    const form = document.getElementById("auth-form");
    const err  = document.getElementById("auth-err");
    const btn  = document.getElementById("auth-submit");
    setTimeout(() => document.getElementById("auth-u").focus(), 40);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      btn.disabled = true; btn.textContent = "Signing in…";
      const u = document.getElementById("auth-u").value.trim();
      const p = document.getElementById("auth-p").value;
      const r = await login(u, p);
      if (r.code === OK) {
        let bundleOk = false;
        try { bundleOk = await loadStudioBundle(); } catch { bundleOk = false; }
        if (!bundleOk) {
          err.textContent = "Signed in, but the editor failed to load. Refresh to retry.";
          btn.disabled = false; btn.textContent = "Sign in";
          return;
        }
        unmountModal();
        document.dispatchEvent(new CustomEvent("studio-auth-ready"));
      } else {
        if (r.reason === "ban24")      err.textContent = "This IP is banned for 24 hours after too many failed attempts.";
        else if (r.reason === "locked") err.textContent = "Too many recent attempts. Try again in an hour.";
        else                            err.textContent = "Incorrect username or password.";
        btn.disabled = false; btn.textContent = "Sign in";
        document.getElementById("auth-p").value = "";
      }
    });
  }
  function unmountModal() {
    document.getElementById("auth-scrim")?.remove();
    document.body.classList.remove("auth-gated");
  }

  /* ============ init ============ */
  async function init() {
    try { await getPubKey(); }
    catch { console.warn("[studio-auth] pubkey unavailable; API is offline"); mountModal(); return; }
    if (authStore.isLikelyValid()) {
      const { code } = await verify();
      if (code === OK) {
        let bundleOk = false;
        try { bundleOk = await loadStudioBundle(); } catch { bundleOk = false; }
        if (!bundleOk) { await authStore.clear(); mountModal(); return; }
        document.body.classList.remove("auth-gated");
        document.dispatchEvent(new CustomEvent("studio-auth-ready"));
        return;
      }
      await authStore.clear();
    }
    mountModal();
  }

  /* ============ paste / drop -> upload ============ */
  function toast(msg) {
    const t = document.getElementById("toast");
    if (!t) { console.log("[studio]", msg); return; }
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2200);
  }
  async function uploadAndInsert(blob, filename) {
    toast("Uploading…");
    const r = await uploadBlob(blob, filename);
    if (r.code !== OK) {
      if (r.reason === "no-auth") { await authStore.clear(); mountModal(); return null; }
      if (r.reason === "too-big")   toast("File too large (10 MB max)");
      else if (r.reason === "bad-mime") toast("Unsupported file type");
      else if (r.reason === "user-cap") toast("Daily upload limit reached");
      else                          toast("Upload failed: " + (r.reason || "error"));
      return null;
    }
    toast("Uploaded");
    return r.url;
  }
  function mimeToBlockType(mime) {
    if (mime && mime.startsWith("image/")) return "image";
    if (mime === "application/pdf")         return "pdf";
    return null;
  }

  window.StudioAuth = {
    isAuthed: () => authStore.isLikelyValid(),
    login, logout, verify, uploadBlob, uploadAndInsert,
    apiBase: API_BASE, codes: { OK, ERR },
  };

  // If a media block of the right type is focused, fill it instead of inserting a new one.
  function fillOrInsert(kind, url, filename) {
    const focused = document.activeElement?.closest?.(".block");
    if (focused) {
      const inner = focused.querySelector(".media-block");
      if (inner && inner.dataset.type === kind) {
        const urlInput = focused.querySelector(".media-url");
        if (urlInput) {
          urlInput.value = url;
          urlInput.dispatchEvent(new Event("input", { bubbles: true }));
          return;
        }
      }
    }
    if (window.Studio && typeof window.Studio.insertMediaBlock === "function") {
      window.Studio.insertMediaBlock(kind, url, { alt: filename });
    } else {
      document.execCommand("insertText", false, url);
    }
  }

  document.addEventListener("paste", async (e) => {
    if (!authStore.isLikelyValid()) return;
    const items = e.clipboardData?.items || [];
    // Find a file item first — if present, block default paste immediately (before any await)
    let fileItem = null;
    for (const it of items) {
      if (it.kind === "file") {
        const file = it.getAsFile(); if (!file) continue;
        if (!mimeToBlockType(file.type)) continue;
        fileItem = file;
        break;
      }
    }
    if (!fileItem) return;
    e.preventDefault(); // stop browser inserting base64 inline — must be sync before any await
    const kind = mimeToBlockType(fileItem.type);
    const url = await uploadAndInsert(fileItem, fileItem.name);
    if (!url) return;
    fillOrInsert(kind, url, fileItem.name);
  });

  document.addEventListener("dragover", (e) => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); });
  document.addEventListener("drop", async (e) => {
    if (!authStore.isLikelyValid()) return;
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    for (const file of files) {
      const kind = mimeToBlockType(file.type);
      if (!kind) { toast("Unsupported file: " + file.type); continue; }
      const url = await uploadAndInsert(file, file.name);
      if (!url) return;
      fillOrInsert(kind, url, file.name);
    }
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
