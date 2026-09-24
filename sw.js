// 사진 가림 편집기 — 서비스 워커
// 목적: 큰 파일(opencv.js, 인식 모델)을 브라우저에 확실히 저장해 두어서
// 새로고침할 때마다 다시 받지 않고, 인터넷이 없어도 계속 쓸 수 있게 합니다.
//
// 앱 코드(app.js)를 고칠 때는 아래 CACHE_NAME의 숫자를 올려 주세요.
// 그래야 예전 캐시를 지우고 새 파일로 확실히 교체됩니다.
const CACHE_NAME = "photo-blur-editor-v9";

// 페이지를 열자마자 항상 필요한 작은 파일만 미리 저장해 둡니다.
// opencv.js처럼 큰 파일은 여기서 미리 받지 않고, 사용자가 실제로
// "얼굴 한 번에 가리기"를 처음 쓸 때 자연스럽게 캐시에 들어갑니다
// (안 쓰는 사람에게 큰 파일을 미리 강제로 받게 하지 않기 위해서입니다).
const CORE_ASSETS = ["./", "./index.html", "./app.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // 다른 사이트(jsdelivr CDN 등)로 나가는 요청은 손대지 않고 그대로 둡니다.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      // 네트워크에서 새로 받아지면 캐시를 갱신해 둡니다(다음번엔 그걸 씀).
      const networkFetch = fetch(req)
        .then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return resp;
        })
        .catch(() => cached); // 오프라인이면 캐시된 것으로 대신 응답

      // 캐시에 이미 있으면 그걸 바로 돌려줘서 체감 속도를 확 줄입니다.
      // (없으면 네트워크 응답을 기다렸다가 그걸 캐시에 저장 + 반환합니다)
      return cached || networkFetch;
    })
  );
});
