/* ============================================================
   다담 (Dadam) v2 — 캘린더 · 할 일 · 마감 · 메모 · 일지
   순수 바닐라 JS, localStorage 저장
   ============================================================ */

const STORE_KEY = "dadam.v2";

/* ---------- 카테고리 (사용자 설정 가능, state.categories에 저장) ----------
   - 색 팔레트에서 골라 쓰고, 할 일에는 '태그'처럼 여러 개 지정 가능 */
const PALETTE = ["sky", "mint", "lilac", "coral", "sun", "rose", "grass", "ocean", "grape", "slate"];
const DEFAULT_CATS = [
  { id: "class",    label: "수업",   color: "sky"   },
  { id: "seminar",  label: "세미나", color: "mint"  },
  { id: "meeting",  label: "미팅",   color: "lilac" },
  { id: "personal", label: "개인",   color: "coral" },
  { id: "etc",      label: "기타",   color: "sun"   },
];
const colorClass = (color) => "c-" + (PALETTE.includes(color) ? color : "sky");
const catById = (id) => (state.categories || []).find((c) => c.id === id) || null;
const catClass = (id) => { const c = catById(id); return c ? colorClass(c.color) : "c-sky"; };

/* ---------- 상태 ----------
   items:     [{id,text,date,start,end,category,star,done,doneDates,recur}]
   deadlines: [{id,title,date,category,subtasks:[{id,text,done}]}]
   notes:     [{id,title,body,pinned,updated,linkDate}]
   journals:  { "YYYY-MM-DD": {mood:0-5, text} }
------------------------------- */
let state = load() || migrate() || { items: [], deadlines: [], notes: [], journals: {} };
/* 상태 정규화 — 초기 로드와 클라우드 수신 양쪽에서 호출.
   옛 형식(단일 category, categories 없음)을 새 형식으로 안전하게 변환 */
function normalizeState(s) {
  s.items      ||= [];
  s.deadlines  ||= [];
  s.notes      ||= [];
  s.journals   ||= {};
  s.categories ||= DEFAULT_CATS.map((c) => ({ ...c }));
  for (const it of s.items) {
    if (!Array.isArray(it.categories)) it.categories = it.category != null ? [it.category] : [];
    delete it.category;
  }
  return s;
}
normalizeState(state);

let viewYear, viewMonth, selectedKey = null;
let activeCats = new Set();            // 비어있으면 전체 표시

const today = new Date();
viewYear = today.getFullYear();
viewMonth = today.getMonth();

/* ---------- 유틸 ---------- */
const pad = (n) => String(n).padStart(2, "0");
const keyOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const todayKey = keyOf(today.getFullYear(), today.getMonth(), today.getDate());
const uid = () => Math.random().toString(36).slice(2, 9);
const parseKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const daysBetween = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 86400000);

function save() {
  state._updatedAt = Date.now();
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  if (window.DadamSync) window.DadamSync.queuePush();   // 클라우드 동기화(있을 때만)
}
function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; } }

/* v1 → v2 마이그레이션 (기존 데이터 보존) */
function migrate() {
  let old; try { old = JSON.parse(localStorage.getItem("dadam.v1")); } catch { return null; }
  if (!old) return null;
  const s = { items: [], deadlines: [], notes: [], journals: {} };
  const colorToCat = { sky: "etc", mint: "seminar", coral: "personal", lilac: "meeting", sun: "class" };
  for (const [date, arr] of Object.entries(old.todos || {})) {
    for (const t of arr) s.items.push({
      id: t.id || uid(), text: t.text, date, start: null, end: null,
      category: colorToCat[t.color] || null, star: false, done: !!t.done, doneDates: {}, recur: null,
    });
  }
  for (const n of (old.notes || [])) s.notes.push({ ...n, pinned: false, linkDate: null });
  return s;
}

const MONTHS_KR = ["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"];
const DOW_KR = ["일","월","화","수","목","금","토"];

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const grid = $("calendarGrid"), monthLabel = $("monthLabel"), blockList = $("blockList");
const tpDate = $("tpDate"), tpEyebrow = $("tpEyebrow"), dragGhost = $("dragGhost");

/* ============================================================
   아이템(일정/할 일) 헬퍼 — 반복 포함
   ============================================================ */
function occursOn(it, key) {
  if (!it.recur) return it.date === key;
  if (key < it.date) return false;
  if (it.recur.until && key > it.recur.until) return false;
  if (parseKey(key).getDay() !== parseKey(it.date).getDay()) return false;
  const weeks = Math.round(daysBetween(it.date, key) / 7);
  const interval = it.recur.freq === "biweekly" ? 2 : 1;
  return weeks % interval === 0;
}
function isDone(it, key) { return it.recur ? !!(it.doneDates && it.doneDates[key]) : it.done; }
function toggleDone(it, key) {
  if (it.recur) { it.doneDates ||= {}; it.doneDates[key] = !it.doneDates[key]; }
  else it.done = !it.done;
}
function passFilter(it) {
  if (activeCats.size === 0) return true;
  return (it.categories || []).some((c) => activeCats.has(c));
}

function itemsForDate(key) {
  const res = state.items.filter((it) => occursOn(it, key) && passFilter(it));
  res.sort((a, b) => {
    if (!!b.star - !!a.star) return !!b.star - !!a.star;     // 별표 먼저
    const at = a.start || "99:99", bt = b.start || "99:99";   // 시간순(없으면 뒤로)
    if (at !== bt) return at < bt ? -1 : 1;
    return 0;
  });
  return res;
}

