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
  s.inbox    ||= [];  // 임시 메모 블럭 [{id,text}]
  s.weekly   ||= {};  // 주 단위: { 일요일키: [{id,text}] }
  s.monthly  ||= {};  // 월 단위: { "YYYY-MM": [{id,text}] }
  s.projects ||= [];  // 프로젝트 [{id,name,collapsed}] — 할 일은 items에 projectId로 연결(카테고리와 별개)
  for (const it of s.items) {
    if (!Array.isArray(it.categories)) it.categories = it.category != null ? [it.category] : [];
    if (!Array.isArray(it.subtasks)) it.subtasks = [];
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
  if (it.recur) {
    if (key < it.date) return false;
    if (it.recur.until && key > it.recur.until) return false;
    if (parseKey(key).getDay() !== parseKey(it.date).getDay()) return false;
    const weeks = Math.round(daysBetween(it.date, key) / 7);
    const interval = it.recur.freq === "biweekly" ? 2 : 1;
    return weeks % interval === 0;
  }
  // 비반복: 단일 날짜 또는 기간(endDate까지). 날짜 문자열은 사전식 비교로 충분
  const end = it.endDate || it.date;
  return key >= it.date && key <= end;
}
const isRange = (it) => !!(it.endDate && it.endDate !== it.date);

/* ---------- 인라인 문법: #태그(카테고리) · 시간 자동 인식 ----------
   "#수업 12시 랩미팅" → 카테고리 수업 + 시작 12:00, 텍스트 "랩미팅" */
function resolveCategory(name) {
  let cat = state.categories.find((c) => c.label.toLowerCase() === name.toLowerCase());
  if (!cat) { cat = { id: uid(), label: name, color: PALETTE[state.categories.length % PALETTE.length] }; state.categories.push(cat); }
  return cat.id;
}
function parseTime(text) {
  const apOf = (s) => (/오후|pm/i.test(s || "") ? 1 : (/오전|am/i.test(s || "") ? 0 : -1));
  const pats = [
    /(오전|오후|am|pm)?\s*(\d{1,2}):(\d{2})/i,        // 12:30
    /(오전|오후|am|pm)?\s*(\d{1,2})시\s*반/i,          // 12시 반
    /(오전|오후|am|pm)?\s*(\d{1,2})시\s*(\d{1,2})\s*분/i, // 12시 30분
    /(오전|오후|am|pm)?\s*(\d{1,2})\s*시(?!간)/i,      // 12시 (시간/시작 제외)
  ];
  for (let i = 0; i < pats.length; i++) {
    const m = text.match(pats[i]);
    if (!m) continue;
    let h = parseInt(m[2], 10), min = 0;
    if (i === 0 || i === 2) min = parseInt(m[3], 10);
    else if (i === 1) min = 30;
    const ap = apOf(m[1]);
    if (ap === 1 && h < 12) h += 12;        // 오후
    else if (ap === 0 && h === 12) h = 0;   // 오전 12시 = 0시
    if (h > 23 || min > 59) continue;
    return { start: `${pad(h)}:${pad(min)}`, matched: m[0] };
  }
  return null;
}
function applyInlineSyntax(t) {
  let text = t.text || "", changed = false;
  const tm = parseTime(text);
  if (tm) { t.start = tm.start; text = text.replace(tm.matched, " "); changed = true; }
  const tags = [];
  text = text.replace(/#([^\s#]+)/g, (m, name) => { tags.push(name); changed = true; return " "; });
  if (tags.length) {
    t.categories ||= [];
    for (const nm of tags) { const id = resolveCategory(nm); if (!t.categories.includes(id)) t.categories.push(id); }
  }
  if (changed) t.text = text.replace(/\s{2,}/g, " ").trim();
  return changed;
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
    if (isRange(a) !== isRange(b)) return isRange(a) ? -1 : 1;  // 기간 작업 먼저(위로)
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
/* 공휴일 / 24절기 (kdata.js) */
function holidayOf(key) {
  const k = window.KDATA;
  if (!k) return null;
  if (k.holi[key]) return k.holi[key];          // 음력·대체 우선
  const md = key.slice(5);
  return k.fixed[md] || null;                    // 고정 공휴일
}
function termOf(key) { return (window.KDATA && window.KDATA.term[key]) || null; }

function prevMY() { return viewMonth === 0 ? { y: viewYear - 1, m: 11 } : { y: viewYear, m: viewMonth - 1 }; }
function nextMY() { return viewMonth === 11 ? { y: viewYear + 1, m: 0 } : { y: viewYear, m: viewMonth + 1 }; }

function renderCalendar(dir) {
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
  // 월 이동 시 스르륵 슬라이드
  if (dir) { grid.classList.remove("slide-up", "slide-down"); void grid.offsetWidth; grid.classList.add(dir === "down" ? "slide-up" : "slide-down"); }
  scheduleTrim();
}

/* 셀에 들어가는 만큼만 칩 표시, 넘치면 "+N개 더" */
let trimScheduled = false;
function scheduleTrim() {
  if (trimScheduled) return;
  trimScheduled = true;
  requestAnimationFrame(() => { trimScheduled = false; trimDayChips(); });
}
function trimDayChips() {
  grid.querySelectorAll(".day").forEach((cell) => {
    const box = cell.querySelector(".day-chips");
    if (!box) return;
    box.querySelectorAll(".day-more").forEach((m) => m.remove());
    const chips = [...box.children];
    chips.forEach((c) => c.classList.remove("hidden-chip"));
    const avail = box.clientHeight;
    if (avail <= 0 || chips.length === 0) return;
    const boxTop = box.getBoundingClientRect().top;
    let firstHidden = -1;
    for (let i = 0; i < chips.length; i++) {
      if (chips[i].getBoundingClientRect().bottom - boxTop > avail + 0.5) { firstHidden = i; break; }
    }
    if (firstHidden === -1) return;   // 전부 들어감
    const labelH = 17;                // "+N개 더" 줄 높이 확보
    while (firstHidden > 0) {
      const prevBottom = chips[firstHidden - 1].getBoundingClientRect().bottom - boxTop;
      if (prevBottom + labelH <= avail) break;
      firstHidden--;
    }
    for (let j = firstHidden; j < chips.length; j++) chips[j].classList.add("hidden-chip");
    const more = document.createElement("div");
    more.className = "day-more";
    more.textContent = `+${chips.length - firstHidden}개 더`;
    box.appendChild(more);
  });
}
let trimResizeTimer = null;
window.addEventListener("resize", () => { clearTimeout(trimResizeTimer); trimResizeTimer = setTimeout(trimDayChips, 150); });

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
  // 공휴일 / 절기 라벨
  const hol = holidayOf(key), term = termOf(key);
  if (hol) el.classList.add("is-holiday");
  if (hol || term) {
    const lab = document.createElement("span");
    lab.className = "day-label " + (hol ? "holiday" : "term");
    lab.textContent = hol || term;
    top.appendChild(lab);
  }
  const tools = document.createElement("div");
  tools.className = "day-tools";
  // 일지 작성 표시 — 글이 있거나 기분이 찍혀 있으면 작은 아이콘
  const jr = state.journals[key];
  if (jr && (jr.mood || stripHtml(jr.text))) {
    const ji = document.createElement("button");
    ji.className = "journal-ind";
    ji.textContent = jr.mood ? MOODS[jr.mood - 1] : "📔";
    ji.title = "일지 보기";
    ji.onclick = (e) => { e.stopPropagation(); selectDate(key); if (isMobile()) openDaySheet(); };
    tools.appendChild(ji);
  }
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
    tools.appendChild(mi);
  }
  // 이 날에 할 일 추가
  const add = document.createElement("button");
  add.className = "day-add"; add.textContent = "＋"; add.title = "이 날에 일정 추가(상세창)";
  add.onclick = (e) => { e.stopPropagation(); addItemOnDate(key); };
  tools.appendChild(add);
  top.appendChild(tools);
  el.appendChild(top);

  const chips = document.createElement("div");
  chips.className = "day-chips";
  // 마감 칩 (제목 + D-day) 먼저
  const dls = state.deadlines.filter((d) => d.date === key);
  for (const d of dls) chips.appendChild(makeDeadlineChip(d));
  // 일정/할 일 칩 — 일단 전부 넣고, 렌더 후 셀 높이에 맞춰 잘라냄(trimDayChips)
  const items = itemsForDate(key);
  for (const t of items) chips.appendChild(makeChip(t, key));
  el.appendChild(chips);

  el.addEventListener("click", (e) => {
    if (e.target.closest(".chip")) return;
    if (suppressDayClick) { suppressDayClick = false; return; }   // 기간 드래그/스와이프 직후 클릭 무시
    selectDate(key);
    if (isMobile()) openDaySheet();   // 모바일: 그 날 상세를 하단 시트로
  });
  // 빈 영역 더블클릭 → 그 날짜에 일정 추가(상세창)
  el.addEventListener("dblclick", (e) => {
    if (e.target.closest(".chip") || e.target.closest("button")) return;
    addItemOnDate(key);
  });
  // 빈 영역 드래그 → 기간 선택
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest(".chip") || e.target.closest("button") || e.target.closest(".memo-ind")) return;
    rangeStartKey = key; rangeEndKey = key; rangeMoved = false;
    e.preventDefault();   // 텍스트 선택 방지
  });
  el.addEventListener("mouseenter", () => {
    if (rangeStartKey == null) return;
    rangeEndKey = key;
    if (key !== rangeStartKey) rangeMoved = true;
    highlightRange(rangeStartKey, key);
  });
  setupDropTarget(el, key);
  return el;
}

