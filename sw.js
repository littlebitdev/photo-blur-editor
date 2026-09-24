// 사진 가림 편집기 — 서비스 워커
// 목적: 큰 파일(opencv.js, 인식 모델)을 브라우저에 확실히 저장해 두어서
// 새로고침할 때마다 다시 받지 않고, 인터넷이 없어도 계속 쓸 수 있게 합니다.
//
// 저장 방식
//  · 화면 뼈대(index.html, app.js): "네트워크 우선" — 인터넷이 되면 항상 최신 파일을 받아 씁니다.
//    (그래서 새 버전을 올린 뒤 새로고침 한 번이면 바로 새 버전이 뜹니다.)
//    인터넷이 안 되거나 4초 넘게 응답이 없으면 저장해 둔 파일로 대신합니다.
//  · 큰 파일(opencv.js, 인식 모델 등): "저장본 우선" — 한 번 받으면 다시 받지 않습니다.
//
// 큰 파일(opencv.js, .onnx, .xml)을 교체했을 때는 아래 CACHE_NAME의 숫자를 올려 주세요.
// 그래야 예전 캐시를 지우고 새 파일로 확실히 교체됩니다.
// (index.html / app.js만 고칠 때는 안 올려도 새 버전이 반영되지만, 올려도 문제는 없습니다.)
const CACHE_NAME = "photo-blur-editor-v12";
const SHELL_TIMEOUT_MS = 4000;

// 화면 뼈대인지 판별: 페이지 이동 요청, index.html, app.js
function isShell(req, url) {
  if (req.mode === "navigate") return true;
  return /\/(index\.html|app\.js)$/.test(url.pathname) || url.pathname.endsWith("/");
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 처음 방문 직후 인터넷이 끊겨도 열리도록, 뼈대 파일을 최신본으로 미리 저장합니다.
    // (index.html 안의 app.js 주소에는 ?v=번호 가 붙어 있으므로 그 주소 그대로 저장합니다.)
    try {
      const idxResp = await fetch(new Request("./index.html", { cache: "reload" }));
      if (idxResp.ok) {
        const text = await idxResp.clone().text();
        await cache.put("./index.html", idxResp.clone());
        await cache.put("./", idxResp);
        const m = text.match(/src="(\.\/app\.js[^"]*)"/);
        const appUrl = m ? m[1] : "./app.js";
        const appResp = await fetch(new Request(appUrl, { cache: "reload" }));
        if (appResp.ok) await cache.put(appUrl, appResp);
      }
    } catch (_) { /* 인터넷이 안 되면 첫 방문 때 저장되지 않을 뿐, 이후 정상 동작 */ }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 같은 파일의 예전 주소(app.js?v=이전번호)가 캐시에 쌓이지 않도록 정리합니다.
async function dropOldVariants(cache, req) {
  const u = new URL(req.url);
  const keys = await cache.keys();
  await Promise.all(keys
    .filter((k) => { const ku = new URL(k.url); return ku.pathname === u.pathname && ku.search !== u.search; })
    .map((k) => cache.delete(k)));
}

async function shellNetworkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SHELL_TIMEOUT_MS);
    let resp;
    // cache:"no-cache" — 브라우저가 임시 보관해 둔 낡은 파일을 그대로 쓰지 않고, 서버에 최신 여부를 확인하게 합니다.
    try { resp = await fetch(req, { signal: ctrl.signal, cache: "no-cache" }); } finally { clearTimeout(timer); }
    if (resp && resp.ok) {
      await cache.put(req, resp.clone());
      await dropOldVariants(cache, req);
      return resp;
    }
    throw new Error("bad response");
  } catch (_) {
    const cached = (await cache.match(req)) ||
      (await cache.match(req, { ignoreSearch: true })) ||
      (req.mode === "navigate" ? await cache.match("./index.html") : undefined);
    if (cached) return cached;
    return fetch(req); // 저장본도 없으면 평소처럼 네트워크 결과(또는 오류)를 그대로 돌려줍니다.
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  const resp = await fetch(req);
  if (resp && resp.ok) cache.put(req, resp.clone());
  return resp;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // 다른 사이트(jsdelivr CDN 등)로 나가는 요청은 손대지 않고 그대로 둡니다.
  if (url.origin !== self.location.origin) return;

  event.respondWith(isShell(req, url) ? shellNetworkFirst(req) : cacheFirst(req));
});