/* ============================================================
   카테고리 필터 칩
   ============================================================ */
function renderCatFilter() {
  const wrap = $("catFilter");
  wrap.innerHTML = "";
  const head = document.createElement("div");
  head.className = "legend-head";
  head.innerHTML = `<span>카테고리</span>`;
  const gear = document.createElement("button");
  gear.className = "legend-gear"; gear.textContent = "⚙"; gear.title = "카테고리 설정";
  gear.onclick = () => openSettings();
  head.appendChild(gear);
  wrap.appendChild(head);

  const all = document.createElement("button");
  all.className = "fchip" + (activeCats.size === 0 ? " on" : "");
  all.textContent = "전체 보기";
  all.onclick = () => { activeCats.clear(); renderCatFilter(); renderCalendar(); renderDayPanel(); };
  wrap.appendChild(all);

  for (const cat of state.categories) {
    const b = document.createElement("button");
    b.className = `fchip ${colorClass(cat.color)}` + (activeCats.has(cat.id) ? " on" : "");
    b.innerHTML = `<i class="dot"></i>${escapeHtml(cat.label) || "(이름 없음)"}`;
    b.onclick = () => {
      activeCats.has(cat.id) ? activeCats.delete(cat.id) : activeCats.add(cat.id);
      renderCatFilter(); renderCalendar(); renderDayPanel();
    };
    wrap.appendChild(b);
  }
}

/* ============================================================
   캘린더
   ============================================================ */
function prevMY() { return viewMonth === 0 ? { y: viewYear - 1, m: 11 } : { y: viewYear, m: viewMonth - 1 }; }
function nextMY() { return viewMonth === 11 ? { y: viewYear + 1, m: 0 } : { y: viewYear, m: viewMonth + 1 }; }

function renderCalendar() {
  monthLabel.textContent = `${viewYear}년 ${MONTHS_KR[viewMonth]}`;
  grid.innerHTML = "";
  const startDow = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const daysInPrev = new Date(viewYear, viewMonth, 0).getDate();
  const cells = [];
  const pm = prevMY(), nm = nextMY();
  for (let i = startDow - 1; i >= 0; i--) cells.push({ y: pm.y, m: pm.m, d: daysInPrev - i, outside: true });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ y: viewYear, m: viewMonth, d, outside: false });
  let nd = 1;
  // 마지막 주만 채움 → 보통 5주(필요한 달은 6주). 6주 고정보다 세로로 짧게
  while (cells.length % 7 !== 0) cells.push({ y: nm.y, m: nm.m, d: nd++, outside: true });
  for (const c of cells) grid.appendChild(makeDayCell(c));
}

function makeDayCell(c) {
  const key = keyOf(c.y, c.m, c.d);
  const el = document.createElement("div");
  el.className = "day";
  el.dataset.key = key;
  if (c.outside) el.classList.add("is-outside");
  if (key === todayKey) el.classList.add("is-today");
  if (key === selectedKey) el.classList.add("is-selected");

  const top = document.createElement("div");
  top.className = "day-top";
  const num = document.createElement("div");
  num.className = "day-num"; num.textContent = c.d;
  top.appendChild(num);
  // 연결된 메모 아이콘
  const linkedNotes = state.notes.filter((n) => n.linkDate === key);
  if (linkedNotes.length) {
    const mi = document.createElement("button");
    mi.className = "memo-ind";
    mi.innerHTML = `📝${linkedNotes.length > 1 ? `<i>${linkedNotes.length}</i>` : ""}`;
    mi.title = linkedNotes.length > 1 ? `연결된 메모 ${linkedNotes.length}개` : (linkedNotes[0].title || "메모");
    mi.onclick = (e) => {
      e.stopPropagation();
      if (linkedNotes.length === 1) openMemo(linkedNotes[0].id);
      else showMemoMenu(e.currentTarget, linkedNotes);
    };
    top.appendChild(mi);
  }
  el.appendChild(top);

  const chips = document.createElement("div");
  chips.className = "day-chips";
  // 마감 칩 (제목 + D-day) 먼저
  const dls = state.deadlines.filter((d) => d.date === key);
  for (const d of dls) chips.appendChild(makeDeadlineChip(d));
  // 일정/할 일 칩
  const items = itemsForDate(key);
  for (const t of items.slice(0, 3)) chips.appendChild(makeChip(t, key));
  if (items.length > 3) {
    const more = document.createElement("div");
    more.className = "day-more"; more.textContent = `+${items.length - 3}개 더`;
    chips.appendChild(more);
  }
  el.appendChild(chips);

  el.addEventListener("click", (e) => { if (e.target.closest(".chip")) return; selectDate(key); });
  setupDropTarget(el, key);
  return el;
}

