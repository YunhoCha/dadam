/* ============================================================
   다담 클라우드 동기화 — Supabase
   - 전체 상태(JSON 한 덩어리)를 user_data 테이블의 jsonb 한 칸에 저장
   - 여러 기기에서 같은 계정으로 로그인하면 자동 동기화
   - 충돌 처리: 마지막 저장 우선(_updatedAt 기준), 단일 사용자 가정
   - 설정 전(아래 두 값 미입력)에는 조용히 '로컬 전용' 모드로 동작
   ============================================================ */

/* ↓↓↓ Supabase 프로젝트에서 복사한 값 두 개를 여기에 붙여넣으세요 ↓↓↓
   Supabase 대시보드 → Project Settings → API 에서 확인
   - Project URL        : https://xxxxxxxx.supabase.co
   - anon public key    : eyJhbGciOiJ...(긴 문자열)                              */
const SUPABASE_URL = "https://mjoojpmwmhkzevfjfyvo.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_EehERQhCqOaTBqf_yUQb-A_7OU6Wrq1";
/* ↑↑↑ 이 두 줄만 바꾸면 됩니다 ↑↑↑ */

(function () {
  "use strict";

  const configured =
    SUPABASE_URL && SUPABASE_ANON_KEY &&
    !SUPABASE_URL.includes("여기에") && !SUPABASE_ANON_KEY.includes("여기에");

  /* 설정 전에는 동기화 비활성 — 앱은 평소처럼 로컬에서만 동작 */
  if (!configured) {
    console.info("[다담 동기화] Supabase 미설정 — 로컬 전용 모드. sync.js 상단의 URL/KEY를 채우세요.");
    buildUI({ enabled: false });
    return;
  }
  if (!window.supabase) {
    console.warn("[다담 동기화] Supabase SDK 로드 실패 — 로컬 전용 모드.");
    buildUI({ enabled: false });
    return;
  }

  const TABLE = "user_data";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  let session = null;       // 현재 로그인 세션
  let pushTimer = null;     // 디바운스 타이머
  let lastPushedAt = 0;     // 우리가 마지막으로 올린 _updatedAt (에코 무시용)
  let realtimeCh = null;
  const ui = buildUI({ enabled: true });

  /* ---------- 공개 인터페이스 (app.js의 save()가 호출) ---------- */
  window.DadamSync = {
    queuePush() {
      if (!session) return;                 // 로그인 전엔 클라우드 저장 안 함
      setStatus("dirty", "변경됨…");
      clearTimeout(pushTimer);
      pushTimer = setTimeout(push, 1200);   // 1.2초 디바운스
    },
  };

  /* ---------- 인증 상태 추적 ---------- */
  sb.auth.getSession().then(({ data }) => { handleSession(data.session); });
  sb.auth.onAuthStateChange((_evt, s) => { handleSession(s); });

  async function handleSession(s) {
    session = s;
    if (s) {
      ui.setLoggedIn(s.user.email);
      await pullAndMerge();
      subscribeRealtime();
    } else {
      ui.setLoggedOut();
      unsubscribeRealtime();
    }
  }

  /* ---------- 클라우드 → 로컬 (로그인 시 1회) ---------- */
  async function pullAndMerge() {
    setStatus("sync", "동기화 중…");
    const { data, error } = await sb
      .from(TABLE).select("data").eq("user_id", session.user.id).maybeSingle();

    if (error) { console.error(error); setStatus("err", "오류"); return; }

    const cloud = data && data.data;
    const local = window.Dadam.getState();
    const cloudT = (cloud && cloud._updatedAt) || 0;
    const localT = (local && local._updatedAt) || 0;

    if (!cloud) {
      // 클라우드에 아직 없음 → 현재 로컬을 첫 업로드
      await push();
    } else if (cloudT >= localT) {
      // 클라우드가 더 최신(또는 동일) → 로컬 교체
      window.Dadam.replaceState(cloud);
      lastPushedAt = cloudT;
      setStatus("ok", "동기화됨");
    } else {
      // 로컬이 더 최신(오프라인 편집 등) → 클라우드로 올림
      await push();
    }
  }

  /* ---------- 로컬 → 클라우드 ---------- */
  async function push() {
    if (!session) return;
    const st = window.Dadam.getState();
    const t = st._updatedAt || Date.now();
    setStatus("sync", "저장 중…");
    const { error } = await sb.from(TABLE).upsert({
      user_id: session.user.id,
      data: st,
      updated_at: new Date(t).toISOString(),
    });
    if (error) { console.error(error); setStatus("err", "저장 실패"); return; }
    lastPushedAt = t;
    setStatus("ok", "저장됨");
  }

  /* ---------- 실시간: 다른 기기의 변경 즉시 반영 ---------- */
  function subscribeRealtime() {
    unsubscribeRealtime();
    realtimeCh = sb
      .channel("dadam-" + session.user.id)
      .on("postgres_changes",
        { event: "*", schema: "public", table: TABLE, filter: "user_id=eq." + session.user.id },
        (payload) => {
          const cloud = payload.new && payload.new.data;
          if (!cloud) return;
          const cloudT = cloud._updatedAt || 0;
          if (cloudT <= lastPushedAt) return;        // 내가 올린 변경의 에코 → 무시
          window.Dadam.replaceState(cloud);
          lastPushedAt = cloudT;
          setStatus("ok", "다른 기기에서 갱신됨");
        })
      .subscribe();
  }
  function unsubscribeRealtime() {
    if (realtimeCh) { sb.removeChannel(realtimeCh); realtimeCh = null; }
  }

  /* ---------- 로그인/로그아웃 동작 ---------- */
  async function sendMagicLink(email) {
    setStatus("sync", "메일 전송 중…");
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href.split("#")[0] },
    });
    if (error) { alert("로그인 메일 전송 실패: " + error.message); setStatus("err", "실패"); return false; }
    return true;
  }
  async function signOut() { await sb.auth.signOut(); }

  /* ========================================================
     UI — 헤더의 동기화 버튼 + 로그인 모달 (기존 스타일 재사용)
     ======================================================== */
  function buildUI({ enabled }) {
    // 헤더 버튼 (index.html에 자리만 있으면 사용, 없으면 생성)
    let btn = document.getElementById("syncBtn");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "syncBtn";
      btn.className = "ghost-btn";
      const title = document.querySelector(".cal-title");
      if (title) title.appendChild(btn); else document.body.appendChild(btn);
    }
    btn.innerHTML = enabled
      ? '<span class="sync-dot" id="syncDot"></span><span id="syncLabel">로그인</span>'
      : '<span id="syncLabel">로컬 전용</span>';
    if (!enabled) { btn.disabled = true; btn.title = "sync.js에 Supabase 정보를 입력하면 켜집니다"; return {}; }

    // 로그인 모달 (기존 .modal 스타일 재사용)
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.id = "loginModal";
    modal.hidden = true;
    modal.innerHTML =
      '<div class="modal-backdrop" data-close></div>' +
      '<div class="modal-card" role="dialog" aria-modal="true">' +
        '<div class="modal-head"><span class="modal-title-txt">☁ 기기 간 동기화</span>' +
        '<button class="icon-btn sm" data-close title="닫기">✕</button></div>' +
        '<p style="font-size:13px;color:var(--ink-soft);margin:0 0 12px;line-height:1.6">' +
        '이메일을 입력하면 <b>로그인 링크</b>가 전송됩니다.<br>받은 메일의 링크를 누르면 이 기기가 연결돼요. (비밀번호 없음)</p>' +
        '<input class="field-input big" id="loginEmail" type="email" placeholder="you@example.com" autocomplete="email" />' +
        '<button class="ghost-btn" id="loginSend" style="width:100%;justify-content:center">로그인 링크 받기</button>' +
        '<p id="loginMsg" style="font-size:12.5px;color:var(--ink-soft);margin:10px 0 0;text-align:center"></p>' +
      '</div>';
    document.body.appendChild(modal);

    const close = () => { modal.hidden = true; };
    modal.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", close));
    const emailInput = modal.querySelector("#loginEmail");
    const msg = modal.querySelector("#loginMsg");
    modal.querySelector("#loginSend").addEventListener("click", async () => {
      const email = emailInput.value.trim();
      if (!email) { emailInput.focus(); return; }
      const ok = await sendMagicLink(email);
      if (ok) msg.textContent = "📬 메일을 확인해 링크를 눌러주세요.";
    });
    emailInput.addEventListener("keydown", (e) => { if (e.key === "Enter") modal.querySelector("#loginSend").click(); });

    let loggedIn = false;
    btn.addEventListener("click", () => {
      if (loggedIn) {
        if (confirm("로그아웃할까요? (데이터는 클라우드에 남아 있어요)")) signOut();
      } else {
        modal.hidden = false; emailInput.focus();
      }
    });

    return {
      setLoggedIn(email) {
        loggedIn = true; close();
        btn.querySelector("#syncLabel").textContent = email.length > 18 ? email.slice(0, 16) + "…" : email;
        btn.title = email + " — 클릭하면 로그아웃";
      },
      setLoggedOut() {
        loggedIn = false;
        btn.querySelector("#syncLabel").textContent = "로그인";
        btn.title = "기기 간 동기화 로그인";
        setStatus("off", "");
      },
    };
  }

  function setStatus(kind, label) {
    const dot = document.getElementById("syncDot");
    if (dot) dot.dataset.state = kind;           // CSS에서 색 처리
    const btn = document.getElementById("syncBtn");
    if (btn && label) btn.title = label;
  }
})();