/* ---------- 날짜 범위 드래그(기간 작업 만들기) ---------- */
let rangeStartKey = null, rangeEndKey = null, rangeMoved = false, suppressDayClick = false;
function highlightRange(aKey, bKey) {
  const [s, e] = [aKey, bKey].sort();
  document.querySelectorAll(".day").forEach((d) => {
    const k = d.dataset.key;
    d.classList.toggle("range-sel", k >= s && k <= e);
  });
}
function clearRangeHighlight() {
  document.querySelectorAll(".day.range-sel").forEach((d) => d.classList.remove("range-sel"));
}
function createRangeTask(aKey, bKey) {
  const [s, e] = [aKey, bKey].sort();
  const it = { id: uid(), text: "", date: s, endDate: e !== s ? e : null, start: null, end: null, categories: [], note: "", star: false, done: false, doneDates: {}, recur: null };
  state.items.push(it);
  save(); renderCalendar(); selectDate(s);
  openItemModal(it);                                  // 상세 모달에서 이름·메모 입력
  requestAnimationFrame(() => $("itemText").focus());
}
/* 날짜 칸 ＋ → 그 날짜에 일정 만들고 상세창 열기 */
function addItemOnDate(key) {
  const it = { id: uid(), text: "", date: key, endDate: null, start: null, end: null, categories: [], note: "", star: false, done: false, doneDates: {}, recur: null };
  state.items.push(it);
  save(); selectDate(key);
  openItemModal(it);
  requestAnimationFrame(() => $("itemText").focus());
}
document.addEventListener("mouseup", () => {
  if (rangeStartKey == null) return;
  const s = rangeStartKey, e = rangeEndKey;
  rangeStartKey = null; rangeEndKey = null;
  clearRangeHighlight();
  if (rangeMoved && e && e !== s) {
    suppressDayClick = true;
    createRangeTask(s, e);
    setTimeout(() => { suppressDayClick = false; }, 0);   // 혹시 안 쓰이면 자동 해제
  }
  rangeMoved = false;
});

