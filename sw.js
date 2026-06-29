/* 다담 서비스워커 — 오프라인 지원
   파일을 바꾸면 CACHE 버전을 올려야 새로 받습니다. */
const CACHE = "dadam-v7";
const CORE = ["./", "index.html", "styles.css", "app.js", "sync.js", "kdata.js", "manifest.json", "icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // 같은 출처(앱 파일)만 캐시 처리 — Supabase/폰트 등 외부 요청은 그대로 통과
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  // 네트워크 우선(HTTP 캐시 우회해 항상 서버 최신 확인), 실패 시 캐시(오프라인)
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});
