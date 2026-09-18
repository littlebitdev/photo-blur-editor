// 사진 가림 편집기 (웹판)
// 모든 처리는 이 브라우저 안에서만 이루어집니다. 사진은 어디로도 전송되지 않습니다.
"use strict";

const ACCENT = "#2f6f5e";

// ── 수치 ──────────────────────────────────────────────────────────
function blurRatio(strength) {
  const s = Math.max(1, Math.min(100, strength)) / 100;
  return 0.012 + 0.11 * Math.pow(s, 1.6);
}
function mosaicRatio(strength) {
  const s = Math.max(1, Math.min(100, strength)) / 100;
  return 0.02 + 0.16 * Math.pow(s, 1.4);
}

// ── 상태 ──────────────────────────────────────────────────────────
const state = {
  source: null,      // 회전 전 원본 캔버스
  src: null,          // 현재 회전이 적용된 작업용 캔버스
  rotation: 0,
  filenameStem: "사진",
  ops: [],
  selected: -1,
  clipboard: null,
  undoStack: [],
  redoStack: [],
  tool: "rect",
  effect: "blur",
  strength: 60,
  zoom: 1,
  pan: { x: 0, y: 0 },
  drawing: false,
  start: null,
  current: null,
  freePoints: [],
  dragMode: null,
  dragAnchor: null,
  dragBefore: null,
  panAnchor: null,
  displayRect: null,
};