function makeChip(t, key) {
  const chip = document.createElement("div");
  const cats = (t.categories || []).map(catById).filter(Boolean);
  const range = isRange(t);
  const isStart = key === t.date;
  const isEnd = key === (t.endDate || t.date);
  const weekStart = parseKey(key).getDay() === 0;
  const done = isDone(t, key);
  let cls = `chip item-chip ${cats[0] ? colorClass(cats[0].color) : "c-sky"}` + (done ? " done" : "");
  if (range) cls += " range-chip" + (isStart ? " r-start" : "") + (isEnd ? " r-end" : "");
  chip.className = cls;
  const proj = t.projectId ? projectById(t.projectId) : null;
  chip.title = (t.text || "(빈 항목)") + (range ? ` · ${t.date.slice(5)}~${(t.endDate).slice(5)}` : "") + (cats.length ? ` · ${cats.map((c) => c.label).join(", ")}` : "") + (proj ? ` · 📁${proj.name || "프로젝트"}` : "");

  // 칩 클릭 → 상세 모달(메모 포함)
  chip.addEventListener("click", (e) => { e.stopPropagation(); selectDate(key); openItemModal(t); });

  // 기간 연속 바(시작·주 시작 아닌 날): 라벨/체크박스 없는 바
  if (range && !isStart && !weekStart) {
    chip.innerHTML = `&nbsp;`;
    return chip;
  }

  const time = t.start ? `<span class="c-meta"><b>${t.start}</b> </span>` : "";
  const star = t.star ? `<span class="c-meta">★ </span>` : "";
  const rec = t.recur ? `<span class="c-meta"> ↻</span>` : "";
  const dots = cats.length
    ? `<span class="chip-cats">${cats.map((c) => `<i class="cdot ${colorClass(c.color)}"></i>`).join("")}</span>`
    : "";
  const noteIco = (t.note && t.note.trim()) ? `<span class="chip-note">📝</span>` : "";
  chip.innerHTML =
    `<span class="chip-check${done ? " on" : ""}" title="완료 표시"></span>` +
    `<span class="chip-label">${star}${time}${escapeHtml(t.text) || "(빈 항목)"}${rec}</span>` +
    `<span class="chip-right">${dots}${noteIco}</span>`;

  // 왼쪽 체크박스 → 완료 토글 (모달은 안 열림)
  chip.querySelector(".chip-check").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDone(t, key); save(); renderCalendar(); renderDayPanel();
  });

  if (!t.recur && !range) {
    chip.draggable = true;
    chip.dataset.id = t.id;
    chip.addEventListener("dragstart", (e) => {
      const copy = e.ctrlKey || e.metaKey;
      dragData = { id: t.id, from: key, copy };
      chip.classList.add("dragging");
      e.dataTransfer.effectAllowed = "copyMove";
      const img = new Image(); img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
      e.dataTransfer.setDragImage(img, 0, 0);
      showGhost((copy ? "+ " : "") + (t.text || "(빈 항목)"));
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
  el.addEventListener("dragover", (e) => {
    if (!dragData) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = (e.ctrlKey || e.metaKey || dragData.copy) ? "copy" : "move";
    el.classList.add("drop-target");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
  el.addEventListener("drop", (e) => {
    e.preventDefault(); el.classList.remove("drop-target");
    if (!dragData) return;
    // 빠른 메모 블럭 → 그 날짜의 할 일로 이동
    if (dragData.type === "panelBlock") {
      const text = (dragData.text || "").trim();
      if (text) {
        const it = { id: uid(), text, date: key, endDate: null, start: null, end: null, categories: [], note: "", subtasks: [], star: false, done: false, doneDates: {}, recur: null };
        applyInlineSyntax(it);   // #태그·시간 자동 적용
        state.items.push(it);
      }
      dragData.remove();
      save(); renderCalendar(); renderDayPanel(); renderCatFilter();
      dragData = null;
      return;
    }
    // 프로젝트 할 일 → 이 날짜로 일정 잡기(프로젝트에 그대로 남고 캘린더에도 표시)
    if (dragData.type === "projectTodo") {
      const it = state.items.find((x) => x.id === dragData.id);
      if (it) { it.date = key; it.endDate = null; save(); renderCalendar(); renderDayPanel(); renderQuickPanel(); }
      dragData = null;
      return;
    }
    // 할 일 칩: Ctrl/⌘ → 복사, 아니면 이동
    const it = state.items.find((x) => x.id === dragData.id);
    if (it) {
      const copy = e.ctrlKey || e.metaKey || dragData.copy;
      if (copy) state.items.push(cloneItem(it, key));
      else if (dragData.from !== key) it.date = key;
      save(); renderCalendar(); renderDayPanel();
    }
    dragData = null;
  });
}
/* 항목 복제(다른 날짜로 복사) — 단일 작업만 드래그 가능 */
function cloneItem(src, newDate) {
  return {
    id: uid(), text: src.text, date: newDate, endDate: null,
    start: src.start, end: src.end,
    categories: [...(src.categories || [])],
    note: src.note || "",
    subtasks: (src.subtasks || []).map((s) => ({ id: uid(), text: s.text, done: s.done })),
    star: src.star, done: false, doneDates: {}, recur: null,
  };
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
  renderQuickPanel();
}

/* ============================================================
   스마트 입력 — #카테고리 드롭다운 + 시간 인식 색칠
   (한글 IME 보호: 연속 재렌더 없이 이산 이벤트만 사용)
   ============================================================ */
let tagMenuEl = null, tagMenuEditEl = null, tagMenuInsert = null, tagMenuIndex = 0, tagMenuItems = [], tagMenuMode = "cat";

function setupSmartInput(textEl, t) {
  textEl.addEventListener("input", () => { t.text = textEl.textContent; save(); updateTagMenu(textEl, t); });
  textEl.addEventListener("blur", () => {
    setTimeout(() => { if (tagMenuEditEl === textEl) hideTagMenu(); }, 150);
    if (applyInlineSyntax(t)) { save(); renderDayPanel(); renderCatFilter(); }
    renderCalendar();
  });
  textEl.addEventListener("keydown", (e) => {
    const menuOpen = tagMenuEl && !tagMenuEl.hidden && tagMenuEditEl === textEl;
    if (menuOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); moveTagMenu(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); moveTagMenu(-1); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseTagMenu(); return; }
      if (e.key === "Escape") { e.preventDefault(); hideTagMenu(); return; }
    }
    if (e.key === "Enter") { e.preventDefault(); hideTagMenu(); textEl.blur(); addBlock(); return; }
    if (e.key === "Backspace" && textEl.textContent === "") { e.preventDefault(); removeItem(t.id); return; }
    if (e.key === " " && !e.isComposing) flashTimeIfRecognized(textEl, t);
  });
}

/* 시간 표현이 있으면 블럭을 잠깐 색칠해 '인식됨'을 알림 + 시작시간 설정 */
function flashTimeIfRecognized(textEl, t) {
  const tm = parseTime(textEl.textContent || "");
  if (!tm) return;
  t.start = tm.start; save();
  const block = textEl.closest(".block");
  if (block) { block.classList.remove("time-flash"); void block.offsetWidth; block.classList.add("time-flash"); }
}

/* ----- #카테고리 드롭다운 ----- */
function getTagContext(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!r.collapsed || !el.contains(r.endContainer) || r.endContainer.nodeType !== 3) return null;
  const before = r.endContainer.textContent.slice(0, r.endOffset);
  const m = before.match(/([#~])([^\s#~]*)$/);
  if (!m) return null;
  return { node: r.endContainer, start: r.endOffset - m[0].length, end: r.endOffset, partial: m[2], trigger: m[1] };
}
function ensureTagMenu() {
  if (tagMenuEl) return tagMenuEl;
  tagMenuEl = document.createElement("div");
  tagMenuEl.className = "tag-menu"; tagMenuEl.id = "tagMenu"; tagMenuEl.hidden = true;
  tagMenuEl.addEventListener("mousedown", (e) => e.preventDefault());   // 입력칸 blur 방지
  document.body.appendChild(tagMenuEl);
  return tagMenuEl;
}
/* contenteditable(블럭)용 */
function updateTagMenu(textEl, t) {
  const ctx = getTagContext(textEl);
  if (!ctx) { hideTagMenu(); return; }
  if (ctx.trigger === "~")
    showProjMenuFor(textEl, ctx.partial, () => caretRect(textEl), (proj) => insertProjectToken(textEl, ctx, proj, t));
  else
    showTagMenuFor(textEl, ctx.partial, () => caretRect(textEl), (cat) => insertCategoryChip(textEl, ctx, cat, t));
}
/* 빠른 블럭(평문)에서 ~프로젝트 → 프로젝트 할 일로 승격 + 이 목록엔 링크로 남김 */
function updateProjMenuBlock(txt, blk, list) {
  const ctx = getTagContext(txt);
  if (!ctx || ctx.trigger !== "~") { if (tagMenuEditEl === txt && tagMenuMode === "proj") hideTagMenu(); return; }
  showProjMenuFor(txt, ctx.partial, () => caretRect(txt), (proj) => {
    const clean = (blk.text || "").replace(/~[^\s~]*$/, "").trim();
    const it = { id: uid(), text: clean, date: null, endDate: null, start: null, end: null, categories: [], note: "", subtasks: [], star: false, done: false, doneDates: {}, recur: null, projectId: proj.id };
    state.items.push(it);
    const i = list.indexOf(blk); if (i >= 0) list.splice(i, 1, { id: uid(), ref: it.id });
    save(); hideTagMenu(); renderQuickPanel(); renderCalendar(); renderDayPanel();
  });
}
function caretRect(fallbackEl) {
  const s = window.getSelection();
  let r = s.rangeCount ? s.getRangeAt(0).getBoundingClientRect() : null;
  if (!r || (r.width === 0 && r.height === 0)) r = fallbackEl.getBoundingClientRect();
  return r;
}
/* 공통: 메뉴 항목 구성 + 열기 (insertFn은 선택 시 실행) */
function showTagMenuFor(editEl, partial, rectFn, insertFn) {
  tagMenuEditEl = editEl; tagMenuInsert = insertFn; tagMenuMode = "cat";
  const q = partial.toLowerCase();
  tagMenuItems = state.categories.filter((c) => c.label.toLowerCase().includes(q)).map((c) => ({ cat: c }));
  if (partial && !state.categories.some((c) => c.label.toLowerCase() === q)) tagMenuItems.push({ newName: partial });
  if (!tagMenuItems.length) { hideTagMenu(); return; }
  tagMenuIndex = 0;
  renderTagMenu(); positionTagMenu(rectFn());
}
/* ~프로젝트 드롭다운 (완료된 프로젝트는 제외) */
function showProjMenuFor(editEl, partial, rectFn, insertFn) {
  tagMenuEditEl = editEl; tagMenuInsert = insertFn; tagMenuMode = "proj";
  const q = partial.toLowerCase();
  tagMenuItems = (state.projects || []).filter((p) => !p.done && (p.name || "").toLowerCase().includes(q)).map((p) => ({ proj: p }));
  if (partial && !(state.projects || []).some((p) => (p.name || "").toLowerCase() === q)) tagMenuItems.push({ newProjName: partial });
  if (!tagMenuItems.length) { hideTagMenu(); return; }
  tagMenuIndex = 0;
  renderTagMenu(); positionTagMenu(rectFn());
}
function createProject(name) { const p = { id: uid(), name: name || "", collapsed: false, done: false }; state.projects.push(p); save(); return p.id; }
function renderTagMenu() {
  const el = ensureTagMenu();
  el.innerHTML = "";
  tagMenuItems.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "tag-row" + (i === tagMenuIndex ? " on" : "");
    row.innerHTML =
      it.cat         ? `<i class="dot ${colorClass(it.cat.color)}"></i><span>${escapeHtml(it.cat.label)}</span>`
      : it.proj      ? `<span class="tr-ico">📁</span><span>${escapeHtml(it.proj.name) || "(이름 없음)"}</span>`
      : it.newProjName ? `<span class="tr-ico">📁</span><span>＋ '${escapeHtml(it.newProjName)}' 새 프로젝트</span>`
      :                `<i class="dot c-slate"></i><span>＋ '${escapeHtml(it.newName)}' 새 카테고리</span>`;
    row.addEventListener("mousedown", (e) => { e.preventDefault(); tagMenuIndex = i; chooseTagMenu(); });
    el.appendChild(row);
  });
  el.hidden = false;
}
function positionTagMenu(rect) {
  const el = tagMenuEl;
  let left = Math.min(rect.left, window.innerWidth - el.offsetWidth - 10);
  let top = rect.bottom + 4;
  if (top + el.offsetHeight > window.innerHeight - 8) top = rect.top - el.offsetHeight - 4;
  el.style.left = Math.max(8, left) + "px";
  el.style.top = Math.max(8, top) + "px";
}
function moveTagMenu(d) { tagMenuIndex = (tagMenuIndex + d + tagMenuItems.length) % tagMenuItems.length; renderTagMenu(); }
function hideTagMenu() { if (tagMenuEl) tagMenuEl.hidden = true; tagMenuInsert = null; }
function chooseTagMenu() {
  if (!tagMenuItems.length || !tagMenuInsert) return;
  const it = tagMenuItems[tagMenuIndex];
  if (tagMenuMode === "proj") {
    const pid = it.proj ? it.proj.id : createProject(it.newProjName);
    tagMenuInsert(projectById(pid));
    hideTagMenu();
    return;
  }
  const id = it.cat ? it.cat.id : resolveCategory(it.newName);
  const cat = state.categories.find((c) => c.id === id);
  tagMenuInsert(cat);
  hideTagMenu();
}
/* ~프로젝트 토큰 제거 + 항목에 프로젝트 지정 (칩은 blur 후 메타로 표시됨) */
function insertProjectToken(el, ctx, proj, t) {
  const node = ctx.node, full = node.textContent;
  const before = full.slice(0, ctx.start), after = full.slice(ctx.end);
  node.textContent = before + after;
  const pos = Math.min(before.length, node.textContent.length);
  try { const range = document.createRange(); range.setStart(node, pos); range.collapse(true); const s = window.getSelection(); s.removeAllRanges(); s.addRange(range); } catch {}
  t.projectId = proj.id; t.text = el.textContent; save();
}
/* <input>(상세창 제목)용 — 인라인 칩 대신 값에 #이름 삽입 + 카테고리 지정 */
function setupSmartField(inputEl, getItem) {
  inputEl.addEventListener("input", () => updateTagMenuField(inputEl, getItem));
  inputEl.addEventListener("keydown", (e) => {
    const menuOpen = tagMenuEl && !tagMenuEl.hidden && tagMenuEditEl === inputEl;
    if (menuOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); moveTagMenu(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); moveTagMenu(-1); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseTagMenu(); return; }
      if (e.key === "Escape") { e.preventDefault(); hideTagMenu(); return; }
    }
    if (e.key === " " && !e.isComposing) {
      const t = getItem(); if (!t) return;
      const tm = parseTime(inputEl.value || "");
      if (tm) { t.start = tm.start; save(); $("itemStart").value = tm.start; inputEl.classList.remove("time-flash"); void inputEl.offsetWidth; inputEl.classList.add("time-flash"); }
    }
  });
  inputEl.addEventListener("blur", () => { setTimeout(() => { if (tagMenuEditEl === inputEl) hideTagMenu(); }, 150); });
}
function updateTagMenuField(inputEl, getItem) {
  const pos = inputEl.selectionStart;
  const before = inputEl.value.slice(0, pos);
  const m = before.match(/([#~])([^\s#~]*)$/);
  if (!m) { hideTagMenu(); return; }
  const start = pos - m[0].length, end = pos;
  if (m[1] === "~") {
    showProjMenuFor(inputEl, m[2], () => inputEl.getBoundingClientRect(), (proj) => {
      const t = getItem(); if (!t) return;
      const v = inputEl.value;
      inputEl.value = (v.slice(0, start) + v.slice(end)).replace(/\s+$/, (s) => s.slice(0, 1) || "");
      inputEl.setSelectionRange(start, start);
      t.projectId = proj.id; t.text = inputEl.value; save();
      renderItemProject(); renderCalendar(); renderDayPanel();
      inputEl.focus();
    });
    return;
  }
  showTagMenuFor(inputEl, m[2], () => inputEl.getBoundingClientRect(), (cat) => {
    const t = getItem(); if (!t) return;
    const v = inputEl.value, ins = "#" + cat.label + " ";
    inputEl.value = v.slice(0, start) + ins + v.slice(end);
    const np = start + ins.length;
    inputEl.setSelectionRange(np, np);
    t.categories ||= []; if (!t.categories.includes(cat.id)) t.categories.push(cat.id);
    t.text = inputEl.value; save();
    buildItemCats(); renderCatFilter();
    inputEl.focus();
  });
}
/* #partial 토큰을 카테고리 색 칩으로 바꾸고 카테고리 지정 */
function insertCategoryChip(el, ctx, cat, t) {
  const node = ctx.node, full = node.textContent;
  const before = full.slice(0, ctx.start), after = full.slice(ctx.end);
  const frag = document.createDocumentFragment();
  if (before) frag.appendChild(document.createTextNode(before));
  const chip = document.createElement("span");
  chip.className = "tok-cat " + colorClass(cat.color);
  chip.contentEditable = "false";
  chip.textContent = "#" + cat.label;
  frag.appendChild(chip);
  const sp = document.createTextNode(" " + after);
  frag.appendChild(sp);
  node.parentNode.replaceChild(frag, node);
  const range = document.createRange();
  range.setStart(sp, 1); range.collapse(true);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
  t.categories ||= [];
  if (!t.categories.includes(cat.id)) t.categories.push(cat.id);
  t.text = el.textContent; save();
  renderCatFilter();
}

function makeBlock(t, key) {
  const el = document.createElement("div");
  el.className = "block" + (isDone(t, key) ? " done" : "");
  el.dataset.id = t.id;

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
  setupSmartInput(text, t);
  main.appendChild(text);

  const meta = document.createElement("div");
  meta.className = "block-meta";
  if (t.start) meta.innerHTML += `<span class="m-time">🕘 ${t.start}${t.end ? "–" + t.end : ""}</span>`;
  for (const cid of (t.categories || [])) {
    const c = catById(cid);
    if (c) meta.innerHTML += `<span class="m-cat ${colorClass(c.color)}"><i class="dot"></i>${escapeHtml(c.label)}</span>`;
  }
  if (t.recur) meta.innerHTML += `<span class="m-rec">↻ ${t.recur.freq === "biweekly" ? "격주" : "매주"}</span>`;
  if (t.note && t.note.trim()) meta.innerHTML += `<span class="m-note">📝 노트</span>`;
  const subs = t.subtasks || [];
  if (subs.length) meta.innerHTML += `<span class="m-step">☑ ${subs.filter((s) => s.done).length}/${subs.length}</span>`;
  if (t.projectId) {   // 클릭 시 해당 프로젝트로 이동하는 링크
    const p = projectById(t.projectId);
    if (p) { const pb = document.createElement("button"); pb.className = "m-proj"; pb.innerHTML = `📁 ${escapeHtml(p.name) || "프로젝트"}`; pb.title = "프로젝트로 이동"; pb.onclick = (e) => { e.stopPropagation(); openProjectPanel(p.id); }; meta.appendChild(pb); }
  }
  if (meta.innerHTML) main.appendChild(meta);
  main.appendChild(renderBlockSubs(t));
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

/* 블록 아래 하위 단계(인라인) — 체크/편집/삭제/추가 */
function renderBlockSubs(t) {
  const subs = t.subtasks || [];
  const box = document.createElement("div");
  box.className = "block-subs" + (subs.length ? "" : " empty");
  subs.forEach((s) => {
    const row = document.createElement("div");
    row.className = "bsub-row" + (s.done ? " done" : "");
    const chk = document.createElement("div");
    chk.className = "block-check sm" + (s.done ? " checked" : "");
    chk.onclick = () => { s.done = !s.done; save(); renderDayPanel(); renderCalendar(); };
    const txt = document.createElement("div");
    txt.className = "bsub-text"; txt.contentEditable = "true"; txt.textContent = s.text; txt.dataset.ph = "단계…";
    txt.addEventListener("input", () => { s.text = txt.textContent; save(); });
    txt.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); txt.blur(); addBlockSub(t); }
      if (e.key === "Backspace" && txt.textContent === "") { e.preventDefault(); t.subtasks = t.subtasks.filter((x) => x !== s); save(); renderDayPanel(); renderCalendar(); }
    });
    const d = document.createElement("button");
    d.className = "bsub-del"; d.textContent = "✕";
    d.onclick = () => { t.subtasks = t.subtasks.filter((x) => x !== s); save(); renderDayPanel(); renderCalendar(); };
    row.append(chk, txt, d);
    box.appendChild(row);
  });
  const add = document.createElement("button");
  add.className = "bsub-add"; add.textContent = "＋ 하위 단계";
  add.onclick = () => addBlockSub(t);
  box.appendChild(add);
  return box;
}
function addBlockSub(t) {
  t.subtasks ||= [];
  t.subtasks.push({ id: uid(), text: "", done: false });
  save(); renderDayPanel(); renderCalendar();
  requestAnimationFrame(() => {
    const block = blockList.querySelector(`.block[data-id="${t.id}"]`);
    if (block) { const ins = block.querySelectorAll(".bsub-text"); const last = ins[ins.length - 1]; if (last) last.focus(); }
  });
}