function makeChip(t, key) {
  const chip = document.createElement("div");
  const cats = (t.categories || []).map(catById).filter(Boolean);
  chip.className = `chip ${cats[0] ? colorClass(cats[0].color) : "c-sky"}` + (isDone(t, key) ? " done" : "");
  const time = t.start ? `<b>${t.start}</b> ` : "";
  const star = t.star ? "★ " : "";
  const rec = t.recur ? " ↻" : "";
  const dots = cats.length
    ? `<span class="chip-cats">${cats.map((c) => `<i class="cdot ${colorClass(c.color)}"></i>`).join("")}</span>`
    : "";
  chip.innerHTML = `${star}${time}${dots}${escapeHtml(t.text) || "(빈 항목)"}${rec}`;
  chip.title = (t.start ? t.start + " " : "") + (t.text || "") + (cats.length ? ` · ${cats.map((c) => c.label).join(", ")}` : "");

  if (!t.recur) {
    chip.draggable = true;
    chip.dataset.id = t.id;
    chip.addEventListener("dragstart", (e) => {
      dragData = { id: t.id, from: key };
      chip.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      const img = new Image(); img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
      e.dataTransfer.setDragImage(img, 0, 0);
      showGhost(t.text || "(빈 항목)");
    });
    chip.addEventListener("drag", moveGhost);
    chip.addEventListener("dragend", () => {
      chip.classList.remove("dragging"); hideGhost();
      document.querySelectorAll(".day.drop-target").forEach((d) => d.classList.remove("drop-target"));
    });
  }
  return chip;
}

function makeDeadlineChip(d) {
  const chip = document.createElement("div");
  chip.className = `chip dl-chip ${catClass(d.category)}`;
  const dd = daysBetween(todayKey, d.date);
  const ddText = dd === 0 ? "D-DAY" : dd > 0 ? `D-${dd}` : `D+${-dd}`;
  chip.innerHTML = `<span class="dl-tag">⏰${ddText}</span> ${escapeHtml(d.title) || "마감"}`;
  chip.title = `${ddText} · ${d.title || "마감"}`;
  chip.addEventListener("click", (e) => { e.stopPropagation(); openDeadlineModal(d); });
  return chip;
}

/* 날짜에 연결된 메모가 여러 개일 때 목록 팝업 */
function closeMemoMenu() { document.getElementById("memoMenu")?.remove(); }
function showMemoMenu(anchor, notes) {
  closeMemoMenu();
  const menu = document.createElement("div");
  menu.className = "memo-menu"; menu.id = "memoMenu";
  const head = document.createElement("div");
  head.className = "memo-menu-head"; head.textContent = `연결된 메모 ${notes.length}개`;
  menu.appendChild(head);
  for (const n of notes) {
    const row = document.createElement("div");
    row.className = "memo-menu-row";
    row.innerHTML = `<span>📝</span><span class="mm-title">${escapeHtml(n.title) || "제목 없음"}</span>`;
    row.onclick = () => { closeMemoMenu(); openMemo(n.id); };
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 12) + "px";
  menu.style.top = (r.bottom + 4) + "px";
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".memo-menu") && !e.target.closest(".memo-ind")) closeMemoMenu();
});

/* 칩 → 날짜 이동 */
let dragData = null;
function setupDropTarget(el, key) {
  el.addEventListener("dragover", (e) => { if (!dragData) return; e.preventDefault(); el.classList.add("drop-target"); });
  el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
  el.addEventListener("drop", (e) => {
    e.preventDefault(); el.classList.remove("drop-target");
    if (!dragData || dragData.from === key) return;
    const it = state.items.find((x) => x.id === dragData.id);
    if (it) { it.date = key; save(); renderCalendar(); renderDayPanel(); }
    dragData = null;
  });
}
function showGhost(t) { dragGhost.textContent = t; dragGhost.classList.add("show"); }
function moveGhost(e) { if (e.clientX === 0 && e.clientY === 0) return; dragGhost.style.left = e.clientX + 14 + "px"; dragGhost.style.top = e.clientY + "px"; }
function hideGhost() { dragGhost.classList.remove("show"); }

/* ============================================================
   날짜 선택 + 할 일 블럭 + 일지
   ============================================================ */
