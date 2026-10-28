/* Standalone backend for the reading log.
   The page was written against a small document-store API (db / user / assets / room / downloads).
   This file provides the same API on top of Supabase, plus the sign-in screen:
   sign up with a name, password, profile picture and invite code; sign in with name and password. */
(() => {
  const cfg = window.BOOKLOG_CONFIG || {};
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  const BUCKET = "covers";

  // Supabase signs people in by email; a name is turned into a private, never-mailed address.
  const enc = new TextEncoder();
  const emailOf = (name) =>
    "u" + [...enc.encode(name.trim().toLowerCase())].map((b) => b.toString(16).padStart(2, "0")).join("") + "@booklog.app";

  let uid = null;
  let firstRun = false;

  /* ── Document-store API ── */
  const shelfOut = (r) => ({ since: r.since, nickname: r.nickname || "", avatarData: r.avatar_data || "", username: r.username });
  const snap = (docs) => ({ docs, metadata: { fromCache: false } });
  const docOf = (id, data) => ({ id, data: () => data });

  function watch(table, filter, load, onData, onErr) {
    let alive = true;
    const run = () => load().then((d) => { if (alive) onData(d); }, (e) => { if (alive && onErr) onErr(e); });
    run();
    const ch = sb.channel(`w-${table}-${filter || "all"}-${Math.random().toString(36).slice(2, 8)}`)
      .on("postgres_changes", { event: "*", schema: "public", table, ...(filter ? { filter } : {}) }, run)
      .subscribe();
    return () => { alive = false; sb.removeChannel(ch); };
  }

  async function shelvesAll() {
    const { data, error } = await sb.from("shelves").select("*").order("since");
    if (error) throw error;
    return snap(data.map((r) => docOf(r.id, shelfOut(r))));
  }
  async function booksOf(owner) {
    if (owner !== uid) {
      // Someone else's records come through friend_books, which leaves locked ones as a picture only
      const { data, error } = await sb.rpc("friend_books", { target: owner });
      if (!error) return snap((data || []).map((r) => docOf(r.id, r.data)));
    }
    const { data, error } = await sb.from("books").select("id,data").eq("owner", owner);
    if (error) throw error;
    return snap(data.map((r) => docOf(r.id, r.data)));
  }

  function booksCollection(owner) {
    return {
      // A friend's books are not readable directly; their shelf row is touched whenever they change
      onSnapshot: (cb, err) => (owner === uid
        ? watch("books", `owner=eq.${owner}`, () => booksOf(owner), cb, err)
        : watch("shelves", `id=eq.${owner}`, () => booksOf(owner), cb, err)),
      get: () => booksOf(owner),
      doc: (id) => ({
        async set(body) {
          const { error } = await sb.from("books").upsert({ owner, id, data: body, updated_at: new Date().toISOString() });
          if (error) throw error;
        },
        async delete() {
          const { error } = await sb.from("books").delete().eq("owner", owner).eq("id", id);
          if (error) throw error;
        },
      }),
    };
  }
  const db = {
    collection(path) {
      if (path === "shelves") return { onSnapshot: (cb, err) => watch("shelves", null, shelvesAll, cb, err), get: shelvesAll };
      return { get: async () => snap([]) }; // nothing else lives at the top level here
    },
    doc(path) {
      const [kind, id] = path.split("/");
      if (kind !== "shelves") return { get: async () => ({ exists: false, data: () => ({}) }), delete: async () => {} };
      return {
        async get() {
          const { data, error } = await sb.from("shelves").select("*").eq("id", id).maybeSingle();
          if (error) throw error;
          return { exists: !!data, data: () => (data ? shelfOut(data) : {}) };
        },
        async set(v) {
          const patch = {};
          if ("nickname" in v) patch.nickname = v.nickname;
          if ("avatarData" in v) patch.avatar_data = v.avatarData;
          const { error } = await sb.from("shelves").update(patch).eq("id", id);
          if (error) throw error;
        },
        collection: (name) => (name === "books" ? booksCollection(id) : null),
      };
    },
  };

  const user = {
    id: async () => uid,
    can: async () => true,
    isOwner: async () => false,
    async profiles(ids) {
      const { data } = await sb.from("shelves").select("id,username,nickname").in("id", [].concat(ids));
      return Object.fromEntries((data || []).map((r) => [r.id, { id: r.id, name: r.nickname || r.username }]));
    },
  };

  const assets = {
    async upload(blob, opts = {}) {
      const type = opts.type || blob.type || "image/jpeg";
      const ext = type.split("/")[1] || "jpg";
      const path = `${uid}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: type, upsert: false });
      if (error) throw { code: /size|large/i.test(error.message || "") ? "too_large" : "upstream_error", message: error.message };
      return { id: path, url: blobUrl(path), sizeBytes: blob.size, contentType: type };
    },
    async delete(ref) {
      const { error } = await sb.storage.from(BUCKET).remove([ref]);
      return { deleted: !error };
    },
  };
  const blobUrl = (id) => sb.storage.from(BUCKET).getPublicUrl(id).data.publicUrl;

  function room() {
    let ch = null, handler = null;
    const connect = () => {
      if (ch) return;
      ch = sb.channel("online", { config: { presence: { key: uid } } });
      ch.on("presence", { event: "sync" }, () => {
        const state = ch.presenceState();
        if (handler) handler({ peers: Object.keys(state).map((k) => ({ kind: "viewer", by: k })) });
      });
      ch.subscribe((s) => { if (s === "SUBSCRIBED") ch.track({ uid, at: Date.now() }); });
    };
    return {
      onPeers(h) { handler = h; connect(); return () => { handler = null; }; },
      async presence() { connect(); },
    };
  }

  const downloads = {
    async save({ filename, data }) {
      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    },
  };

  /* ── Sign-in screen ── */
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));

  window.claude = {
    use: async (name) => {
      await ready;
      return { db, user, assets, room: room(), downloads }[name] || null;
    },
    blobUrl,
    signOut: async () => { await sb.auth.signOut(); location.reload(); },
    get firstRun() { return firstRun; },
    set firstRun(v) { firstRun = v; },
  };

  const css = `
  .gate { position: fixed; inset: 0; z-index: 100; background: var(--bg, #F0F0EE); color: var(--ink, #111);
    display: grid; place-items: center; padding: 24px 16px; overflow-y: auto; font-family: inherit; }
  .gate form { width: min(320px, 100%); display: grid; gap: 16px; justify-items: center; text-align: center; }
  .gate h1 { margin: 0; font-size: clamp(44px, 12vw, 64px); font-weight: 500; letter-spacing: -0.03em; line-height: .9; }
  .gate p { margin: 0; font-size: 13px; color: var(--muted, #727272); line-height: 1.6; }
  .gate .tabs { display: flex; gap: 2px; background: var(--soft, #D9D9D7); border-radius: 999px; padding: 2px; }
  .gate .tabs button { font: inherit; font-size: 13px; padding: 6px 16px; border: 0; border-radius: 999px; background: none; color: var(--muted, #727272); cursor: pointer; text-decoration: none; }
  .gate .tabs button[aria-pressed="true"] { background: var(--ink, #111); color: var(--bg, #fff); }
  .gate .pic { width: 104px; height: 104px; border-radius: 50%; overflow: hidden; position: relative; cursor: pointer;
    border: 1px dashed var(--muted, #727272); display: grid; place-items: center; color: var(--muted, #727272); font-size: 12px; background: none; font-family: inherit; }
  .gate .pic.filled { border: 0; }
  .gate .pic img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .gate input:not([type=file]) { width: 100%; font: inherit; font-size: 16px; text-align: center; color: var(--ink, #111);
    background: transparent; border: 0; border-bottom: 1px solid var(--soft, #D9D9D7); border-radius: 0; padding: 8px 0; }
  .gate input:focus { outline: none; border-bottom-color: var(--ink, #111); }
  .gate .go { font: inherit; font-size: 14px; font-weight: 500; background: var(--ink, #111); color: var(--bg, #fff);
    border: 0; border-radius: 999px; padding: 10px 28px; cursor: pointer; }
  .gate .go:disabled { opacity: .35; cursor: not-allowed; }
  .gate .msg { min-height: 1.2em; font-size: 12px; color: var(--red, #E5332A); }
  .gate [hidden] { display: none !important; }`;

  function squareAvatar(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const c = document.createElement("canvas"); c.width = c.height = 200;
        const g = c.getContext("2d");
        g.fillStyle = "#fff"; g.fillRect(0, 0, 200, 200);
        g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 200, 200);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image")); };
      img.src = url;
    });
  }

  function showGate() {
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    const g = document.createElement("div");
    g.className = "gate";
    g.innerHTML = `
      <form autocomplete="on" novalidate>
        <h1>BOOKLOG</h1>
        <div class="tabs" role="group" aria-label="가입 또는 로그인">
          <button type="button" data-m="join" aria-pressed="true">처음이에요</button>
          <button type="button" data-m="login" aria-pressed="false">로그인</button>
        </div>
        <p data-for="join">초대받은 사람만 책장을 만들 수 있어요.</p>
        <button type="button" class="pic" data-for="join" aria-label="프로필 이미지 고르기"><span>이미지 넣기<br>＋</span></button>
        <input type="file" accept="image/*" hidden>
        <input name="username" placeholder="이름" maxlength="20" autocomplete="username" aria-label="이름">
        <input name="password" type="password" placeholder="비밀번호 (6자 이상)" autocomplete="current-password" aria-label="비밀번호">
        <input name="code" data-for="join" placeholder="초대 코드" autocomplete="off" aria-label="초대 코드">
        <span class="msg" role="status"></span>
        <button type="submit" class="go">시작하기</button>
      </form>`;
    document.body.appendChild(g);
    const f = g.querySelector("form"), msg = g.querySelector(".msg"), go = g.querySelector(".go");
    const pic = g.querySelector(".pic"), file = g.querySelector("input[type=file]");
    let mode = "join", avatar = "";
    const setMode = (m) => {
      mode = m;
      g.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.m === m));
      g.querySelectorAll("[data-for=join]").forEach((el) => (el.hidden = m !== "join"));
      f.password.autocomplete = m === "join" ? "new-password" : "current-password";
      go.textContent = m === "join" ? "책장 만들기" : "로그인";
      msg.textContent = "";
    };
    g.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.m)));
    pic.addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      const fl = file.files[0]; file.value = "";
      if (!fl) return;
      try {
        avatar = await squareAvatar(fl);
        pic.classList.add("filled");
        pic.innerHTML = ""; const i = document.createElement("img"); i.src = avatar; i.alt = ""; pic.appendChild(i);
      } catch { msg.textContent = "이미지를 읽지 못했어요. 다른 파일을 골라 주세요."; }
    });
    setMode("join");

    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = f.username.value.trim(), pw = f.password.value, code = f.code.value.trim();
      if (!name) { msg.textContent = "이름을 적어 주세요."; return; }
      if (pw.length < 6) { msg.textContent = "비밀번호는 6자 이상이에요."; return; }
      go.disabled = true; msg.textContent = "";
      try {
        if (mode === "login") {
          const { error } = await sb.auth.signInWithPassword({ email: emailOf(name), password: pw });
          if (error) throw new Error("이름이나 비밀번호가 맞지 않아요.");
          const { data } = await sb.auth.getUser();
          const { data: mine } = await sb.from("shelves").select("id").eq("id", data.user.id).maybeSingle();
          if (!mine) { await sb.auth.signOut(); throw new Error("아직 책장이 없는 계정이에요. '처음이에요'에서 초대 코드로 만들어 주세요."); }
          return enter(data.user.id);
        }
        if (!avatar) throw new Error("프로필 이미지를 넣어 주세요.");
        if (!code) throw new Error("초대 코드를 적어 주세요.");
        const ok = await sb.rpc("check_invite", { c: code });
        if (ok.error || !ok.data) throw new Error("초대 코드가 맞지 않아요.");
        let { data, error } = await sb.auth.signUp({ email: emailOf(name), password: pw });
        if (error && /registered|exists/i.test(error.message)) {
          // Same name again: only fine if it is really them, half-way through joining
          const r = await sb.auth.signInWithPassword({ email: emailOf(name), password: pw });
          if (r.error) throw new Error("이미 쓰고 있는 이름이에요. 다른 이름을 골라 주세요.");
          data = r.data;
        } else if (error) throw new Error("가입하지 못했어요. 잠시 뒤 다시 해 주세요.");
        if (!data.session) throw new Error("Supabase에서 이메일 확인 끄기 설정이 필요해요. 배포 안내서를 봐 주세요.");
        const j = await sb.rpc("join_booklog", { c: code, uname: name, nick: name, avatar });
        if (j.error) throw new Error(/username|unique/i.test(j.error.message) ? "이미 쓰고 있는 이름이에요." : "책장을 만들지 못했어요. 초대 코드를 확인해 주세요.");
        firstRun = true;
        enter(data.user.id);
      } catch (err) {
        msg.textContent = err.message || "문제가 생겼어요. 다시 해 주세요.";
        go.disabled = false;
      }
    });
    function enter(id) { uid = id; g.remove(); resolveReady(); }
  }

  (async () => {
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || /YOUR_/.test(cfg.supabaseUrl)) {
      document.addEventListener("DOMContentLoaded", () => {
        document.body.innerHTML = '<p style="padding:24px;font-size:14px">config.js에 Supabase 주소와 키를 넣어 주세요.</p>';
      });
      return;
    }
    // When the server cannot be reached, say so plainly instead of leaving an empty page that ignores clicks
    const down = () => {
      const show = () => {
        const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
        const g = document.createElement("div"); g.className = "gate";
        g.innerHTML = '<form><h1>BOOKLOG</h1><p>지금 기록 저장소에 연결할 수 없어요.<br>잠시 뒤 다시 열어 주세요.</p><button type="button" class="go">다시 시도</button></form>';
        g.querySelector(".go").addEventListener("click", () => location.reload());
        document.body.appendChild(g);
      };
      if (document.body) show(); else document.addEventListener("DOMContentLoaded", show);
    };
    try {
      const { data } = await sb.auth.getSession();
      const id = data.session && data.session.user.id;
      if (id) {
        const { data: mine, error } = await sb.from("shelves").select("id").eq("id", id).maybeSingle();
        if (error) { down(); return; }   // a network failure is not a missing shelf: keep them signed in
        if (mine) { uid = id; resolveReady(); return; }
        await sb.auth.signOut();
      }
      if (document.body) showGate(); else document.addEventListener("DOMContentLoaded", showGate);
    } catch { down(); }
  })();
})();