/* 우측 패널을 '일정·할 일' 탭으로 전환 */
function switchToDayTab() {
  document.querySelectorAll(".ptab").forEach((t) => t.classList.toggle("on", t.dataset.tab === "day"));
  document.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === "day"));
}

function addBlock() {
  if (!selectedKey) selectDate(todayKey);
  const it = { id: uid(), text: "", date: selectedKey, start: null, end: null, categories: [], note: "", star: false, done: false, doneDates: {}, recur: null };
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
  $("itemDate").value = it.date || todayKey;
  $("itemEndDate").value = it.endDate || "";
  $("itemStart").value = it.start || "";
  $("itemEnd").value = it.end || "";
  $("itemStar").className = "star-toggle" + (it.star ? " on" : "");
  $("itemStar").textContent = it.star ? "★ 별표" : "☆ 별표";
  $("itemRecur").value = it.recur ? it.recur.freq : "";
  $("itemUntil").value = it.recur && it.recur.until ? it.recur.until : "";
  $("recurUntilWrap").hidden = !it.recur;
  $("itemNote").value = it.note || "";
  buildItemCats();
  renderItemProject();
  renderItemSubtasks();
  $("itemModal").hidden = false;
}
/* 상세 모달: 지정된 프로젝트 표시 + 이동 링크 + 해제. ~로 추가 안내 */
function renderItemProject() {
  const wrap = $("itemProject"); if (!wrap) return;
  wrap.innerHTML = "";
  const p = editingItem && editingItem.projectId ? projectById(editingItem.projectId) : null;
  if (p) {
    const link = document.createElement("button");
    link.className = "proj-pill"; link.innerHTML = `📁 ${escapeHtml(p.name) || "프로젝트"} <b>↗</b>`;
    link.title = "프로젝트로 이동";
    link.onclick = () => { $("itemModal").hidden = true; openProjectPanel(p.id); };
    const clear = document.createElement("button");
    clear.className = "proj-pill-x"; clear.textContent = "✕"; clear.title = "프로젝트 해제";
    clear.onclick = () => { editingItem.projectId = null; save(); renderItemProject(); renderCalendar(); renderDayPanel(); renderQuickPanel(); };
    wrap.append(link, clear);
  } else {
    const hint = document.createElement("span");
    hint.className = "proj-hint"; hint.textContent = "제목에 ~ 를 입력해 프로젝트 지정";
    wrap.appendChild(hint);
  }
}
/* 하위 단계(서브태스크) — 상세 모달 */
function renderItemSubtasks() {
  const wrap = $("itemSubList"); wrap.innerHTML = "";
  editingItem.subtasks ||= [];
  for (const s of editingItem.subtasks) {
    const row = document.createElement("div");
    row.className = "sub-row" + (s.done ? " done" : "");
    const chk = document.createElement("div");
    chk.className = "block-check sm" + (s.done ? " checked" : "");
    chk.onclick = () => { s.done = !s.done; save(); renderItemSubtasks(); renderDayPanel(); renderCalendar(); };
    const inp = document.createElement("input");
    inp.className = "sub-input"; inp.value = s.text; inp.placeholder = "단계 이름";
    inp.oninput = () => { s.text = inp.value; save(); };
    inp.onblur = () => { renderDayPanel(); };
    const del = document.createElement("button");
    del.className = "block-del"; del.textContent = "✕";
    del.onclick = () => { editingItem.subtasks = editingItem.subtasks.filter((x) => x !== s); save(); renderItemSubtasks(); renderDayPanel(); renderCalendar(); };
    row.append(chk, inp, del);
    wrap.appendChild(row);
  }
}
function addItemSubtask(focusInput) {
  editingItem.subtasks ||= [];
  editingItem.subtasks.push({ id: uid(), text: "", done: false });
  save(); renderItemSubtasks(); renderDayPanel(); renderCalendar();
  if (focusInput) requestAnimationFrame(() => { const ins = $("itemSubList").querySelectorAll(".sub-input"); const last = ins[ins.length - 1]; if (last) last.focus(); });
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
  if ($("itemDate").value) it.date = $("itemDate").value;
  const ed = $("itemEndDate").value;
  it.endDate = ed && ed > it.date ? ed : null;   // 종료일이 시작일보다 뒤일 때만 기간으로
  it.start = $("itemStart").value || null;
  it.end = $("itemEnd").value || null;
  const freq = $("itemRecur").value;
  if (freq) it.recur = { freq, until: $("itemUntil").value || null };
  else it.recur = null;
  it.note = $("itemNote").value;
  save(); renderCalendar(); renderDayPanel();
}
$("itemText").addEventListener("input", persistItem);
setupSmartField($("itemText"), () => editingItem);   // 상세창 제목에 #카테고리 드롭다운
$("itemText").addEventListener("blur", () => {
  if (!editingItem) return;
  if (applyInlineSyntax(editingItem)) {
    $("itemText").value = editingItem.text;
    $("itemStart").value = editingItem.start || "";
    buildItemCats();
    save(); renderCalendar(); renderDayPanel(); renderCatFilter();
  }
});
$("itemDate").addEventListener("input", persistItem);
$("itemEndDate").addEventListener("input", persistItem);
$("itemNote").addEventListener("input", persistItem);
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
$("itemAddSub").addEventListener("click", () => addItemSubtask(true));

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
    if ((it.text || "").toLowerCase().includes(q)) {
      const proj = it.projectId ? projectById(it.projectId) : null;
      res.push({
        type: proj ? "프로젝트" : "할 일",
        icon: proj ? "📁" : "✓",
        label: proj && proj.name ? `${it.text} · ${proj.name}` : it.text,
        date: it.date,
        action: () => (it.date ? jumpToDate(it.date) : openProjectPanel(it.projectId)),
      });
    }
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
  if (!key) return;
  const d = parseKey(key);
  viewYear = d.getFullYear(); viewMonth = d.getMonth();
  renderCalendar(); selectDate(key);
}