function selectDate(key) {
  selectedKey = key;
  document.querySelectorAll(".day").forEach((d) => d.classList.toggle("is-selected", d.dataset.key === key));
  renderDayPanel();
}
function prettyDate(key) {
  const d = parseKey(key);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW_KR[d.getDay()]})`;
}

function renderDayPanel() {
  if (!selectedKey) return;
  tpEyebrow.textContent = selectedKey === todayKey ? "오늘" : "선택한 날짜";
  tpDate.textContent = prettyDate(selectedKey);

  const items = itemsForDate(selectedKey);
  blockList.innerHTML = "";
  if (items.length === 0) {
    blockList.innerHTML = `<div class="tp-empty"><span class="em-ico">☁️</span>담은 일이 없어요.<br>아래에서 추가해요.</div>`;
  } else {
    items.forEach((t) => blockList.appendChild(makeBlock(t, selectedKey)));
  }
  const done = items.filter((t) => isDone(t, selectedKey)).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  $("ringText").textContent = pct + "%";
  $("ringFg").style.strokeDashoffset = 100 - pct;

  renderJournal();
}

function makeBlock(t, key) {
  const el = document.createElement("div");
  el.className = "block" + (isDone(t, key) ? " done" : "");

  const star = document.createElement("button");
  star.className = "block-star" + (t.star ? " on" : "");
  star.textContent = t.star ? "★" : "☆";
  star.title = "중요";
  star.onclick = () => { t.star = !t.star; save(); renderDayPanel(); renderCalendar(); };
  el.appendChild(star);

  const check = document.createElement("div");
  check.className = "block-check" + (isDone(t, key) ? " checked" : "");
  check.onclick = () => { toggleDone(t, key); save(); renderDayPanel(); renderCalendar(); };
  el.appendChild(check);

  const main = document.createElement("div");
  main.className = "block-main";
  const text = document.createElement("div");
  text.className = "block-text"; text.contentEditable = "true"; text.dataset.ph = "할 일 입력…";
  text.textContent = t.text;
  text.addEventListener("input", () => { t.text = text.textContent; save(); });
  text.addEventListener("blur", renderCalendar);
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); text.blur(); addBlock(); }
    if (e.key === "Backspace" && text.textContent === "") { e.preventDefault(); removeItem(t.id); }
  });
  main.appendChild(text);

  const meta = document.createElement("div");
  meta.className = "block-meta";
  if (t.start) meta.innerHTML += `<span class="m-time">🕘 ${t.start}${t.end ? "–" + t.end : ""}</span>`;
  for (const cid of (t.categories || [])) {
    const c = catById(cid);
    if (c) meta.innerHTML += `<span class="m-cat ${colorClass(c.color)}"><i class="dot"></i>${escapeHtml(c.label)}</span>`;
  }
  if (t.recur) meta.innerHTML += `<span class="m-rec">↻ ${t.recur.freq === "biweekly" ? "격주" : "매주"}</span>`;
  if (meta.innerHTML) main.appendChild(meta);
  el.appendChild(main);

  const edit = document.createElement("button");
  edit.className = "block-edit"; edit.textContent = "⚙"; edit.title = "상세";
  edit.onclick = () => openItemModal(t);
  el.appendChild(edit);

  const del = document.createElement("button");
  del.className = "block-del"; del.textContent = "✕";
  del.onclick = () => removeItem(t.id);
  el.appendChild(del);
  return el;
}

function addBlock() {
  if (!selectedKey) selectDate(todayKey);
  const it = { id: uid(), text: "", date: selectedKey, start: null, end: null, categories: [], star: false, done: false, doneDates: {}, recur: null };
  state.items.push(it);
  save(); renderDayPanel();
  requestAnimationFrame(() => {
    const blocks = blockList.querySelectorAll(".block-text");
    const last = blocks[blocks.length - 1];
    if (last) last.focus();
  });
}
function removeItem(id) {
  const i = state.items.findIndex((x) => x.id === id);
  if (i !== -1) state.items.splice(i, 1);
  save(); renderDayPanel(); renderCalendar();
}

/* ============================================================
   아이템 상세 모달
   ============================================================ */
let editingItem = null;
function openItemModal(it) {
  editingItem = it;
  $("itemText").value = it.text || "";
  $("itemStart").value = it.start || "";
  $("itemEnd").value = it.end || "";
  $("itemStar").className = "star-toggle" + (it.star ? " on" : "");
  $("itemStar").textContent = it.star ? "★ 별표" : "☆ 별표";
  $("itemRecur").value = it.recur ? it.recur.freq : "";
  $("itemUntil").value = it.recur && it.recur.until ? it.recur.until : "";
  $("recurUntilWrap").hidden = !it.recur;
  buildItemCats();
  $("itemModal").hidden = false;
}
/* 할 일: 카테고리를 태그처럼 여러 개 토글 */
function buildItemCats() {
  const wrap = $("itemCats");
  wrap.innerHTML = "";
  if (state.categories.length === 0) {
    wrap.innerHTML = `<span class="cat-empty">설정(⚙)에서 카테고리를 먼저 만들어요.</span>`;
    return;
  }
  editingItem.categories ||= [];
  for (const cat of state.categories) {
    const on = editingItem.categories.includes(cat.id);
    const b = document.createElement("button");
    b.className = `cat-opt ${colorClass(cat.color)}` + (on ? " on" : "");
    b.innerHTML = `<i class="dot"></i>${escapeHtml(cat.label)}`;
    b.onclick = () => {
      const i = editingItem.categories.indexOf(cat.id);
      if (i >= 0) editingItem.categories.splice(i, 1); else editingItem.categories.push(cat.id);
      persistItem(); buildItemCats();
    };
    wrap.appendChild(b);
  }
}

/* 마감: 카테고리 하나만 선택(단일) */
function renderCatChoose(wrap, current, onPick) {
  wrap.innerHTML = "";
  const none = document.createElement("button");
  none.className = "cat-opt" + (!current ? " on" : "");
  none.textContent = "없음";
  none.onclick = () => onPick(null);
  wrap.appendChild(none);
  for (const cat of state.categories) {
    const b = document.createElement("button");
    b.className = `cat-opt ${colorClass(cat.color)}` + (current === cat.id ? " on" : "");
    b.innerHTML = `<i class="dot"></i>${escapeHtml(cat.label)}`;
    b.onclick = () => onPick(cat.id);
    wrap.appendChild(b);
  }
}
function persistItem() {
  const it = editingItem; if (!it) return;
  it.text = $("itemText").value;
  it.start = $("itemStart").value || null;
  it.end = $("itemEnd").value || null;
  const freq = $("itemRecur").value;
  if (freq) it.recur = { freq, until: $("itemUntil").value || null };
  else it.recur = null;
  save(); renderCalendar(); renderDayPanel();
}
$("itemText").addEventListener("input", persistItem);
$("itemStart").addEventListener("input", persistItem);
$("itemEnd").addEventListener("input", persistItem);
$("itemStar").addEventListener("click", () => {
  editingItem.star = !editingItem.star;
  $("itemStar").className = "star-toggle" + (editingItem.star ? " on" : "");
  $("itemStar").textContent = editingItem.star ? "★ 별표" : "☆ 별표";
  persistItem();
});
$("itemRecur").addEventListener("change", () => {
  $("recurUntilWrap").hidden = !$("itemRecur").value;
  persistItem();
});
$("itemUntil").addEventListener("input", persistItem);
$("itemDelete").addEventListener("click", () => { removeItem(editingItem.id); $("itemModal").hidden = true; });

/* ============================================================
   마감 / 데드라인
   ============================================================ */
function renderDeadlines() {
  const wrap = $("deadlineList");
  wrap.innerHTML = "";
  const upcoming = state.deadlines
    .map((d) => ({ ...d, dd: daysBetween(todayKey, d.date) }))
    .filter((d) => d.dd >= 0 || (d.subtasks || []).some((s) => !s.done))  // 지난 것도 미완료면 표시
    .sort((a, b) => a.dd - b.dd);
  if (upcoming.length === 0) {
    wrap.innerHTML = `<div class="dl-empty">등록된 마감이 없어요. ＋ 로 추가하세요.</div>`;
    return;
  }
  for (const d of upcoming.slice(0, 5)) {
    const total = (d.subtasks || []).length;
    const done = (d.subtasks || []).filter((s) => s.done).length;
    const ddText = d.dd === 0 ? "D-DAY" : d.dd > 0 ? `D-${d.dd}` : `D+${-d.dd}`;
    const urgent = d.dd <= 3 && d.dd >= 0;
    const card = document.createElement("div");
    card.className = "dl-card" + (urgent ? " urgent" : "") + (d.dd < 0 ? " over" : "");
    card.innerHTML =
      `<div class="dl-dday ${catClass(d.category)}">${ddText}</div>` +
      `<div class="dl-body"><div class="dl-title">${escapeHtml(d.title) || "제목 없음"}</div>` +
      `<div class="dl-sub">${prettyDate(d.date)}${total ? ` · 단계 ${done}/${total}` : ""}</div></div>`;
    card.onclick = () => openDeadlineModal(d);
    wrap.appendChild(card);
  }
}

let editingDeadline = null;
function openDeadlineModal(d) {
  if (!d) { d = { id: uid(), title: "", date: selectedKey || todayKey, category: "etc", subtasks: [] }; state.deadlines.push(d); save(); }
  editingDeadline = d;
  $("dlTitle").value = d.title || "";
  $("dlDate").value = d.date || todayKey;
  buildDlCats();
  renderSubtasks();
  $("deadlineModal").hidden = false;
}
function buildDlCats() {
  renderCatChoose($("dlCats"), editingDeadline.category, (c) => {
    editingDeadline.category = c; save(); buildDlCats(); renderDeadlines(); renderCalendar();
  });
}
function renderSubtasks() {
  const wrap = $("dlSubList"); wrap.innerHTML = "";
  for (const s of editingDeadline.subtasks) {
    const row = document.createElement("div");
    row.className = "sub-row" + (s.done ? " done" : "");
    const chk = document.createElement("div");
    chk.className = "block-check sm" + (s.done ? " checked" : "");
    chk.onclick = () => { s.done = !s.done; save(); renderSubtasks(); renderDeadlines(); };
    const inp = document.createElement("input");
    inp.className = "sub-input"; inp.value = s.text; inp.placeholder = "단계 이름";
    inp.oninput = () => { s.text = inp.value; save(); };
    const del = document.createElement("button");
    del.className = "block-del"; del.textContent = "✕";
    del.onclick = () => { editingDeadline.subtasks = editingDeadline.subtasks.filter((x) => x !== s); save(); renderSubtasks(); renderDeadlines(); };
    row.append(chk, inp, del);
    wrap.appendChild(row);
  }
}
$("dlTitle").addEventListener("input", () => { editingDeadline.title = $("dlTitle").value; save(); renderDeadlines(); renderCalendar(); });
$("dlDate").addEventListener("input", () => { editingDeadline.date = $("dlDate").value; save(); renderDeadlines(); renderCalendar(); });
$("dlAddSub").addEventListener("click", () => { editingDeadline.subtasks.push({ id: uid(), text: "", done: false }); save(); renderSubtasks(); });
$("deadlineDelete").addEventListener("click", () => {
  state.deadlines = state.deadlines.filter((x) => x !== editingDeadline);
  save(); $("deadlineModal").hidden = true; renderDeadlines(); renderCalendar();
});
$("addDeadline").addEventListener("click", () => openDeadlineModal(null));

/* ============================================================
   일지 (per date)
   ============================================================ */
const MOODS = ["😣", "🙁", "😐", "🙂", "😄"];
function renderJournal() {
  const j = state.journals[selectedKey] || { mood: 0, text: "" };
  const picker = $("moodPicker"); picker.innerHTML = "";
  MOODS.forEach((emo, i) => {
    const b = document.createElement("button");
    b.className = "mood" + (j.mood === i + 1 ? " on" : "");
    b.textContent = emo;
    b.onclick = () => {
      const cur = state.journals[selectedKey] || { mood: 0, text: $("journalBody").innerHTML };
      cur.mood = cur.mood === i + 1 ? 0 : i + 1;
      state.journals[selectedKey] = cur; save(); renderJournal();
    };
    picker.appendChild(b);
  });
  $("journalBody").innerHTML = j.text || "";
}
let journalTimer = null;
function saveJournal() {
  const cur = state.journals[selectedKey] || { mood: 0, text: "" };
  cur.text = $("journalBody").innerHTML;
  state.journals[selectedKey] = cur; save();
  $("journalSaved").textContent = "저장됨";
  setTimeout(() => ($("journalSaved").textContent = ""), 1200);
}
$("journalBody").addEventListener("input", () => { clearTimeout(journalTimer); journalTimer = setTimeout(saveJournal, 400); });
$("tplBtn").addEventListener("click", () => {
  const tpl = "<b>오늘 한 일</b><br><br><b>배운 것</b><br><br><b>내일 할 일</b><br><br>";
  const body = $("journalBody");
  body.innerHTML = (body.innerHTML && body.innerHTML !== "<br>") ? body.innerHTML + "<br>" + tpl : tpl;
  saveJournal();
});

/* ============================================================
   메모
   ============================================================ */
const memoModal = $("memoModal"), memoTitle = $("memoTitle"), memoBody = $("memoBody"), memoSaved = $("memoSaved");
let editingNoteId = null;

function noteById(id) { return state.notes.find((n) => n.id === id); }
function stripHtml(html) { const d = document.createElement("div"); d.innerHTML = html || ""; return (d.textContent || "").replace(/\s+/g, " ").trim(); }
function escapeHtml(s) { return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function fmtWhen(ts) {
  if (!ts) return "";
  const d = new Date(ts), sameYear = d.getFullYear() === today.getFullYear();
  return `${sameYear ? "" : d.getFullYear() + ". "}${d.getMonth() + 1}. ${d.getDate()}. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderMemoList() {
  const q = ($("memoSearch").value || "").toLowerCase();
  const memoListEl = $("memoList");
  memoListEl.innerHTML = "";
  let notes = [...state.notes];
  if (q) notes = notes.filter((n) => (n.title || "").toLowerCase().includes(q) || stripHtml(n.body).toLowerCase().includes(q));
  notes.sort((a, b) => (!!b.pinned - !!a.pinned) || (b.updated || 0) - (a.updated || 0));
  if (notes.length === 0) {
    memoListEl.innerHTML = `<div class="memo-empty"><span class="em-ico">🗒️</span>${q ? "검색 결과가 없어요." : "메모가 없어요. ＋ 로 추가해요."}</div>`;
    return;
  }
  for (const n of notes) {
    const card = document.createElement("div");
    card.className = "memo-card" + (n.pinned ? " pinned" : "");
    const link = n.linkDate ? `<span class="memo-link">📅 ${n.linkDate.slice(5)}</span>` : "";
    card.innerHTML =
      `${n.pinned ? '<span class="pin-mark">📌</span>' : ""}` +
      `<h4>${escapeHtml(n.title) || "제목 없음"}</h4>` +
      `<p>${escapeHtml(stripHtml(n.body)) || "내용 없음"}</p>` +
      `<span class="memo-date">${fmtWhen(n.updated)} ${link}</span>`;
    card.onclick = () => openMemo(n.id);
    memoListEl.appendChild(card);
  }
}
$("memoSearch").addEventListener("input", renderMemoList);