// ── 도형 계산 ────────────────────────────────────────────────────
function opBBox(op) {
  if (op.type === "rect" || op.type === "ellipse") {
    const [x1, y1, x2, y2] = op.box;
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  }
  const xs = op.points.map((p) => p[0]);
  const ys = op.points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function pointInPoly([x, y], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    const cross = (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi;
    if (cross) inside = !inside;
  }
  return inside;
}

function ellipsePathOn(ctx, x1, y1, x2, y2) {
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
  ctx.ellipse(cx, cy, Math.max(rx, 0.1), Math.max(ry, 0.1), 0, 0, Math.PI * 2);
}

function polyPathOn(ctx, pts) {
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

// ── 렌더링 (가림 효과 적용) ─────────────────────────────────────
function applyOp(outCanvas, ctx, op) {
  const [x1, y1, x2, y2] = opBBox(op);
  const rx1 = Math.floor(x1), ry1 = Math.floor(y1);
  const rx2 = Math.ceil(x2), ry2 = Math.ceil(y2);
  if (rx2 - rx1 < 2 || ry2 - ry1 < 2) return;

  const strength = Math.max(1, Math.round(op.strength ?? 60));
  const eff = op.effect || "blur";
  const base = Math.min(rx2 - rx1, ry2 - ry1);

  let radius = 0, pad = 2;
  if (eff === "blur") {
    radius = Math.max(2, base * blurRatio(strength));
    pad = Math.round(radius * 2) + 4;
  }

  const W = outCanvas.width, H = outCanvas.height;
  const px1 = Math.max(0, rx1 - pad), py1 = Math.max(0, ry1 - pad);
  const px2 = Math.min(W, rx2 + pad), py2 = Math.min(H, ry2 + pad);
  const cw = px2 - px1, ch = py2 - py1;
  if (cw < 2 || ch < 2) return;

  const crop = document.createElement("canvas");
  crop.width = cw; crop.height = ch;
  crop.getContext("2d").drawImage(outCanvas, px1, py1, cw, ch, 0, 0, cw, ch);

  const mask = document.createElement("canvas");
  mask.width = cw; mask.height = ch;
  const mctx = mask.getContext("2d");
  mctx.fillStyle = "#fff";
  mctx.beginPath();
  if (op.type === "rect") {
    mctx.rect(x1 - px1, y1 - py1, x2 - x1, y2 - y1);
  } else if (op.type === "ellipse") {
    ellipsePathOn(mctx, x1 - px1, y1 - py1, x2 - px1, y2 - py1);
  } else {
    polyPathOn(mctx, op.points.map((p) => [p[0] - px1, p[1] - py1]));
  }
  mctx.fill();

  let fill, feather;
  if (eff === "solid") {
    fill = document.createElement("canvas");
    fill.width = cw; fill.height = ch;
    const fctx = fill.getContext("2d");
    fctx.fillStyle = op.color || "#1d2320";
    fctx.fillRect(0, 0, cw, ch);
    feather = 0.8;
  } else if (eff === "mosaic") {
    const block = Math.max(3, base * mosaicRatio(strength));
    const nw = Math.max(1, Math.round(cw / block));
    const nh = Math.max(1, Math.round(ch / block));
    const pre = document.createElement("canvas");
    pre.width = cw; pre.height = ch;
    const pctx = pre.getContext("2d");
    pctx.filter = `blur(${(block / 3).toFixed(2)}px)`;
    pctx.drawImage(crop, 0, 0);
    const tiny = document.createElement("canvas");
    tiny.width = nw; tiny.height = nh;
    tiny.getContext("2d").drawImage(pre, 0, 0, nw, nh);
    fill = document.createElement("canvas");
    fill.width = cw; fill.height = ch;
    const fctx2 = fill.getContext("2d");
    fctx2.imageSmoothingEnabled = false;
    fctx2.drawImage(tiny, 0, 0, cw, ch);
    feather = 0.8;
  } else {
    const pre = document.createElement("canvas");
    pre.width = cw; pre.height = ch;
    const pctx = pre.getContext("2d");
    pctx.filter = `blur(${(radius * 0.55).toFixed(2)}px)`;
    pctx.drawImage(crop, 0, 0);
    let stage = pre;
    const down = Math.max(1, Math.round(radius / 1.5));
    if (down > 1) {
      const nw = Math.max(1, Math.floor(cw / down));
      const nh = Math.max(1, Math.floor(ch / down));
      const tiny = document.createElement("canvas");
      tiny.width = nw; tiny.height = nh;
      tiny.getContext("2d").drawImage(pre, 0, 0, nw, nh);
      const back = document.createElement("canvas");
      back.width = cw; back.height = ch;
      back.getContext("2d").drawImage(tiny, 0, 0, cw, ch);
      stage = back;
    }
    fill = document.createElement("canvas");
    fill.width = cw; fill.height = ch;
    const fctx3 = fill.getContext("2d");
    fctx3.filter = `blur(${Math.max(1, radius * 0.3).toFixed(2)}px)`;
    fctx3.drawImage(stage, 0, 0);
    feather = Math.max(1, radius * 0.12);
  }

  let finalMask = mask;
  if (feather > 0) {
    finalMask = document.createElement("canvas");
    finalMask.width = cw; finalMask.height = ch;
    const fm = finalMask.getContext("2d");
    fm.filter = `blur(${feather.toFixed(2)}px)`;
    fm.drawImage(mask, 0, 0);
  }

  const composed = document.createElement("canvas");
  composed.width = cw; composed.height = ch;
  const cmx = composed.getContext("2d");
  cmx.drawImage(fill, 0, 0);
  cmx.globalCompositeOperation = "destination-in";
  cmx.drawImage(finalMask, 0, 0);

  ctx.drawImage(composed, px1, py1);
}

function render() {
  if (!state.src) return null;
  const out = document.createElement("canvas");
  out.width = state.src.width; out.height = state.src.height;
  const ctx = out.getContext("2d");
  ctx.drawImage(state.src, 0, 0);
  for (const op of state.ops) applyOp(out, ctx, op);
  return out;
}

// ── 고품질 리사이즈 (단계적 절반 축소 + 마지막 고품질 스케일) ──
function highQualityResize(canvas, tw, th) {
  let cur = canvas, cw = canvas.width, ch = canvas.height;
  while (cw > tw * 2 && ch > th * 2) {
    const nw = Math.max(tw, Math.round(cw / 2));
    const nh = Math.max(th, Math.round(ch / 2));
    const t = document.createElement("canvas");
    t.width = nw; t.height = nh;
    const tctx = t.getContext("2d");
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = "high";
    tctx.drawImage(cur, 0, 0, nw, nh);
    cur = t; cw = nw; ch = nh;
  }
  const out = document.createElement("canvas");
  out.width = tw; out.height = th;
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(cur, 0, 0, tw, th);
  return out;
}

// ── 회전 ─────────────────────────────────────────────────────────
function rotateCanvas90CW(src) {
  const out = document.createElement("canvas");
  out.width = src.height; out.height = src.width;
  const ctx = out.getContext("2d");
  ctx.translate(out.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(src, 0, 0);
  return out;
}

function deriveSrc() {
  let c = state.source;
  const steps = (((state.rotation / 90) % 4) + 4) % 4;
  for (let i = 0; i < steps; i++) c = rotateCanvas90CW(c);
  state.src = c;
}

function rotatePointCW(p, w, h) {
  return [h - p[1], p[0]];
}
function rotatePointCCW(p, w, h) {
  return [p[1], w - p[0]];
}

function rotate(clockwise) {
  if (!state.src) return;
  const before = snapshot();
  const w = state.src.width, h = state.src.height;
  const fn = clockwise ? rotatePointCW : rotatePointCCW;
  for (const op of state.ops) {
    if (op.type === "rect" || op.type === "ellipse") {
      const [x1, y1, x2, y2] = op.box;
      const pts = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map((p) => fn(p, w, h));
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      op.box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    } else {
      op.points = op.points.map((p) => fn(p, w, h));
    }
  }
  state.rotation = (state.rotation + (clockwise ? 90 : -90) + 360) % 360;
  deriveSrc();
  commit(before);
  fitView();
}

// ── 실행 취소 ────────────────────────────────────────────────────
function snapshot() {
  return {
    ops: JSON.parse(JSON.stringify(state.ops)),
    rotation: state.rotation,
    selected: state.selected,
  };
}
function commit(before) {
  const now = snapshot();
  if (JSON.stringify(before.ops) !== JSON.stringify(now.ops) || before.rotation !== now.rotation) {
    state.undoStack.push(before);
    if (state.undoStack.length > 60) state.undoStack.shift();
    state.redoStack.length = 0;
  }
  updateStatus();
}
function restore(snap) {
  state.ops = JSON.parse(JSON.stringify(snap.ops));
  state.selected = snap.selected < state.ops.length ? snap.selected : -1;
  if (snap.rotation !== state.rotation) {
    state.rotation = snap.rotation;
    deriveSrc();
  }
  syncControls();
  redraw();
  updateStatus();
}
function undo() {
  if (!state.undoStack.length) return;
  const cur = snapshot();
  restore(state.undoStack.pop());
  state.redoStack.push(cur);
}
function redo() {
  if (!state.redoStack.length) return;
  const cur = snapshot();
  restore(state.redoStack.pop());
  state.undoStack.push(cur);
}
function resetAll() {
  if (!state.src || !state.ops.length) return;
  const before = snapshot();
  state.ops = [];
  state.selected = -1;
  commit(before);
  redraw();
}
function deleteSelected() {
  if (state.selected < 0 || state.selected >= state.ops.length) return;
  const before = snapshot();
  state.ops.splice(state.selected, 1);
  state.selected = -1;
  commit(before);
  redraw();
}

// ── 복사 / 붙여넣기 / 이동 ──────────────────────────────────────
function copySelected() {
  if (state.selected >= 0 && state.selected < state.ops.length) {
    state.clipboard = JSON.parse(JSON.stringify(state.ops[state.selected]));
    toast("영역을 복사했습니다 · Ctrl+V 로 붙여넣으세요.");
  } else {
    toast("먼저 선택 도구로 가릴 영역을 클릭해 주세요.");
  }
}
function pasteOp() {
  if (!state.src) return;
  if (!state.clipboard) { toast("복사된 영역이 없습니다. 먼저 Ctrl+C 로 복사해 주세요."); return; }
  const W = state.src.width, H = state.src.height;
  const before = snapshot();
  const op = JSON.parse(JSON.stringify(state.clipboard));
  const off = 24;
  if (op.type === "rect" || op.type === "ellipse") {
    let [x1, y1, x2, y2] = op.box;
    const w = x2 - x1, h = y2 - y1;
    const nx1 = Math.min(x1 + off, Math.max(0, W - w));
    const ny1 = Math.min(y1 + off, Math.max(0, H - h));
    op.box = [nx1, ny1, nx1 + w, ny1 + h];
  } else {
    const xs = op.points.map((p) => p[0]), ys = op.points.map((p) => p[1]);
    const dx = Math.max(...xs) + off <= W ? off : Math.max(0, W - Math.max(...xs));
    const dy = Math.max(...ys) + off <= H ? off : Math.max(0, H - Math.max(...ys));
    op.points = op.points.map((p) => [p[0] + dx, p[1] + dy]);
  }
  state.ops.push(op);
  state.selected = state.ops.length - 1;
  setTool("select");
  syncControls();
  commit(before);
  redraw();
  toast("붙여넣었습니다 · 방향키로 위치를 조정할 수 있습니다.");
}
function nudgeSelected(dx, dy) {
  if (state.selected < 0 || state.selected >= state.ops.length || !state.src) return;
  const W = state.src.width, H = state.src.height;
  const before = snapshot();
  const op = state.ops[state.selected];
  if (op.type === "rect" || op.type === "ellipse") {
    let [x1, y1, x2, y2] = op.box;
    const w = x2 - x1, h = y2 - y1;
    const nx1 = Math.min(Math.max(0, x1 + dx), W - w);
    const ny1 = Math.min(Math.max(0, y1 + dy), H - h);
    op.box = [nx1, ny1, nx1 + w, ny1 + h];
  } else {
    const xs = op.points.map((p) => p[0]), ys = op.points.map((p) => p[1]);
    let ddx = dx, ddy = dy;
    if (Math.min(...xs) + ddx < 0) ddx = -Math.min(...xs);
    if (Math.max(...xs) + ddx > W) ddx = W - Math.max(...xs);
    if (Math.min(...ys) + ddy < 0) ddy = -Math.min(...ys);
    if (Math.max(...ys) + ddy > H) ddy = H - Math.max(...ys);
    op.points = op.points.map((p) => [p[0] + ddx, p[1] + ddy]);
  }
  commit(before);
  redraw();
}

// ── DOM 참조 ─────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const wrap = $("canvasWrap");
const view = $("view");
const vctx = view.getContext("2d");
const placeholder = $("placeholder");
const fileInput = $("fileInput");

// ── 아이콘 (SVG) ─────────────────────────────────────────────────
const ICONS = {
  rect: `<svg class="icon" viewBox="0 0 20 20"><rect x="3" y="5" width="14" height="10" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
  ellipse: `<svg class="icon" viewBox="0 0 20 20"><ellipse cx="10" cy="10" rx="7" ry="6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
  free: `<svg class="icon" viewBox="0 0 20 20"><path d="M3 16 L8 6 L12 12 L17 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="17" cy="4" r="1.6" fill="currentColor"/></svg>`,
  select: `<svg class="icon" viewBox="0 0 20 20"><path d="M10 2 L10 18 M2 10 L18 10 M10 2 L7 5 M10 2 L13 5 M10 18 L7 15 M10 18 L13 15 M2 10 L5 7 M2 10 L5 13 M18 10 L15 7 M18 10 L15 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

// ── 사이드바 빌드 ────────────────────────────────────────────────
const TOOLS = [["rect", "사각형"], ["ellipse", "원"], ["free", "자유 그리기"], ["select", "선택"]];
const EFFECTS = [["blur", "블러"], ["mosaic", "모자이크"], ["solid", "검은색"]];
const EDITS = [
  ["↶ 되돌리기", undo], ["↷ 다시 실행", redo],
  ["영역 복사", copySelected], ["붙여넣기", pasteOp],
  ["선택 지우기", deleteSelected], ["전체 지우기", resetAll],
  ["↺ 왼쪽 회전", () => rotate(false)], ["↻ 오른쪽 회전", () => rotate(true)],
];

const toolGrid = $("toolGrid");
const toolButtons = {};
for (const [v, label] of TOOLS) {
  const b = document.createElement("button");
  b.className = "tool-btn";
  b.innerHTML = ICONS[v] + `<span>${label}</span>`;
  b.onclick = () => setTool(v);
  toolGrid.appendChild(b);
  toolButtons[v] = b;
}

const effGrid = $("effGrid");
const effButtons = {};
for (const [v, label] of EFFECTS) {
  const b = document.createElement("button");
  b.className = "eff-btn";
  b.textContent = label;
  b.onclick = () => setEffect(v);
  effGrid.appendChild(b);
  effButtons[v] = b;
}

const editGrid = $("editGrid");
for (const [label, fn] of EDITS) {
  const b = document.createElement("button");
  b.className = "act-btn";
  b.textContent = label;
  b.onclick = fn;
  editGrid.appendChild(b);
}

function setTool(v) {
  state.tool = v;
  state.freePoints = [];
  state.drawing = false;
  for (const [k, b] of Object.entries(toolButtons)) b.classList.toggle("active", k === v);
  view.style.cursor = v === "select" ? "pointer" : "crosshair";
  redraw();
}
function setEffect(v) {
  state.effect = v;
  for (const [k, b] of Object.entries(effButtons)) b.classList.toggle("active", k === v);
  $("strength").disabled = v === "solid";
  if (state.selected >= 0 && state.selected < state.ops.length) {
    const before = snapshot();
    state.ops[state.selected].effect = v;
    commit(before);
  }
  redraw();
}
function setEffectQuiet(v) {
  state.effect = v;
  for (const [k, b] of Object.entries(effButtons)) b.classList.toggle("active", k === v);
  $("strength").disabled = v === "solid";
}

$("strength").addEventListener("input", () => {
  const val = parseInt($("strength").value, 10);
  state.strength = val;
  $("strengthLabel").textContent = `강도  ${val}`;
  if (state.selected >= 0 && state.selected < state.ops.length) {
    state.ops[state.selected].strength = val;
    state.ops[state.selected].effect = state.effect;
    redraw();
  }
});
$("applyAllBtn").onclick = () => {
  if (!state.ops.length) return;
  const before = snapshot();
  for (const op of state.ops) { op.effect = state.effect; op.strength = state.strength; }
  commit(before);
  redraw();
  toast(`${state.ops.length}개 영역에 적용했습니다.`);
};

function syncControls() {
  if (state.selected >= 0 && state.selected < state.ops.length) {
    const op = state.ops[state.selected];
    setEffectQuiet(op.effect || "blur");
    const val = op.strength ?? 60;
    state.strength = val;
    $("strength").value = val;
    $("strengthLabel").textContent = `강도  ${val}`;
  }
}

// ── 파일 열기 ────────────────────────────────────────────────────
$("openBtn").onclick = () => fileInput.click();
fileInput.onchange = () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); fileInput.value = ""; };

for (const ev of ["dragover", "dragenter"]) {
  window.addEventListener(ev, (e) => { e.preventDefault(); });
}
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && f.type.startsWith("image/")) loadFile(f);
});

async function loadFile(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const c = document.createElement("canvas");
    c.width = bitmap.width; c.height = bitmap.height;
    c.getContext("2d").drawImage(bitmap, 0, 0);
    state.source = c;
    state.rotation = 0;
    deriveSrc();
    state.ops = [];
    state.selected = -1;
    state.undoStack = [];
    state.redoStack = [];
    state.pan = { x: 0, y: 0 };
    state.filenameStem = file.name.replace(/\.[^.]+$/, "");
    $("fname").textContent = file.name;
    placeholder.classList.add("hidden");
    fitView();
    updateStatus();
  } catch (e) {
    alert("사진을 열 수 없습니다.\n" + e);
  }
}

// ── 보기 (줌/이동/맞춤) ──────────────────────────────────────────
function fitView() {
  if (!state.src) return;
  const cw = Math.max(200, wrap.clientWidth - 24);
  const ch = Math.max(200, wrap.clientHeight - 24);
  state.zoom = Math.min(cw / state.src.width, ch / state.src.height, 1);
  state.pan = { x: 0, y: 0 };
  $("zoomLabel").textContent = Math.round(state.zoom * 100) + "%";
  redraw();
}
function changeZoom(mult) {
  if (!state.src) return;
  state.zoom = Math.max(0.05, Math.min(6, state.zoom * mult));
  $("zoomLabel").textContent = Math.round(state.zoom * 100) + "%";
  redraw();
}
$("fitBtn").onclick = fitView;
$("zoomIn").onclick = () => changeZoom(1.2);
$("zoomOut").onclick = () => changeZoom(1 / 1.2);
wrap.addEventListener("wheel", (e) => {
  if (!state.src) return;
  e.preventDefault();
  changeZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });
window.addEventListener("resize", () => redraw());

// ── 화면 그리기 ──────────────────────────────────────────────────
function resizeCanvasToWrap() {
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  view.width = Math.max(1, Math.round(w * dpr));
  view.height = Math.max(1, Math.round(h * dpr));
  view.style.width = w + "px";
  view.style.height = h + "px";
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

function redraw() {
  const { w: cw, h: ch } = resizeCanvasToWrap();
  vctx.clearRect(0, 0, cw, ch);
  if (!state.src) { state.displayRect = null; return; }

  const rendered = render();
  const dw = rendered.width * state.zoom, dh = rendered.height * state.zoom;
  const x = Math.max(12, (cw - dw) / 2) + state.pan.x;
  const y = Math.max(12, (ch - dh) / 2) + state.pan.y;
  state.displayRect = { x, y, w: dw, h: dh, imgW: rendered.width, imgH: rendered.height };
  vctx.drawImage(rendered, 0, 0, rendered.width, rendered.height, x, y, dw, dh);

  drawSelection();
  drawPending();
}

function drawSelection() {
  if (state.selected < 0 || state.selected >= state.ops.length || !state.displayRect) return;
  const op = state.ops[state.selected];
  const [bx1, by1, bx2, by2] = opBBox(op);
  const { x: ox, y: oy } = state.displayRect;
  const z = state.zoom;
  const x1 = ox + bx1 * z, y1 = oy + by1 * z, x2 = ox + bx2 * z, y2 = oy + by2 * z;
  vctx.save();
  vctx.strokeStyle = ACCENT;
  vctx.lineWidth = 2;
  vctx.setLineDash([5, 4]);
  vctx.beginPath();
  if (op.type === "ellipse") ellipsePathOn(vctx, x1, y1, x2, y2);
  else vctx.rect(x1, y1, x2 - x1, y2 - y1);
  vctx.stroke();
  vctx.setLineDash([]);
  vctx.fillStyle = "#fff";
  for (const [hx, hy] of [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]) {
    vctx.fillRect(hx - 5, hy - 5, 10, 10);
    vctx.strokeRect(hx - 5, hy - 5, 10, 10);
  }
  vctx.restore();
}

function drawPending() {
  if (!state.displayRect) return;
  const { x: ox, y: oy } = state.displayRect;
  const z = state.zoom;
  vctx.save();
  vctx.strokeStyle = ACCENT;
  vctx.lineWidth = 2;
  vctx.setLineDash([6, 4]);
  if (state.tool === "free" && state.freePoints.length) {
    const pts = state.freePoints.map((p) => [ox + p[0] * z, oy + p[1] * z]);
    if (state.current) pts.push([ox + state.current[0] * z, oy + state.current[1] * z]);
    if (pts.length >= 2) {
      vctx.beginPath();
      vctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) vctx.lineTo(pts[i][0], pts[i][1]);
      vctx.stroke();
    }
    vctx.setLineDash([]);
    vctx.fillStyle = "#fff";
    for (const [px, py] of pts.slice(0, state.freePoints.length)) {
      vctx.beginPath(); vctx.arc(px, py, 4, 0, Math.PI * 2); vctx.fill();
      vctx.strokeStyle = ACCENT; vctx.stroke();
    }
  } else if (state.drawing && state.start && state.current) {
    const x1 = ox + state.start[0] * z, y1 = oy + state.start[1] * z;
    const x2 = ox + state.current[0] * z, y2 = oy + state.current[1] * z;
    vctx.beginPath();
    if (state.tool === "ellipse") ellipsePathOn(vctx, x1, y1, x2, y2);
    else vctx.rect(x1, y1, x2 - x1, y2 - y1);
    vctx.stroke();
  }
  vctx.restore();
}

// ── 좌표 변환 & 히트 테스트 ──────────────────────────────────────
function toImg(clientX, clientY, clamp) {
  if (!state.displayRect || !state.src) return null;
  const rect = wrap.getBoundingClientRect();
  const sx = clientX - rect.left, sy = clientY - rect.top;
  const { x, y } = state.displayRect;
  let ix = (sx - x) / state.zoom, iy = (sy - y) / state.zoom;
  const w = state.src.width, h = state.src.height;
  if (clamp) return [Math.max(0, Math.min(w, ix)), Math.max(0, Math.min(h, iy))];
  if (ix < 0 || iy < 0 || ix > w || iy > h) return null;
  return [ix, iy];
}

function hitTest(p) {
  if (!p) return [-1, null];
  const [x, y] = p;
  const tol = 10 / Math.max(state.zoom, 1e-6);
  for (let i = state.ops.length - 1; i >= 0; i--) {
    const op = state.ops[i];
    const [x1, y1, x2, y2] = opBBox(op);
    for (const [hx, hy, name] of [[x1, y1, "nw"], [x2, y1, "ne"], [x2, y2, "se"], [x1, y2, "sw"]]) {
      if (Math.abs(x - hx) <= tol && Math.abs(y - hy) <= tol) return [i, name];
    }
    if (op.type === "free") {
      if (pointInPoly([x, y], op.points)) return [i, "move"];
    } else if (x1 <= x && x <= x2 && y1 <= y && y <= y2) {
      return [i, "move"];
    }
  }
  return [-1, null];
}

function modifySelected(p) {
  const op = state.ops[state.selected];
  const H = state.src.height, W = state.src.width;
  if (op.type === "rect" || op.type === "ellipse") {
    let [x1, y1, x2, y2] = op.box;
    const m = state.dragMode;
    if (m === "move") {
      let dx = p[0] - state.dragAnchor[0], dy = p[1] - state.dragAnchor[1];
      dx = Math.max(-x1, Math.min(W - x2, dx));
      dy = Math.max(-y1, Math.min(H - y2, dy));
      op.box = [x1 + dx, y1 + dy, x2 + dx, y2 + dy];
      state.dragAnchor = p;
      return;
    }
    if (m === "nw" || m === "sw") x1 = Math.max(0, Math.min(p[0], x2 - 8));
    if (m === "ne" || m === "se") x2 = Math.min(W, Math.max(p[0], x1 + 8));
    if (m === "nw" || m === "ne") y1 = Math.max(0, Math.min(p[1], y2 - 8));
    if (m === "sw" || m === "se") y2 = Math.min(H, Math.max(p[1], y1 + 8));
    op.box = [x1, y1, x2, y2];
    state.dragAnchor = p;
  } else if (state.dragMode === "move") {
    let dx = p[0] - state.dragAnchor[0], dy = p[1] - state.dragAnchor[1];
    const xs = op.points.map((q) => q[0]), ys = op.points.map((q) => q[1]);
    dx = Math.max(-Math.min(...xs), Math.min(W - Math.max(...xs), dx));
    dy = Math.max(-Math.min(...ys), Math.min(H - Math.max(...ys), dy));
    op.points = op.points.map(([x, y]) => [x + dx, y + dy]);
    state.dragAnchor = p;
  }
}

// ── 마우스 / 포인터 이벤트 ───────────────────────────────────────
view.addEventListener("pointerdown", (e) => {
  if (!state.src) return;
  if (e.button === 1 || e.button === 2) {
    state.panAnchor = [e.clientX, e.clientY];
    view.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button !== 0) return;
  const p = toImg(e.clientX, e.clientY, false);
  if (state.tool === "select") {
    if (!p) return;
    const [idx, mode] = hitTest(p);
    state.selected = idx;
    if (idx >= 0) {
      state.dragMode = mode;
      state.dragAnchor = p;
      state.dragBefore = snapshot();
      syncControls();
      view.setPointerCapture(e.pointerId);
    }
    redraw();
    return;
  }
  if (!p) return;
  if (state.tool === "free") {
    if (!state.drawing) { state.drawing = true; state.freePoints = [p]; }
    else state.freePoints.push(p);
    state.current = p;
    redraw();
    return;
  }
  state.drawing = true;
  state.start = p;
  state.current = p;
  view.setPointerCapture(e.pointerId);
  redraw();
});

view.addEventListener("pointermove", (e) => {
  if (!state.src) return;
  if (state.panAnchor) {
    state.pan.x += e.clientX - state.panAnchor[0];
    state.pan.y += e.clientY - state.panAnchor[1];
    state.panAnchor = [e.clientX, e.clientY];
    redraw();
    return;
  }
  const p = toImg(e.clientX, e.clientY, true);
  if (!p) return;
  state.current = p;
  if (state.tool === "select" && state.selected >= 0 && state.dragMode) {
    modifySelected(p);
    redraw();
  } else if (state.drawing) {
    redraw();
  } else if (state.tool === "select") {
    const [, mode] = hitTest(toImg(e.clientX, e.clientY, false));
    view.style.cursor = mode === "move" ? "grab" : mode ? "nwse-resize" : "pointer";
  }
});

window.addEventListener("pointerup", (e) => {
  if (!state.src) return;
  if (state.panAnchor) { state.panAnchor = null; return; }
  const p = toImg(e.clientX, e.clientY, true);
  if (state.tool === "select") {
    if (state.dragBefore) commit(state.dragBefore);
    state.dragMode = null; state.dragAnchor = null; state.dragBefore = null;
    redraw();
    return;
  }
  if (state.tool === "free") return;
  if (state.drawing && state.start && p) {
    if (Math.abs(p[0] - state.start[0]) > 4 && Math.abs(p[1] - state.start[1]) > 4) {
      const before = snapshot();
      state.ops.push({
        type: state.tool,
        box: [Math.min(state.start[0], p[0]), Math.min(state.start[1], p[1]),
              Math.max(state.start[0], p[0]), Math.max(state.start[1], p[1])],
        effect: state.effect,
        strength: state.strength,
      });
      state.selected = state.ops.length - 1;
      commit(before);
    }
    state.drawing = false; state.start = null; state.current = null;
    redraw();
  }
});

view.addEventListener("dblclick", () => { if (state.tool === "free") finishFree(); });
wrap.addEventListener("contextmenu", (e) => e.preventDefault());

function finishFree() {
  if (state.tool === "free" && state.drawing && state.freePoints.length >= 3) {
    const before = snapshot();
    state.ops.push({ type: "free", points: state.freePoints.slice(), effect: state.effect, strength: state.strength });
    state.selected = state.ops.length - 1;
    commit(before);
  }
  state.drawing = false; state.freePoints = []; state.current = null;
  redraw();
}
function cancelCurrent() {
  state.drawing = false; state.freePoints = []; state.start = null; state.current = null; state.selected = -1;
  redraw();
}

// ── 상태 표시 / 토스트 ───────────────────────────────────────────
let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
function updateStatus() {
  if (!state.src) { $("status").textContent = "사진을 열어 주세요."; return; }
  $("status").textContent = `${state.src.width} × ${state.src.height}px · 가림 영역 ${state.ops.length}개`;
}

// ── 저장 (크기 지정 대화상자) ────────────────────────────────────
function supportsWebP() {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    return c.toDataURL("image/webp").indexOf("data:image/webp") === 0;
  } catch (e) {
    return false;
  }
}

function openSaveDialog() {
  if (!state.src) { toast("먼저 사진을 열어 주세요."); return; }
  const w = state.src.width, h = state.src.height;
  const ratio = w / h;
  const webpOK = supportsWebP();
  const defaultFmt = webpOK ? "webp" : "jpeg";

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <h3>저장 크기</h3>
      <label class="radio"><input type="radio" name="szmode" value="original" checked> 원본 크기 그대로  (${w} × ${h}px)</label>
      <label class="radio"><input type="radio" name="szmode" value="custom"> 크기 지정</label>
      <div class="size-row">
        <span>가로</span><input type="number" id="szW" value="${w}" min="1" max="${w}" disabled>
        <span>세로</span><input type="number" id="szH" value="${h}" min="1" max="${h}" disabled>
        <span style="color:var(--muted);font-size:11px;">px</span>
      </div>
      <p class="tip" id="szTip">한쪽 값만 입력해도 비율에 맞춰 나머지가 채워집니다. 원본(${w}×${h}px)보다 크게는 저장할 수 없습니다 — 더 키우면 화질만 나빠지기 때문입니다.</p>

      <h3 style="margin-top:4px;">파일 형식</h3>
      <label class="radio"><input type="radio" name="szfmt" value="webp" ${defaultFmt === "webp" ? "checked" : ""} ${webpOK ? "" : "disabled"}>
        WebP — 용량을 크게 줄이면서 화질 차이는 거의 없음 (추천)${webpOK ? "" : " · 이 브라우저에서는 지원하지 않음"}</label>
      <label class="radio"><input type="radio" name="szfmt" value="jpeg" ${defaultFmt === "jpeg" ? "checked" : ""}> JPEG — 문서·이메일 첨부 시 호환성이 가장 좋음</label>
      <label class="radio"><input type="radio" name="szfmt" value="png"> PNG — 무손실이라 용량이 가장 큼</label>

      <div class="size-row" id="qualityRow">
        <span>압축률</span>
        <input type="range" id="szQuality" min="40" max="100" value="92" style="flex:1;">
        <span id="szQualityLabel" style="width:30px;text-align:right;font-size:12px;">92</span>
      </div>
      <p class="tip">숫자가 낮을수록 파일은 작아지지만 화질도 함께 낮아집니다. 90 안팎이면 눈으로는 원본과 거의 구분되지 않으면서 용량은 크게 줄어듭니다.</p>

      <div class="btns">
        <button id="szCancel">취소</button>
        <button id="szOk" class="btn-primary">저장</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const szW = backdrop.querySelector("#szW");
  const szH = backdrop.querySelector("#szH");
  const szQuality = backdrop.querySelector("#szQuality");
  const szQualityLabel = backdrop.querySelector("#szQualityLabel");
  const qualityRow = backdrop.querySelector("#qualityRow");
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  const radios = backdrop.querySelectorAll('input[name="szmode"]');
  let guard = false;
  radios.forEach((r) => r.addEventListener("change", () => {
    const custom = backdrop.querySelector('input[name="szmode"]:checked').value === "custom";
    szW.disabled = !custom; szH.disabled = !custom;
  }));
  szW.addEventListener("input", () => {
    if (guard) return;
    let v = parseFloat(szW.value);
    if (!v || v <= 0) return;
    v = clamp(Math.round(v), 1, w);
    guard = true;
    szW.value = v;
    szH.value = clamp(Math.round(v / ratio), 1, h);
    guard = false;
  });
  szH.addEventListener("input", () => {
    if (guard) return;
    let v = parseFloat(szH.value);
    if (!v || v <= 0) return;
    v = clamp(Math.round(v), 1, h);
    guard = true;
    szH.value = v;
    szW.value = clamp(Math.round(v * ratio), 1, w);
    guard = false;
  });

  backdrop.querySelectorAll('input[name="szfmt"]').forEach((r) => r.addEventListener("change", () => {
    const fmt = backdrop.querySelector('input[name="szfmt"]:checked').value;
    qualityRow.style.display = fmt === "png" ? "none" : "flex";
  }));
  szQuality.addEventListener("input", () => { szQualityLabel.textContent = szQuality.value; });

  const closeDialog = () => { window.removeEventListener("keydown", onEsc, true); backdrop.remove(); };
  const onEsc = (e) => { if (e.key === "Escape") closeDialog(); };
  window.addEventListener("keydown", onEsc, true);
  backdrop.querySelector("#szCancel").onclick = closeDialog;
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeDialog(); });
  backdrop.querySelector("#szOk").onclick = () => {
    const mode = backdrop.querySelector('input[name="szmode"]:checked').value;
    let target = null;
    if (mode === "custom") {
      const tw = clamp(Math.max(1, Math.round(parseFloat(szW.value))), 1, w);
      const th = clamp(Math.max(1, Math.round(parseFloat(szH.value))), 1, h);
      if (!tw || !th) { alert("가로/세로 값을 확인해 주세요."); return; }
      target = [tw, th];
    }
    const format = backdrop.querySelector('input[name="szfmt"]:checked').value;
    const quality = parseInt(szQuality.value, 10) / 100;
    closeDialog();
    doSave(target, format, quality);
  };
}

async function saveBlob(blob, suggestedName) {
  if (window.showSaveFilePicker) {
    try {
      const ext = suggestedName.split(".").pop();
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: "이미지", accept: { [blob.type]: ["." + ext] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;
      // 실패 시 일반 다운로드로 대체
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = suggestedName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function doSave(targetSize, format = "png", quality = 0.92) {
  const rendered = render();
  let finalCanvas = rendered;
  if (targetSize && (targetSize[0] !== rendered.width || targetSize[1] !== rendered.height)) {
    finalCanvas = highQualityResize(rendered, targetSize[0], targetSize[1]);
  }
  const mime = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
  const ext = format === "jpeg" ? "jpg" : format === "webp" ? "webp" : "png";
  const tag = targetSize ? `_${targetSize[0]}x${targetSize[1]}` : "";
  const name = `${state.filenameStem}_가림${tag}.${ext}`;
  finalCanvas.toBlob(async (blob) => {
    if (!blob) { toast("저장하지 못했습니다. 다른 형식으로 다시 시도해 주세요."); return; }
    await saveBlob(blob, name);
    const kb = (blob.size / 1024).toFixed(0);
    toast(`저장했습니다 · ${finalCanvas.width} × ${finalCanvas.height}px · 약 ${kb}KB`);
  }, mime, format === "png" ? undefined : quality);
}
$("saveBtn").onclick = openSaveDialog;

// ── 얼굴 자동 찾기 (MediaPipe Face Detector, WASM) ───────────────
let faceDetectorPromise = null;
async function getFaceDetector() {
  if (!faceDetectorPromise) {
    faceDetectorPromise = (async () => {
      const { FaceDetector, FilesetResolver } = await import(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14"
      );
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      );
      return await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
        },
        runningMode: "IMAGE",
      });
    })();
  }
  return faceDetectorPromise;
}

async function autoFaces() {
  if (!state.src) { toast("먼저 사진을 열어 주세요."); return; }
  $("autoBtn").disabled = true;
  toast("얼굴을 찾는 중입니다…");
  let detector;
  try {
    detector = await getFaceDetector();
  } catch (e) {
    console.error("얼굴 인식 모델을 불러오는 데 실패했습니다:", e);
    toast("얼굴 인식 기능을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요. (자세한 내용은 개발자 도구 콘솔 참고)");
    $("autoBtn").disabled = false;
    return;
  }
  let result;
  try {
    result = detector.detect(state.src);
  } catch (e) {
    console.error("얼굴을 찾는 중 문제가 생겼습니다:", e);
    toast("얼굴을 찾는 중 문제가 생겼습니다.");
    $("autoBtn").disabled = false;
    return;
  }
  $("autoBtn").disabled = false;
  const dets = result.detections || [];
  if (!dets.length) { toast("얼굴을 찾지 못했습니다. 직접 영역을 그려 주세요."); return; }

  const W = state.src.width, H = state.src.height;
  const before = snapshot();
  for (const d of dets) {
    const bb = d.boundingBox;
    const padx = bb.width * 0.16, padyT = bb.height * 0.26, padyB = bb.height * 0.14;
    const x1 = Math.max(0, bb.originX - padx), y1 = Math.max(0, bb.originY - padyT);
    const x2 = Math.min(W, bb.originX + bb.width + padx), y2 = Math.min(H, bb.originY + bb.height + padyB);
    state.ops.push({ type: "ellipse", box: [x1, y1, x2, y2], effect: state.effect, strength: state.strength });
  }
  state.selected = state.ops.length - 1;
  commit(before);
  redraw();
  toast(`얼굴 ${dets.length}곳을 가렸습니다. 크기는 선택 도구로 조절할 수 있습니다.`);
}
$("autoBtn").onclick = autoFaces;

// ── 단축키 ───────────────────────────────────────────────────────
function isTextFocus() {
  const el = document.activeElement;
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
}
window.addEventListener("keydown", (e) => {
  if (isTextFocus()) {
    if (e.key === "Escape") document.activeElement.blur();
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (ctrl && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (ctrl && e.key.toLowerCase() === "s") { e.preventDefault(); openSaveDialog(); }
  else if (ctrl && e.key.toLowerCase() === "o") { e.preventDefault(); fileInput.click(); }
  else if (ctrl && e.key.toLowerCase() === "c") { e.preventDefault(); copySelected(); }
  else if (ctrl && e.key.toLowerCase() === "v") { e.preventDefault(); pasteOp(); }
  else if (e.key === "Delete" || e.key === "Backspace") { if (state.selected >= 0) { e.preventDefault(); deleteSelected(); } }
  else if (e.key === "Enter") { finishFree(); }
  else if (e.key === "Escape") { cancelCurrent(); }
  else if (e.key.startsWith("Arrow") && state.tool === "select") {
    e.preventDefault();
    const step = 10;
    if (e.key === "ArrowLeft") nudgeSelected(-step, 0);
    else if (e.key === "ArrowRight") nudgeSelected(step, 0);
    else if (e.key === "ArrowUp") nudgeSelected(0, -step);
    else if (e.key === "ArrowDown") nudgeSelected(0, step);
  }
});

// ── 시작 ─────────────────────────────────────────────────────────
setTool("rect");
setEffect("blur");
updateStatus();
redraw();