/* ============================================================
   헤더 / 모달 공통 / 단축키
   ============================================================ */
function gotoPrevMonth() { const p = prevMY(); viewYear = p.y; viewMonth = p.m; renderCalendar("up"); }
function gotoNextMonth() { const n = nextMY(); viewYear = n.y; viewMonth = n.m; renderCalendar("down"); }
$("prevBtn").onclick = gotoPrevMonth;
$("nextBtn").onclick = gotoNextMonth;

/* 캘린더 위에서 마우스 휠 → 월 이동 (스르륵). 좁은 화면은 일반 스크롤 유지 */
let wheelCooldown = 0;
grid.addEventListener("wheel", (e) => {
  if (!window.matchMedia("(min-width: 861px)").matches) return;   // 모바일/좁은 화면은 페이지 스크롤
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  e.preventDefault();
  const now = Date.now();
  if (now - wheelCooldown < 360 || Math.abs(e.deltaY) < 6) return;
  wheelCooldown = now;
  e.deltaY > 0 ? gotoNextMonth() : gotoPrevMonth();
}, { passive: false });

/* ============================================================
   모바일 — 하단 탭바 / 단일 뷰 / 좌우 스와이프 월 이동
   ============================================================ */
const isMobile = () => window.matchMedia("(max-width: 860px)").matches;
function setMobileView(view) {
  const cls = view === "memo" ? "mv-memo" : (view === "cal" ? "mv-cal" : "mv-day");
  document.body.classList.remove("mv-cal", "mv-day", "mv-memo");
  document.body.classList.add(cls);
  document.querySelectorAll(".mtab").forEach((t) => t.classList.toggle("on", t.dataset.mview === view));
  if (view !== "cal") {
    const pane = view === "memo" ? "memo" : "day";
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === pane));
  }
  window.scrollTo(0, 0);
  if (view === "block") {
    const qp = document.querySelector(".quick-panel");
    if (qp) requestAnimationFrame(() => qp.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
}
document.querySelectorAll(".mtab").forEach((t) => t.addEventListener("click", () => { closeDaySheet(); setMobileView(t.dataset.mview); }));
if (isMobile()) document.body.classList.add("mv-cal");

/* 모바일: 날짜 탭 시 그 날 상세(할 일·일지)를 하단 시트로 */
function openDaySheet() {
  document.querySelectorAll(".ptab").forEach((t) => t.classList.toggle("on", t.dataset.tab === "day"));
  document.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === "day"));
  document.body.classList.add("day-sheet");
}
function closeDaySheet() { document.body.classList.remove("day-sheet"); }
$("sheetBackdrop").addEventListener("click", closeDaySheet);
$("sheetHandle").addEventListener("click", closeDaySheet);
window.addEventListener("resize", () => {
  if (isMobile() && !document.body.classList.contains("mv-cal") && !document.body.classList.contains("mv-day") && !document.body.classList.contains("mv-memo")) {
    document.body.classList.add("mv-cal");
  }
});