function openMemo(id) {
  editingNoteId = id;
  const n = noteById(id); if (!n) return;
  memoTitle.value = n.title || "";
  memoBody.innerHTML = n.body || "";
  $("memoLinkDate").value = n.linkDate || "";
  $("memoPin").classList.toggle("on", !!n.pinned);
  memoSaved.textContent = "저장됨"; memoSaved.classList.remove("dirty");
  memoModal.hidden = false;
  if (!n.title) memoTitle.focus({ preventScroll: true });
}
function closeMemo() { persistMemo(); editingNoteId = null; memoModal.hidden = true; renderMemoList(); }
function addMemo() { const n = { id: uid(), title: "", body: "", pinned: false, updated: Date.now(), linkDate: null }; state.notes.push(n); save(); openMemo(n.id); }
function persistMemo() {
  const n = noteById(editingNoteId); if (!n) return;
  n.title = memoTitle.value; n.body = memoBody.innerHTML; n.linkDate = $("memoLinkDate").value || null; n.updated = Date.now();
  save(); memoSaved.textContent = "저장됨"; memoSaved.classList.remove("dirty");
}
let memoTimer = null;
function onMemoEdit() { memoSaved.textContent = "입력 중…"; memoSaved.classList.add("dirty"); clearTimeout(memoTimer); memoTimer = setTimeout(persistMemo, 400); }
memoTitle.addEventListener("input", onMemoEdit);
memoBody.addEventListener("input", onMemoEdit);
$("memoLinkDate").addEventListener("input", onMemoEdit);
$("addMemo").addEventListener("click", addMemo);
$("memoPin").addEventListener("click", () => { const n = noteById(editingNoteId); if (!n) return; n.pinned = !n.pinned; $("memoPin").classList.toggle("on", n.pinned); save(); });
$("memoDelete").addEventListener("click", () => {
  state.notes = state.notes.filter((n) => n.id !== editingNoteId);
  save(); editingNoteId = null; memoModal.hidden = true; renderMemoList();
});