/* 좌우 스와이프로 월 이동 (모바일) */
let touchX = null, touchY = null;
grid.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1) { touchX = null; return; }
  touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
}, { passive: true });
grid.addEventListener("touchend", (e) => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  const dy = e.changedTouches[0].clientY - touchY;
  touchX = null;
  if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
    suppressDayClick = true; setTimeout(() => { suppressDayClick = false; }, 120);   // 스와이프가 날짜 탭으로 오인되지 않게
    dx < 0 ? gotoNextMonth() : gotoPrevMonth();
  }
}, { passive: true });
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
   빠른 메모 블럭 — INBOX / 주간 / 월간 (노션식 블럭)
   - 블럭을 달력으로 드래그 → 그 날짜 할 일로 이동
   - 📝 버튼 → 메모로 보내기
   ============================================================ */
let qpTab = "inbox";
function weekStartKey(key) {
  const d = parseKey(key); d.setDate(d.getDate() - d.getDay());   // 일요일로
  return keyOf(d.getFullYear(), d.getMonth(), d.getDate());
}
function currentQuickList() {
  const ctx = selectedKey || todayKey;
  if (qpTab === "inbox") return state.inbox;
  if (qpTab === "weekly") return (state.weekly[weekStartKey(ctx)] ||= []);
  return (state.monthly[ctx.slice(0, 7)] ||= []);
}
function renderQuickPanel() {
  document.querySelectorAll(".qp-tab").forEach((t) => t.classList.toggle("on", t.dataset.qp === qpTab));
  const isProj = qpTab === "project";
  $("qpAdd").innerHTML = isProj ? `<span>＋</span> 프로젝트 추가` : `<span>＋</span> 블럭 추가 <kbd>Enter</kbd>`;
  if (isProj) { $("qpContext").textContent = `${state.projects.length}개`; renderProjects(); return; }
  const ctx = selectedKey || todayKey;
  const ctxEl = $("qpContext");
  if (qpTab === "inbox") ctxEl.textContent = "아무거나 임시로";
  else if (qpTab === "weekly") {
    const s = weekStartKey(ctx); const e = parseKey(s); e.setDate(e.getDate() + 6);
    ctxEl.textContent = `${s.slice(5).replace("-", "/")} ~ ${keyOf(e.getFullYear(), e.getMonth(), e.getDate()).slice(5).replace("-", "/")}`;
  } else ctxEl.textContent = `${ctx.slice(0, 4)}년 ${Number(ctx.slice(5, 7))}월`;

  const wrap = $("qpList"); wrap.innerHTML = "";
  const list = currentQuickList();
  // 죽은 참조(원본 할 일이 삭제됨) 정리
  const pruned = list.filter((b) => !b.ref || itemById(b.ref));
  if (pruned.length !== list.length) { list.length = 0; list.push(...pruned); save(); }
  if (list.length === 0) {
    wrap.innerHTML = `<div class="qp-empty">＋ 로 블럭 추가. ⠿ 드래그로 달력에, 📝로 메모로.<br>프로젝트·달력의 할 일을 여기로 <b>드래그</b>하거나 <b>~</b> 로 프로젝트를 지정하면 링크돼요.</div>`;
  } else {
    list.forEach((blk) => wrap.appendChild(blk.ref ? makeRefBlock(blk, list) : makeQuickBlock(blk, list)));
  }
}
function makeQuickBlock(blk, list) {
  const el = document.createElement("div");
  el.className = "qp-block";

  const handle = document.createElement("div");
  handle.className = "qp-handle"; handle.textContent = "⠿"; handle.title = "달력으로 드래그"; handle.draggable = true;
  handle.addEventListener("dragstart", (e) => {
    dragData = { type: "panelBlock", text: blk.text, remove: () => { const i = list.indexOf(blk); if (i >= 0) list.splice(i, 1); } };
    e.dataTransfer.effectAllowed = "move";
    const img = new Image(); img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
    e.dataTransfer.setDragImage(img, 0, 0);
    showGhost(blk.text || "(빈 블럭)");
  });
  handle.addEventListener("drag", moveGhost);
  handle.addEventListener("dragend", () => { hideGhost(); document.querySelectorAll(".day.drop-target").forEach((d) => d.classList.remove("drop-target")); });

  const txt = document.createElement("div");
  txt.className = "qp-text"; txt.contentEditable = "true"; txt.textContent = blk.text; txt.dataset.ph = "입력…";
  txt.addEventListener("input", () => { blk.text = txt.textContent; save(); updateProjMenuBlock(txt, blk, list); });
  txt.addEventListener("keydown", (e) => {
    const menuOpen = tagMenuEl && !tagMenuEl.hidden && tagMenuEditEl === txt;
    if (menuOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); moveTagMenu(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); moveTagMenu(-1); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseTagMenu(); return; }
      if (e.key === "Escape") { e.preventDefault(); hideTagMenu(); return; }
    }
    if (e.key === "Enter") { e.preventDefault(); txt.blur(); addQuickBlock(); }
    if (e.key === "Backspace" && txt.textContent === "") { e.preventDefault(); const i = list.indexOf(blk); if (i >= 0) list.splice(i, 1); save(); renderQuickPanel(); }
  });
  txt.addEventListener("blur", () => setTimeout(() => { if (tagMenuEditEl === txt) hideTagMenu(); }, 150));

  const toMemo = document.createElement("button");
  toMemo.className = "qp-btn"; toMemo.textContent = "📝"; toMemo.title = "메모로 보내기";
  toMemo.onclick = () => blockToMemo(blk, list);

  const del = document.createElement("button");
  del.className = "qp-btn"; del.textContent = "✕"; del.title = "삭제";
  del.onclick = () => { const i = list.indexOf(blk); if (i >= 0) list.splice(i, 1); save(); renderQuickPanel(); };

  el.append(handle, txt, toMemo, del);
  return el;
}
/* 참조(링크) 블럭 — 실제 할 일(item)을 가리킴. 여기서 체크/수정하면 원본과 동기화 */
function makeRefBlock(blk, list) {
  const it = itemById(blk.ref);
  const el = document.createElement("div");
  el.className = "qp-block qp-ref" + (it.done ? " done" : "");

  const handle = document.createElement("div");
  handle.className = "qp-handle"; handle.textContent = "⠿"; handle.title = "달력으로 드래그 → 날짜 지정"; handle.draggable = true;
  handle.addEventListener("dragstart", (e) => {
    dragData = { type: "projectTodo", id: it.id };
    e.dataTransfer.effectAllowed = "move";
    const img = new Image(); img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
    e.dataTransfer.setDragImage(img, 0, 0);
    showGhost(it.text || "(빈 할 일)");
  });
  handle.addEventListener("drag", moveGhost);
  handle.addEventListener("dragend", () => { hideGhost(); document.querySelectorAll(".day.drop-target, .proj-card.drop-target").forEach((d) => d.classList.remove("drop-target")); });

  const check = document.createElement("div");
  check.className = "qp-check" + (it.done ? " checked" : "");
  check.onclick = () => { it.done = !it.done; save(); renderQuickPanel(); renderCalendar(); renderDayPanel(); };

  const txt = document.createElement("div");
  txt.className = "qp-text"; txt.contentEditable = "true"; txt.textContent = it.text; txt.dataset.ph = "할 일…";
  txt.addEventListener("input", () => { it.text = txt.textContent; save(); });
  txt.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); txt.blur(); }
    if (e.key === "Backspace" && txt.textContent === "") { e.preventDefault(); const i = list.indexOf(blk); if (i >= 0) list.splice(i, 1); save(); renderQuickPanel(); }
  });

  const meta = document.createElement("div");
  meta.className = "qp-ref-meta";
  const proj = it.projectId ? projectById(it.projectId) : null;
  if (proj) { const a = document.createElement("button"); a.className = "qp-proj"; a.textContent = `📁 ${proj.name || "프로젝트"}`; a.title = "프로젝트로 이동"; a.onclick = () => openProjectPanel(proj.id); meta.appendChild(a); }
  if (it.date) { const d = document.createElement("span"); d.className = "qp-refdate"; d.textContent = it.date.slice(5).replace("-", "/"); meta.appendChild(d); }

  const open = document.createElement("button");
  open.className = "qp-btn"; open.textContent = "⚙"; open.title = "상세";
  open.onclick = () => openItemModal(it);

  const del = document.createElement("button");
  del.className = "qp-btn"; del.textContent = "✕"; del.title = "링크 해제(원본은 유지)";
  del.onclick = () => { const i = list.indexOf(blk); if (i >= 0) list.splice(i, 1); save(); renderQuickPanel(); };

  const mainwrap = document.createElement("div"); mainwrap.className = "qp-ref-main";
  mainwrap.append(txt); if (meta.children.length) mainwrap.append(meta);
  el.append(handle, check, mainwrap, open, del);
  return el;
}
function addQuickBlock() {
  const list = currentQuickList();
  list.push({ id: uid(), text: "" });
  save(); renderQuickPanel();
  requestAnimationFrame(() => { const ts = $("qpList").querySelectorAll(".qp-text"); const last = ts[ts.length - 1]; if (last) last.focus(); });
}
function blockToMemo(blk, list) {
  const text = (blk.text || "").trim();
  if (!text) { alert("빈 블럭은 메모로 보낼 수 없어요."); return; }
  const n = { id: uid(), title: text.split("\n")[0].slice(0, 40), body: escapeHtml(text).replace(/\n/g, "<br>"), pinned: false, updated: Date.now(), linkDate: null };
  state.notes.push(n);
  const i = list.indexOf(blk); if (i >= 0) list.splice(i, 1);
  save(); renderQuickPanel(); renderMemoList();
  openMemo(n.id);   // 메모 편집창 열어 확인
}
function listForTab(name) {
  const ctx = selectedKey || todayKey;
  if (name === "inbox") return state.inbox;
  if (name === "weekly") return (state.weekly[weekStartKey(ctx)] ||= []);
  if (name === "monthly") return (state.monthly[ctx.slice(0, 7)] ||= []);
  return null;
}
document.querySelectorAll(".qp-tab").forEach((tab) => {
  tab.addEventListener("click", () => { qpTab = tab.dataset.qp; renderQuickPanel(); });
  // 탭 버튼에 할 일(프로젝트/달력)을 드롭 → 그 목록에 링크
  if (tab.dataset.qp === "project") return;
  tab.addEventListener("dragover", (e) => {
    if (!dragData || !dragData.id || dragData.type === "panelBlock") return;
    e.preventDefault(); e.dataTransfer.dropEffect = "copy"; tab.classList.add("qp-tab-drop");
  });
  tab.addEventListener("dragleave", () => tab.classList.remove("qp-tab-drop"));
  tab.addEventListener("drop", (e) => {
    tab.classList.remove("qp-tab-drop");
    if (!dragData || !dragData.id || dragData.type === "panelBlock") return;
    e.preventDefault();
    const list = listForTab(tab.dataset.qp);
    if (list && !list.some((b) => b.ref === dragData.id)) list.push({ id: uid(), ref: dragData.id });
    save(); qpTab = tab.dataset.qp; renderQuickPanel();
    dragData = null;
  });
});
$("qpAdd").addEventListener("click", () => { qpTab === "project" ? addProject() : addQuickBlock(); });