/* 메모 서식 툴바 */
document.querySelector(".memo-toolbar").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-cmd]"); if (!btn) return;
  const cmd = btn.dataset.cmd;
  memoBody.focus();
  if (cmd === "bold") document.execCommand("bold");
  else if (cmd === "bullet") document.execCommand("insertUnorderedList");
  else if (cmd === "link") { const url = prompt("링크 주소(URL)를 입력하세요:", "https://"); if (url) document.execCommand("createLink", false, url); }
  else if (cmd === "check") insertCheckbox();
  else if (cmd === "image") $("memoFile").click();
  onMemoEdit();
});
function insertCheckbox() {
  const html = `<div class="md-check"><input type="checkbox"> <span>할 일</span></div>`;
  document.execCommand("insertHTML", false, html);
}
memoBody.addEventListener("click", (e) => {
  if (e.target.matches('.md-check input[type="checkbox"]')) {
    e.target.closest(".md-check").classList.toggle("checked", e.target.checked);
    onMemoEdit();
  }
});
$("memoFile").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) insertImageFile(f); e.target.value = ""; });
memoBody.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (item) { e.preventDefault(); insertImageFile(item.getAsFile()); }
});
function insertImageFile(file) {
  const r = new FileReader();
  r.onload = () => { memoBody.focus(); document.execCommand("insertHTML", false, `<img src="${r.result}" alt="첨부 이미지">`); onMemoEdit(); };
  r.readAsDataURL(file);
}

/* ============================================================
   전체(통합) 검색
   ============================================================ */
const gSearch = $("globalSearch"), gResults = $("searchResults");
gSearch.addEventListener("input", () => {
  const q = gSearch.value.trim().toLowerCase();
  if (!q) { gResults.hidden = true; gResults.innerHTML = ""; return; }
  const res = [];
  for (const it of state.items)
    if ((it.text || "").toLowerCase().includes(q)) res.push({ type: "할 일", icon: "✓", label: it.text, date: it.date, action: () => jumpToDate(it.date) });
  for (const d of state.deadlines)
    if ((d.title || "").toLowerCase().includes(q)) res.push({ type: "마감", icon: "⏰", label: d.title, date: d.date, action: () => openDeadlineModal(d) });
  for (const n of state.notes)
    if ((n.title || "").toLowerCase().includes(q) || stripHtml(n.body).toLowerCase().includes(q)) res.push({ type: "메모", icon: "📝", label: n.title || stripHtml(n.body).slice(0, 20), date: null, action: () => openMemo(n.id) });
  for (const [date, j] of Object.entries(state.journals))
    if (stripHtml(j.text).toLowerCase().includes(q)) res.push({ type: "일지", icon: "📔", label: stripHtml(j.text).slice(0, 24), date, action: () => jumpToDate(date) });

  gResults.innerHTML = "";
  if (res.length === 0) { gResults.innerHTML = `<div class="sr-empty">검색 결과 없음</div>`; }
  else for (const r of res.slice(0, 12)) {
    const row = document.createElement("div");
    row.className = "sr-row";
    row.innerHTML = `<span class="sr-ico">${r.icon}</span><span class="sr-type">${r.type}</span><span class="sr-label">${escapeHtml(r.label) || "(빈 항목)"}</span>${r.date ? `<span class="sr-date">${r.date.slice(5)}</span>` : ""}`;
    row.onclick = () => { r.action(); gResults.hidden = true; gSearch.value = ""; };
    gResults.appendChild(row);
  }
  gResults.hidden = false;
});
document.addEventListener("click", (e) => { if (!e.target.closest(".global-search")) gResults.hidden = true; });
function jumpToDate(key) {
  const d = parseKey(key);
  viewYear = d.getFullYear(); viewMonth = d.getMonth();
  renderCalendar(); selectDate(key);
}

/* ============================================================
   헤더 / 모달 공통 / 단축키
   ============================================================ */
$("prevBtn").onclick = () => { const p = prevMY(); viewYear = p.y; viewMonth = p.m; renderCalendar(); };
$("nextBtn").onclick = () => { const n = nextMY(); viewYear = n.y; viewMonth = n.m; renderCalendar(); };
$("todayBtn").onclick = () => { viewYear = today.getFullYear(); viewMonth = today.getMonth(); renderCalendar(); selectDate(todayKey); };
$("addBlock").onclick = addBlock;

/* 우측 패널 탭 전환 */
document.querySelectorAll(".ptab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const name = tab.dataset.tab;
    document.querySelectorAll(".ptab").forEach((t) => t.classList.toggle("on", t === tab));
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === name));
  });
});

document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => {
  const id = b.dataset.close;
  if (id === "memoModal") closeMemo(); else $(id).hidden = true;
}));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!memoModal.hidden) closeMemo();
    else document.querySelectorAll(".modal:not([hidden])").forEach((m) => (m.hidden = true));
  }
});

/* ============================================================
   초기 실행 / 시드
   ============================================================ */