/* INBOX/주간/월간 목록에 프로젝트·달력 할 일을 드롭 → 링크(참조) 블럭 생성 */
(function setupQuickDrop() {
  const wrap = $("qpList");
  wrap.addEventListener("dragover", (e) => {
    if (!dragData || qpTab === "project" || dragData.type === "panelBlock" || !dragData.id) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "copy"; wrap.classList.add("qp-drop");
  });
  wrap.addEventListener("dragleave", (e) => { if (!wrap.contains(e.relatedTarget)) wrap.classList.remove("qp-drop"); });
  wrap.addEventListener("drop", (e) => {
    wrap.classList.remove("qp-drop");
    if (!dragData || qpTab === "project" || dragData.type === "panelBlock" || !dragData.id) return;
    e.preventDefault();
    const list = currentQuickList();
    if (!list.some((b) => b.ref === dragData.id)) list.push({ id: uid(), ref: dragData.id });
    save(); renderQuickPanel();
    dragData = null;
  });
})();

/* ============================================================
   프로젝트 — 카테고리와 별개. 프로젝트별 할 일 모음.
   할 일은 state.items에 projectId로 연결 → 날짜를 지정하면
   기존 캘린더/할 일 파이프라인으로 자동 표시된다.
   ============================================================ */
function projectById(id) { return (state.projects || []).find((p) => p.id === id) || null; }
function itemById(id) { return state.items.find((x) => x.id === id) || null; }
function itemsForProject(pid) {
  return state.items.filter((it) => it.projectId === pid).sort((a, b) => {
    const ad = a.date || "9999", bd = b.date || "9999";   // 날짜 없는 건 아래로
    if (ad !== bd) return ad < bd ? -1 : 1;
    return 0;
  });
}
function addProject() {
  const p = { id: uid(), name: "", collapsed: false };
  state.projects.push(p);
  save(); renderQuickPanel();
  requestAnimationFrame(() => { const el = $("qpList").querySelector(`.proj-card[data-pid="${p.id}"] .proj-name`); el && el.focus(); });
}
function deleteProject(p) {
  const items = itemsForProject(p.id);
  const msg = `'${p.name || "이 프로젝트"}'를 삭제할까요?` + (items.length ? `\n연결된 할 일 ${items.length}개도 함께 삭제됩니다.` : "");
  if (!confirm(msg)) return;
  state.projects = state.projects.filter((x) => x.id !== p.id);
  state.items = state.items.filter((it) => it.projectId !== p.id);
  save(); renderQuickPanel(); renderCalendar(); renderDayPanel();
}
function addProjectTodo(pid, focus) {
  const it = { id: uid(), text: "", date: null, endDate: null, start: null, end: null, categories: [], note: "", star: false, done: false, doneDates: {}, recur: null, projectId: pid };
  state.items.push(it);
  save(); renderProjects();
  if (focus) requestAnimationFrame(() => { const ts = $("qpList").querySelector(`.proj-card[data-pid="${pid}"] .proj-todo:last-child .pt-text`); ts && ts.focus(); });
}
let showDoneProjects = false;
function renderProjects() {
  const wrap = $("qpList"); wrap.innerHTML = "";
  if (state.projects.length === 0) {
    wrap.innerHTML = `<div class="qp-empty">＋ 로 프로젝트를 만들어요. 각 프로젝트마다 할 일을 담고, 날짜를 정하면 달력에도 표시돼요.<br>주간·월간·달력·할 일에서 <b>~</b> 를 치면 프로젝트를 지정할 수 있어요.</div>`;
    return;
  }
  const active = state.projects.filter((p) => !p.done);
  const done = state.projects.filter((p) => p.done);
  active.forEach((p) => wrap.appendChild(makeProjectCard(p)));

  if (done.length) {
    const bar = document.createElement("button");
    bar.className = "proj-done-bar" + (showDoneProjects ? " open" : "");
    bar.innerHTML = `<span>${showDoneProjects ? "▾" : "▸"} 완료된 프로젝트</span><span class="pdone-n">${done.length}</span>`;
    bar.onclick = () => { showDoneProjects = !showDoneProjects; renderProjects(); };
    wrap.appendChild(bar);
    if (showDoneProjects) done.forEach((p) => wrap.appendChild(makeProjectCard(p)));
  }
}
function makeProjectCard(p) {
  const card = document.createElement("div");
  card.className = "proj-card" + (p.done ? " proj-done" : ""); card.dataset.pid = p.id;

  const head = document.createElement("div");
  head.className = "proj-head";

  const caret = document.createElement("button");
  caret.className = "proj-caret"; caret.textContent = p.collapsed ? "▸" : "▾"; caret.title = "접기/펴기";
  caret.onclick = () => { p.collapsed = !p.collapsed; save(); renderProjects(); };

  const done = document.createElement("button");
  done.className = "proj-done-btn" + (p.done ? " on" : ""); done.textContent = p.done ? "✓" : "○";
  done.title = p.done ? "완료 해제" : "프로젝트 완료";
  done.onclick = () => { p.done = !p.done; if (p.done) p.collapsed = true; save(); renderProjects(); };

  const name = document.createElement("div");
  name.className = "proj-name"; name.contentEditable = "true"; name.dataset.ph = "프로젝트 이름…";
  name.textContent = p.name;
  name.addEventListener("input", () => { p.name = name.textContent; save(); });
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); name.blur(); } });

  const items = itemsForProject(p.id);
  const doneN = items.filter((it) => it.done).length;
  const count = document.createElement("span");
  count.className = "proj-count"; count.textContent = items.length ? `${doneN}/${items.length}` : "";

  const del = document.createElement("button");
  del.className = "proj-del"; del.textContent = "🗑"; del.title = "프로젝트 삭제";
  del.onclick = () => deleteProject(p);

  head.append(done, caret, name, count, del);
  card.appendChild(head);

  if (!p.collapsed) {
    const list = document.createElement("div");
    list.className = "proj-todos";
    items.forEach((it) => list.appendChild(makeProjectTodo(it)));
    card.appendChild(list);

    const add = document.createElement("button");
    add.className = "proj-add"; add.innerHTML = `<span>＋</span> 할 일`;
    add.onclick = () => addProjectTodo(p.id, true);
    card.appendChild(add);
  }

  // 이 카드에 드롭 — 캘린더 칩/빠른블럭/다른 프로젝트 할 일을 이 프로젝트로 편입
  card.addEventListener("dragover", (e) => {
    if (!dragData) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "move"; card.classList.add("drop-target");
  });
  card.addEventListener("dragleave", (e) => { if (!card.contains(e.relatedTarget)) card.classList.remove("drop-target"); });
  card.addEventListener("drop", (e) => {
    e.preventDefault(); card.classList.remove("drop-target");
    if (!dragData) return;
    if (dragData.type === "panelBlock") {                      // 빠른블럭 → 이 프로젝트의 할 일(날짜 없음)
      const text = (dragData.text || "").trim();
      if (text) { const it = { id: uid(), text, date: null, endDate: null, start: null, end: null, categories: [], note: "", subtasks: [], star: false, done: false, doneDates: {}, recur: null, projectId: p.id }; applyInlineSyntax(it); state.items.push(it); }
      dragData.remove(); save(); renderQuickPanel(); renderCalendar(); renderDayPanel(); renderCatFilter(); dragData = null; return;
    }
    const it = state.items.find((x) => x.id === dragData.id);
    if (it) {
      it.projectId = p.id;   // 링크 느낌: 날짜는 그대로 두어 달력에도 계속 표시됨
      save(); renderQuickPanel(); renderCalendar(); renderDayPanel();
    }
    dragData = null;
  });
  return card;
}
function makeProjectTodo(it) {
  const row = document.createElement("div");
  row.className = "proj-todo" + (it.done ? " done" : "");

  // 드래그 핸들 — 캘린더 날짜로 끌어 놓으면 날짜가 지정된다
  const handle = document.createElement("div");
  handle.className = "pt-handle"; handle.textContent = "⠿"; handle.title = "캘린더로 드래그 → 날짜 지정"; handle.draggable = true;
  handle.addEventListener("dragstart", (e) => {
    dragData = { type: "projectTodo", id: it.id };
    e.dataTransfer.effectAllowed = "move";
    const img = new Image(); img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
    e.dataTransfer.setDragImage(img, 0, 0);
    showGhost(it.text || "(빈 할 일)");
  });
  handle.addEventListener("drag", moveGhost);
  handle.addEventListener("dragend", () => { hideGhost(); document.querySelectorAll(".day.drop-target, .proj-card.drop-target").forEach((d) => d.classList.remove("drop-target")); });

  const check = document.createElement("div");
  check.className = "pt-check" + (it.done ? " checked" : "");
  check.onclick = () => { it.done = !it.done; save(); renderProjects(); renderCalendar(); renderDayPanel(); };

  const text = document.createElement("div");
  text.className = "pt-text"; text.contentEditable = "true"; text.dataset.ph = "할 일 입력…";
  text.textContent = it.text;
  text.addEventListener("input", () => { it.text = text.textContent; save(); });
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); text.blur(); addProjectTodo(it.projectId, true); }
    if (e.key === "Backspace" && text.textContent === "") { e.preventDefault(); state.items = state.items.filter((x) => x !== it); save(); renderProjects(); renderCalendar(); renderDayPanel(); }
  });

  const date = document.createElement("input");
  date.type = "date"; date.className = "pt-date" + (it.date ? " set" : ""); date.value = it.date || ""; date.title = "날짜 지정 시 달력에 표시";
  date.addEventListener("change", () => {
    it.date = date.value || null; it.endDate = null;
    save(); renderProjects(); renderCalendar(); renderDayPanel();
  });

  const edit = document.createElement("button");
  edit.className = "pt-btn"; edit.textContent = "⚙"; edit.title = "상세(카테고리·시간·단계)";
  edit.onclick = () => openItemModal(it);

  const del = document.createElement("button");
  del.className = "pt-btn"; del.textContent = "✕"; del.title = "삭제";
  del.onclick = () => { state.items = state.items.filter((x) => x !== it); save(); renderProjects(); renderCalendar(); renderDayPanel(); };

  row.append(handle, check, text, date, edit, del);
  return row;
}
/* 검색 등에서 프로젝트 탭으로 이동 */
function openProjectPanel(pid) {
  qpTab = "project";
  if (isMobile()) { closeDaySheet(); setMobileView("block"); } else { switchToDayTab(); }
  renderQuickPanel();
  if (pid) requestAnimationFrame(() => {
    const card = $("qpList").querySelector(`.proj-card[data-pid="${pid}"]`);
    card && card.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

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