function seedIfEmpty() {
  if (state.items.length === 0 && state.deadlines.length === 0 && state.notes.length === 0) {
    state.items.push(
      { id: uid(), text: "랩미팅", date: todayKey, start: "14:00", end: "15:00", categories: ["meeting"], star: true, done: false, doneDates: {}, recur: { freq: "weekly", until: null } },
      { id: uid(), text: "논문 읽기", date: todayKey, start: null, end: null, categories: ["personal"], star: false, done: false, doneDates: {}, recur: null },
    );
    const d2 = parseKey(todayKey); d2.setDate(d2.getDate() + 7);
    state.deadlines.push({ id: uid(), title: "졸업논문 초고 제출", date: keyOf(d2.getFullYear(), d2.getMonth(), d2.getDate()), category: "class", subtasks: [{ id: uid(), text: "초고", done: true }, { id: uid(), text: "수정", done: false }, { id: uid(), text: "제출", done: false }] });
    state.notes.push({ id: uid(), title: "환영해요 🌤", body: "여기는 메모 공간이에요.<br>굵게·목록·체크박스·링크·이미지를 쓸 수 있어요.", pinned: true, updated: Date.now(), linkDate: null });
    // 시드는 '실제 편집'이 아니므로 _updatedAt(0)을 올리지 않는다 → 클라우드 실데이터가 항상 우선됨
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }
}

/* ============================================================
   백업 / 복원 — JSON 내보내기·가져오기
   ============================================================ */
function exportData() {
  const json = JSON.stringify(state, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `다담-백업-${todayKey}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  backupMsg("✅ 백업 파일을 내려받았습니다.");
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try { parsed = JSON.parse(reader.result); }
    catch { backupMsg("❌ JSON 파일을 읽을 수 없습니다.", true); return; }
    // 최소한의 형식 검증
    if (!parsed || typeof parsed !== "object" || !("items" in parsed) || !("notes" in parsed)) {
      backupMsg("❌ 다담 백업 파일이 아닌 것 같습니다.", true); return;
    }
    const cnt = (parsed.items?.length || 0) + (parsed.deadlines?.length || 0) + (parsed.notes?.length || 0);
    if (!confirm(`현재 데이터를 이 백업으로 덮어씁니다.\n(일정·할일·마감·메모 약 ${cnt}건)\n계속할까요?`)) return;

    window.Dadam.replaceState(parsed);  // 화면 교체 + localStorage 기록
    save();                             // _updatedAt 갱신 + 클라우드 푸시(로그인 시)
    backupMsg("✅ 복원 완료. 모든 기기에 반영됩니다.");
  };
  reader.readAsText(file);
}

function backupMsg(text, isErr) {
  const el = $("backupMsg");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

$("backupBtn").addEventListener("click", () => { backupMsg(""); $("backupModal").hidden = false; });
$("exportBtn").addEventListener("click", exportData);
$("importBtn").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) importData(f);
  e.target.value = "";  // 같은 파일 다시 선택 가능하게
});

/* ============================================================
   카테고리 설정 (추가 / 이름 변경 / 색 / 삭제)
   ============================================================ */
function openSettings() { renderCatSettings(); $("settingsModal").hidden = false; }
function refreshCats() { renderCatFilter(); renderCalendar(); renderDayPanel(); }

function renderCatSettings() {
  const wrap = $("catSettingsList");
  wrap.innerHTML = "";
  if (state.categories.length === 0)
    wrap.innerHTML = `<p class="cat-empty">아직 카테고리가 없어요. 아래에서 추가하세요.</p>`;
  state.categories.forEach((cat) => {
    const row = document.createElement("div");
    row.className = "cat-set-row";

    const inp = document.createElement("input");
    inp.className = "cat-name-input";
    inp.value = cat.label; inp.placeholder = "카테고리 이름";
    inp.oninput = () => { cat.label = inp.value; save(); refreshCats(); };

    const sw = document.createElement("div");
    sw.className = "cat-swatches";
    PALETTE.forEach((col) => {
      const s = document.createElement("button");
      s.className = `cat-sw c-${col}` + (cat.color === col ? " on" : "");
      s.title = col;
      s.onclick = () => { cat.color = col; save(); renderCatSettings(); refreshCats(); };
      sw.appendChild(s);
    });

    const del = document.createElement("button");
    del.className = "cat-del"; del.textContent = "🗑"; del.title = "삭제";
    del.onclick = () => deleteCategory(cat);

    row.append(inp, sw, del);
    wrap.appendChild(row);
  });
}
function addCategory() {
  state.categories.push({ id: uid(), label: "새 카테고리", color: PALETTE[state.categories.length % PALETTE.length] });
  save(); renderCatSettings(); refreshCats();
}
function deleteCategory(cat) {
  if (!confirm(`'${cat.label || "이 카테고리"}'를 삭제할까요?\n할 일·마감에서도 제거됩니다.`)) return;
  state.categories = state.categories.filter((c) => c.id !== cat.id);
  for (const it of state.items) it.categories = (it.categories || []).filter((c) => c !== cat.id);
  for (const d of state.deadlines) if (d.category === cat.id) d.category = null;
  activeCats.delete(cat.id);
  save(); renderCatSettings(); refreshCats();
}
$("addCatBtn").addEventListener("click", addCategory);

/* 전체 화면 다시 그리기 — 클라우드에서 데이터를 받아온 뒤에도 호출 */
function renderAll() {
  renderCatFilter();
  renderCalendar();
  renderDeadlines();
  selectDate(selectedKey || todayKey);
  renderMemoList();
}

/* 동기화 모듈(sync.js)이 사용할 인터페이스 */
window.Dadam = {
  STORE_KEY,
  getState: () => state,
  /* 클라우드 데이터로 현재 상태를 통째로 교체하고 다시 그린다 */
  replaceState(next) {
    if (!next || typeof next !== "object") return;
    state = normalizeState(next);
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    renderAll();
  },
  renderAll,
};

seedIfEmpty();
renderAll();
