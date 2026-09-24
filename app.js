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
  hover: -1,          // 마우스를 올려 둔 영역(선택 도구일 때만)
  showOutlines: true, // 모든 가림 영역의 얇은 테두리·번호 표시 여부
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
  panStart: null,
  panMoved: false,
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

// 화면 그리기용 캐시 — 사진(회전 포함)과 가림 영역이 그대로면 이미 만든 결과를 다시 씁니다.
// (패닝·확대·마우스 호버처럼 내용이 안 바뀌는 다시 그리기를 가볍게 하기 위함. 저장은 항상 render()로 새로 만듭니다)
const renderCache = { src: null, key: "", canvas: null };
function renderCached() {
  if (!state.src) return null;
  const key = JSON.stringify(state.ops);
  if (renderCache.canvas && renderCache.src === state.src && renderCache.key === key) return renderCache.canvas;
  const canvas = render();
  renderCache.src = state.src; renderCache.key = key; renderCache.canvas = canvas;
  return canvas;
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
  state.hover = -1;
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
  state.hover = -1;
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
  ["영역 복사", copySelected], ["붙여넣기", pasteOp],
  ["선택 지우기", deleteSelected], ["전체 지우기", resetAll],
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

// 상단 헤더의 실행 취소/다시 실행 버튼 — 기존 undo()/redo()에 그대로 연결
// (레이아웃 개선으로 추가된 버튼일 뿐, 별도의 되돌리기 로직이 아닙니다)
const undoBtnHeader = document.getElementById("undoBtn");
const redoBtnHeader = document.getElementById("redoBtn");
if (undoBtnHeader) undoBtnHeader.onclick = undo;
if (redoBtnHeader) redoBtnHeader.onclick = redo;

// "사진 열기" 바로 아래의 회전 버튼 — 기존 rotate()에 그대로 연결
// (사진을 연 직후 방향을 맞추는 흐름이라 여기 배치가 더 직관적입니다)
const rotateLeftBtn = document.getElementById("rotateLeftBtn");
const rotateRightBtn = document.getElementById("rotateRightBtn");
if (rotateLeftBtn) rotateLeftBtn.onclick = () => rotate(false);
if (rotateRightBtn) rotateRightBtn.onclick = () => rotate(true);

function setTool(v) {
  state.tool = v;
  state.hover = -1;
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

// 내부에서 복사한 가림 영역임을 알리는 표식 글자(시스템 클립보드에 기록됨)
const OP_CLIP_MARK = "[사진 가림 편집기] 가림 영역 복사됨";

// 클립보드 붙여넣기(Ctrl+V) — 한글 문서·인터넷·탐색기 등에서 복사한
// 사진을 그대로 불러옵니다. 이미지가 아니면 아무 것도 하지 않아
// 원래의 붙여넣기 동작(글자 입력칸 등)에 영향을 주지 않습니다.
window.addEventListener("paste", (e) => {
  // 입력창/텍스트 영역에서는 브라우저의 기본 붙여넣기를 그대로 둡니다.
  if (isTextFocus()) return;
  if (document.querySelector(".modal-backdrop")) return;

  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;

  // 0) 이 프로그램에서 Ctrl+C 로 복사한 가림 영역이면(표식 글자로 판별)
  //    시스템 클립보드에 예전 사진이 남아 있어도 사진을 새로 불러오지 않고
  //    가림 영역만 붙여넣습니다. (사진을 불러오면 작업한 영역이 사라지므로)
  const text = e.clipboardData.getData("text/plain");
  if (state.clipboard && text === OP_CLIP_MARK) {
    e.preventDefault();
    pasteOp();
    return;
  }

  // 1) 외부에서 복사한 이미지 → 사진으로 불러오기
  for (const item of items) {
    if (item.kind === "file" && item.type && item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) loadFile(file);
      return;
    }
  }

  // 2) 이미지가 아니라면 프로그램 내부에서 복사해 둔 가림 영역 붙여넣기(예전 동작 유지)
  if (state.clipboard) {
    e.preventDefault();
    pasteOp();
  }
});

// 가림 영역 Ctrl+C 시 시스템 클립보드를 "표식 글자"로 바꿔 둡니다.
// → 그 전에 복사해 둔 사진이 클립보드에 남아 있다가 Ctrl+V 때 딸려 들어오는 것을 막고,
//   나중에 다른 곳에서 사진을 새로 복사하면 그 사진이 정상적으로 우선됩니다.
let pendingOpCopy = false;
window.addEventListener("copy", (e) => {
  if (!pendingOpCopy || isTextFocus()) return;
  pendingOpCopy = false;
  if (e.clipboardData) {
    e.clipboardData.setData("text/plain", OP_CLIP_MARK);
    e.preventDefault();
  }
});
function markOpCopy() {
  pendingOpCopy = true;
}
// 클립보드 API(navigator.clipboard)를 쓰면 크롬이 "클립보드 확인" 권한 창을 띄우므로,
// 보이지 않는 임시 입력칸에 표식 글자를 넣고 브라우저의 기본 복사 명령으로 복사합니다.
// (키보드를 누른 바로 그 순간에 실행되므로 권한 창이 뜨지 않습니다.)
function writeOpMarker() {
  const prev = document.activeElement;
  const ta = document.createElement("textarea");
  ta.value = OP_CLIP_MARK;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
  ta.remove();
  if (prev && prev.focus) { try { prev.focus({ preventScroll: true }); } catch (_) {} }
  return ok;
}

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
  const cw = Math.max(1, wrap.clientWidth);
  const ch = Math.max(1, wrap.clientHeight);
  state.zoom = Math.min(cw / state.src.width, ch / state.src.height, 1);
  state.pan = { x: 0, y: 0 };
  $("zoomLabel").textContent = Math.round(state.zoom * 100) + "%";
  redraw();
}
function getViewMetrics() {
  const cw = Math.max(1, wrap.clientWidth);
  const ch = Math.max(1, wrap.clientHeight);
  if (!state.src) return null;
  // 화면 크기 계산에는 사진 크기만 필요하므로 무거운 렌더링을 하지 않습니다.
  const dw = state.src.width * state.zoom;
  const dh = state.src.height * state.zoom;
  const baseX = Math.max(12, (cw - dw) / 2);
  const baseY = Math.max(12, (ch - dh) / 2);
  return { cw, ch, dw, dh, baseX, baseY };
}

// 확대된 사진이 화면 밖으로 밀려나 흰 여백이 생기지 않도록 패닝 범위를 제한합니다.
// 사진이 화면보다 큰 방향에서는 사진의 양쪽 끝이 화면의 양쪽 끝을 넘지 않습니다.
function clampPan() {
  if (!state.src) return;
  const m = getViewMetrics();
  if (!m) return;

  if (m.dw > m.cw) {
    // 확대된 사진은 해당 방향에서 화면을 완전히 덮도록 제한합니다.
    // 따라서 사진 가장자리가 화면 안쪽으로 넘어가며 흰 여백이 생기지 않습니다.
    const minPanX = m.cw - m.dw - m.baseX;
    const maxPanX = -m.baseX;
    state.pan.x = Math.max(minPanX, Math.min(maxPanX, state.pan.x));
  } else {
    state.pan.x = 0;
  }

  if (m.dh > m.ch) {
    const minPanY = m.ch - m.dh - m.baseY;
    const maxPanY = -m.baseY;
    state.pan.y = Math.max(minPanY, Math.min(maxPanY, state.pan.y));
  } else {
    state.pan.y = 0;
  }
}

// anchorX/anchorY: 확대·축소해도 그 자리에 그대로 있어야 하는 화면 위치(wrap 기준 px). 생략하면 화면 중앙.
function changeZoom(mult, anchorX, anchorY) {
  if (!state.src) return;
  const cw = Math.max(1, wrap.clientWidth), ch = Math.max(1, wrap.clientHeight);
  const ax = anchorX === undefined ? cw / 2 : anchorX;
  const ay = anchorY === undefined ? ch / 2 : anchorY;
  const old = state.displayRect;
  const oldZoom = state.zoom;
  // 기준 위치 아래에 있던 사진 좌표
  const ix = old ? (ax - old.x) / oldZoom : null;
  const iy = old ? (ay - old.y) / oldZoom : null;

  state.zoom = Math.max(0.05, Math.min(6, state.zoom * mult));
  if (old) {
    const dw = state.src.width * state.zoom, dh = state.src.height * state.zoom;
    const baseX = Math.max(12, (cw - dw) / 2), baseY = Math.max(12, (ch - dh) / 2);
    state.pan.x = ax - ix * state.zoom - baseX;   // 그 사진 좌표가 다시 같은 화면 위치에 오도록
    state.pan.y = ay - iy * state.zoom - baseY;
  }
  clampPan();
  $("zoomLabel").textContent = Math.round(state.zoom * 100) + "%";
  redraw();
}
$("fitBtn").onclick = fitView;
$("zoomIn").onclick = () => changeZoom(1.2);
$("zoomOut").onclick = () => changeZoom(1 / 1.2);
wrap.addEventListener("wheel", (e) => {
  if (!state.src) return;
  e.preventDefault();
  const r = wrap.getBoundingClientRect();
  changeZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
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

  const rendered = renderCached();
  const dw = rendered.width * state.zoom, dh = rendered.height * state.zoom;
  const baseX = Math.max(12, (cw - dw) / 2);
  const baseY = Math.max(12, (ch - dh) / 2);
  clampPan();
  const x = baseX + state.pan.x;
  const y = baseY + state.pan.y;
  state.displayRect = { x, y, w: dw, h: dh, imgW: rendered.width, imgH: rendered.height };
  vctx.drawImage(rendered, 0, 0, rendered.width, rendered.height, x, y, dw, dh);

  drawOutlines();
  drawSelection();
  drawPending();
}

// 가림 영역 표시 — 선택된 영역과 나머지를 구분합니다. (화면 미리보기 전용, 저장 결과에는 나오지 않습니다)
//  · 나머지 영역: 얇은 테두리 + 번호   · 마우스를 올린 영역: 미리 강조   · 선택 영역: drawSelection()
function opPathOnView(op) {
  const { x: ox, y: oy } = state.displayRect;
  const z = state.zoom;
  vctx.beginPath();
  if (op.type === "free") {
    polyPathOn(vctx, op.points.map(([px, py]) => [ox + px * z, oy + py * z]));
  } else {
    const [bx1, by1, bx2, by2] = opBBox(op);
    const x1 = ox + bx1 * z, y1 = oy + by1 * z, x2 = ox + bx2 * z, y2 = oy + by2 * z;
    if (op.type === "ellipse") ellipsePathOn(vctx, x1, y1, x2, y2);
    else vctx.rect(x1, y1, x2 - x1, y2 - y1);
  }
}
function drawBadge(n, x, y, kind) {
  const label = String(n);
  vctx.save();
  vctx.font = "700 12px system-ui, -apple-system, 'Malgun Gothic', sans-serif";
  vctx.textBaseline = "middle";
  const w = Math.max(20, vctx.measureText(label).width + 10), h = 18;
  vctx.fillStyle = kind === "normal" ? "rgba(30,30,30,0.72)" : ACCENT;
  vctx.beginPath();
  if (vctx.roundRect) vctx.roundRect(x, y, w, h, 5); else vctx.rect(x, y, w, h);
  vctx.fill();
  vctx.strokeStyle = "rgba(255,255,255,0.9)";
  vctx.lineWidth = 1;
  vctx.stroke();
  vctx.fillStyle = "#fff";
  vctx.textAlign = "center";
  vctx.fillText(label, x + w / 2, y + h / 2 + 0.5);
  vctx.restore();
}
function drawOutlines() {
  if (!state.showOutlines || !state.displayRect || !state.ops.length) return;
  const { x: ox, y: oy } = state.displayRect;
  const z = state.zoom;
  const hover = state.hover >= 0 && state.hover < state.ops.length ? state.hover : -1;
  vctx.save();
  vctx.lineJoin = "round";
  state.ops.forEach((op, i) => {
    if (i === state.selected) return;             // 선택 영역은 drawSelection()이 그림
    opPathOnView(op);
    if (i === hover) {
      vctx.fillStyle = "rgba(47,111,94,0.16)";
      vctx.fill();
      vctx.strokeStyle = "rgba(255,255,255,0.95)"; vctx.lineWidth = 5; vctx.stroke();
      vctx.strokeStyle = ACCENT; vctx.lineWidth = 2.5; vctx.stroke();
    } else {
      vctx.strokeStyle = "rgba(0,0,0,0.45)"; vctx.lineWidth = 3; vctx.stroke();
      vctx.strokeStyle = "rgba(255,255,255,0.95)"; vctx.lineWidth = 1.2; vctx.stroke();
    }
  });
  vctx.restore();
  // 번호 표시 (영역 위쪽 모서리, 자리가 없으면 안쪽)
  state.ops.forEach((op, i) => {
    const [bx1, by1] = opBBox(op);
    const x = ox + bx1 * z;
    let y = oy + by1 * z - 20;
    if (y < 2) y = oy + by1 * z + 2;
    drawBadge(i + 1, x, y, i === state.selected ? "selected" : (i === hover ? "hover" : "normal"));
  });
}

function drawSelection() {
  if (state.selected < 0 || state.selected >= state.ops.length || !state.displayRect) return;
  const op = state.ops[state.selected];
  const [bx1, by1, bx2, by2] = opBBox(op);
  const { x: ox, y: oy } = state.displayRect;
  const z = state.zoom;
  const x1 = ox + bx1 * z, y1 = oy + by1 * z, x2 = ox + bx2 * z, y2 = oy + by2 * z;
  vctx.save();
  // 흰 바탕선을 먼저 깔아 다른 얇은 테두리보다 확실히 눈에 띄게 합니다.
  vctx.beginPath();
  if (op.type === "ellipse") ellipsePathOn(vctx, x1, y1, x2, y2);
  else vctx.rect(x1, y1, x2 - x1, y2 - y1);
  vctx.strokeStyle = "rgba(255,255,255,0.95)";
  vctx.lineWidth = 5;
  vctx.stroke();
  vctx.strokeStyle = ACCENT;
  vctx.lineWidth = 2.5;
  vctx.setLineDash([5, 4]);
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
  wrap.focus(); // 이 영역에 초점을 둬서 Ctrl+V가 항상 확실히 동작하게 합니다.
  if (e.button === 1 || e.button === 2) {
    state.panAnchor = [e.clientX, e.clientY];
    state.panStart = [e.clientX, e.clientY];
    state.panMoved = false;
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
      // 가림 영역 위에서는 기존처럼 영역 이동/크기 조절
      state.dragMode = mode;
      state.dragAnchor = p;
      state.dragBefore = snapshot();
      syncControls();
      view.setPointerCapture(e.pointerId);
    } else {
      // 확대되어 사진이 화면보다 큰 경우, 빈 사진 부분을 드래그하면 패닝
      const canPan = state.displayRect &&
        (state.displayRect.w > wrap.clientWidth || state.displayRect.h > wrap.clientHeight);
      if (canPan) {
        state.panAnchor = [e.clientX, e.clientY];
        state.panStart = [e.clientX, e.clientY];
        state.panMoved = false;
        view.setPointerCapture(e.pointerId);
        view.style.cursor = "grabbing";
      }
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
    if (state.panStart && (Math.abs(e.clientX - state.panStart[0]) > 3 || Math.abs(e.clientY - state.panStart[1]) > 3)) {
      state.panMoved = true;
    }
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
    const p2 = toImg(e.clientX, e.clientY, false);
    const [hidx, mode] = hitTest(p2);
    const nh = state.showOutlines ? hidx : -1;
    if (nh !== state.hover) { state.hover = nh; redraw(); }   // 바뀔 때만 다시 그림
    const canPan = state.displayRect &&
      (state.displayRect.w > wrap.clientWidth || state.displayRect.h > wrap.clientHeight);
    view.style.cursor = mode === "move" ? "grab" : mode ? "nwse-resize" : (canPan ? "grab" : "pointer");
  }
});

window.addEventListener("pointerup", (e) => {
  if (!state.src) return;
  if (state.panAnchor) {
    state.panAnchor = null;
    state.panStart = null;
    state.panMoved = false;
    if (state.tool === "select") view.style.cursor = "grab";
    return;
  }
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

view.addEventListener("pointerleave", () => {
  if (state.hover !== -1) { state.hover = -1; redraw(); }
});

// 영역 표시 켜기/끄기 (상단 버튼 또는 H 키)
const outlineBtn = document.getElementById("outlineBtn");
function setOutlines(on, save) {
  state.showOutlines = !!on;
  state.hover = -1;
  if (outlineBtn) {
    outlineBtn.classList.toggle("on", state.showOutlines);
    outlineBtn.setAttribute("aria-pressed", String(state.showOutlines));
  }
  if (save) { try { localStorage.setItem("pbe.showOutlines", state.showOutlines ? "1" : "0"); } catch (_) {} }
  redraw();
}
if (outlineBtn) outlineBtn.onclick = () => setOutlines(!state.showOutlines, true);
try { if (localStorage.getItem("pbe.showOutlines") === "0") state.showOutlines = false; } catch (_) {}

view.addEventListener("dblclick", () => { if (state.tool === "free") finishFree(); });
// 오른쪽 버튼으로 실제로 드래그(화면 이동)했을 때만 뒤이어 뜨는 메뉴를 막고,
// 그냥 오른쪽 클릭만 했을 때는 평소처럼 브라우저 메뉴(붙여넣기 등)가 뜨게 둡니다.
wrap.addEventListener("contextmenu", (e) => {
  if (state.panMoved) { e.preventDefault(); }
  state.panMoved = false;
});

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
  const duration = Math.min(7000, Math.max(2600, msg.length * 60));
  toastTimer = setTimeout(() => el.classList.remove("show"), duration);
}
function updateStatus() {
  if (!state.src) { $("status").textContent = "사진을 열어 주세요."; return; }
  $("status").textContent = `${state.src.width} × ${state.src.height}px · 가림 영역 ${state.ops.length}개`;
}

// 예상치 못한 오류가 조용히 묻히지 않도록 하는 안전망입니다.
window.addEventListener("error", (e) => {
  console.error("처리되지 않은 오류:", e.error || e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("처리되지 않은 프로미스 오류:", e.reason);
  const autoBtn = document.getElementById("autoBtn");
  if (autoBtn && autoBtn.disabled) {
    autoBtn.disabled = false;
    toast("예상치 못한 오류가 발생했습니다. 개발자 도구 콘솔을 확인해 주세요.");
  }
});

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
  const defaultFmt = "jpeg";

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <h3>저장·복사 크기</h3>
      <label class="radio"><input type="radio" name="szmode" value="original"> 원본 크기 그대로  (${w} × ${h}px)</label>
      <label class="radio"><input type="radio" name="szmode" value="custom" checked> 크기 지정</label>
      <div class="size-row">
        <span>가로</span><input type="number" id="szW" value="${w}" min="1" max="${w}">
        <span>세로</span><input type="number" id="szH" value="${h}" min="1" max="${h}">
        <span style="color:var(--muted);font-size:11px;">px</span>
      </div>
      <p class="tip" id="szTip">한쪽 값만 입력해도 비율에 맞춰 나머지가 채워집니다. 원본(${w}×${h}px)보다 크게는 저장할 수 없습니다 — 더 키우면 화질만 나빠지기 때문입니다.</p>

      <h3 style="margin-top:4px;">파일 형식</h3>
      <label class="radio"><input type="radio" name="szfmt" value="webp" ${defaultFmt === "webp" ? "checked" : ""} ${webpOK ? "" : "disabled"}>
        WebP — 용량을 크게 줄이면서 화질 차이는 거의 없음${webpOK ? "" : " · 이 브라우저에서는 지원하지 않음"}</label>
      <label class="radio"><input type="radio" name="szfmt" value="jpeg" ${defaultFmt === "jpeg" ? "checked" : ""}> JPG (JPEG) — 문서·한글 파일에 넣을 때 호환성이 좋음 (추천)</label>
      <label class="radio"><input type="radio" name="szfmt" value="png"> PNG — 무손실이라 용량이 가장 큼</label>

      <div class="size-row" id="qualityRow">
        <span>압축률</span>
        <input type="range" id="szQuality" min="40" max="100" value="92" style="flex:1;">
        <span id="szQualityLabel" style="width:30px;text-align:right;font-size:12px;">92</span>
      </div>
      <p class="tip">숫자가 낮을수록 파일은 작아지지만 화질도 함께 낮아집니다. 90 안팎이면 눈으로는 원본과 거의 구분되지 않으면서 용량은 크게 줄어듭니다.</p>

      <p class="tip">‘클립보드에 복사’는 위에서 고른 크기로 복사되며, 형식은 항상 PNG입니다. (파일 형식·압축률은 저장에만 적용됩니다.)</p>

      <div class="btns">
        <button id="szCancel">취소</button>
        <button id="szCopy" title="가림 결과 사진을 클립보드에 복사합니다">클립보드에 복사</button>
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
  // 선택한 크기 읽기: 원본이면 null, 크기 지정이면 [가로, 세로], 값이 잘못됐으면 false
  const readTarget = () => {
    const mode = backdrop.querySelector('input[name="szmode"]:checked').value;
    if (mode !== "custom") return null;
    const tw = clamp(Math.max(1, Math.round(parseFloat(szW.value))), 1, w);
    const th = clamp(Math.max(1, Math.round(parseFloat(szH.value))), 1, h);
    if (!tw || !th) { alert("가로/세로 값을 확인해 주세요."); return false; }
    return [tw, th];
  };
  backdrop.querySelector("#szOk").onclick = () => {
    const target = readTarget();
    if (target === false) return;
    const format = backdrop.querySelector('input[name="szfmt"]:checked').value;
    const quality = parseInt(szQuality.value, 10) / 100;
    closeDialog();
    doSave(target, format, quality);
  };
  backdrop.querySelector("#szCopy").onclick = () => {
    const target = readTarget();
    if (target === false) return;
    closeDialog();
    doCopy(target);   // 클릭 직후 바로 호출해야 브라우저가 클립보드 쓰기를 허용합니다
  };
}

function saveBlob(blob, suggestedName) {
  // File System Access API(showSaveFilePicker)를 사용하지 않고
  // 브라우저의 일반 다운로드 기능으로 저장합니다.
  // 따라서 웹페이지가 사용자의 파일 시스템에 직접 쓰기 권한을 요청하지 않습니다.
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function flattenOnWhite(canvas) {
  const out = document.createElement("canvas");
  out.width = canvas.width; out.height = canvas.height;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

// 저장·복사에 공통으로 쓰는 결과 사진 만들기 (가림 적용 → 필요하면 리사이즈)
function buildOutputCanvas(targetSize) {
  const rendered = render();
  if (targetSize && (targetSize[0] !== rendered.width || targetSize[1] !== rendered.height)) {
    return highQualityResize(rendered, targetSize[0], targetSize[1]);
  }
  return rendered;
}

// 결과 사진을 클립보드에 복사 — 크기는 저장과 같고, 형식은 클립보드가 안정적으로 받는 PNG 고정
function doCopy(targetSize) {
  if (!navigator.clipboard || !navigator.clipboard.write || typeof window.ClipboardItem === "undefined") {
    toast("이 브라우저는 사진 복사를 지원하지 않습니다. 저장을 이용해 주세요.");
    return;
  }
  const canvas = buildOutputCanvas(targetSize);
  toast("클립보드에 복사하는 중입니다…");
  // 사진을 만드는 동안에도 '클릭 직후' 상태가 유지되도록 Promise 형태로 넘깁니다.
  const blobPromise = new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/png");
  });
  navigator.clipboard.write([new window.ClipboardItem({ "image/png": blobPromise })])
    .then(() => blobPromise)
    .then((blob) => {
      const kb = (blob.size / 1024).toFixed(0);
      toast(`클립보드에 복사했습니다 · ${canvas.width} × ${canvas.height}px · PNG 약 ${kb}KB`);
    })
    .catch(() => {
      toast("복사하지 못했습니다. 브라우저의 클립보드 권한을 확인하거나 저장을 이용해 주세요.");
    });
}

function doSave(targetSize, format = "png", quality = 0.92) {
  let finalCanvas = buildOutputCanvas(targetSize);
  // JPG는 투명을 지원하지 않아 투명한 부분이 검게 저장되므로, 흰 배경 위에 얹어서 저장합니다.
  if (format === "jpeg") finalCanvas = flattenOnWhite(finalCanvas);
  const mime = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
  const ext = format === "jpeg" ? "jpg" : format === "webp" ? "webp" : "png";
  const tag = targetSize ? `_${targetSize[0]}x${targetSize[1]}` : "";
  const name = `${state.filenameStem}_가림${tag}.${ext}`;
  finalCanvas.toBlob((blob) => {
    if (!blob) { toast("저장하지 못했습니다. 다른 형식으로 다시 시도해 주세요."); return; }
    saveBlob(blob, name);
    const kb = (blob.size / 1024).toFixed(0);
    toast(`저장했습니다 · ${finalCanvas.width} × ${finalCanvas.height}px · 약 ${kb}KB`);
  }, mime, format === "png" ? undefined : quality);
}
$("saveBtn").onclick = openSaveDialog;

// ── 얼굴 자동 찾기 (OpenCV.js — 데스크톱 버전과 동일한 YuNet/Haar) ──
// 데스크톱 프로그램이 쓰는 것과 똑같은, 검증된 OpenCV 알고리즘을
// 브라우저에서 그대로 돌립니다(공식 OpenCV.js 빌드, 저장소에 함께 배포).
let faceDetectorPromise = null;

const OPENCV_CDN_URL = "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@5.0.0-release.1/dist/opencv.js";
const OPENCV_LOCAL_URL = "./opencv.js";

function loadOpenCV(onProgress, forceReload) {
  return new Promise((resolve, reject) => {
    if (!forceReload && window.cv && window.cv.Mat) { resolve(window.cv); return; }

    let settled = false;
    let usingFallback = false;
    const finish = (readyCv) => { if (!settled) { settled = true; resolve(readyCv || window.cv); } };
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };

    // OpenCV.js(UMD)가 준비되는 세 가지 경우를 모두 대비합니다.
    // (공식 배포 패키지가 안내하는 방식과 동일)
    const attachAndWait = () => {
      const cvModule = window.cv;
      if (!cvModule) return; // 스크립트가 아직 실행 전 — 아래 폴링에 맡김
      if (cvModule instanceof Promise) {
        cvModule.then((readyCv) => { window.cv = readyCv; finish(readyCv); })
          .catch(() => { usingFallback ? fail(new Error("opencv.js 초기화에 실패했습니다.")) : switchToFallback(); });
      } else if (cvModule.Mat) {
        finish(cvModule); // 이미 준비된 상태
      } else {
        cvModule.onRuntimeInitialized = () => finish(window.cv);
      }
    };

    function loadScript(src, onFail) {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.setAttribute("data-opencv-loader", "1");
      script.onload = attachAndWait;
      script.onerror = onFail;
      document.head.appendChild(script);
    }

    function switchToFallback() {
      if (settled || usingFallback) return;
      usingFallback = true;
      const old = document.querySelector('script[data-opencv-loader]');
      if (old) old.remove();
      window.cv = undefined;
      loadScript(OPENCV_LOCAL_URL + (forceReload ? ("?_t=" + Date.now()) : ""), () => {
        fail(new Error("opencv.js를 CDN과 저장소 파일 양쪽에서 모두 불러오지 못했습니다."));
      });
    }

    if (forceReload) {
      const old = document.querySelector('script[data-opencv-loader]');
      if (old) old.remove();
      window.cv = undefined;
    }

    if (forceReload || !document.querySelector('script[data-opencv-loader]')) {
      // 평소엔 대규모 트래픽에 강한 CDN(jsdelivr)에서 받아오고,
      // 문제가 있을 때만 저장소에 함께 넣어둔 사본으로 자동 전환합니다.
      loadScript(OPENCV_CDN_URL + (forceReload ? ("?_t=" + Date.now()) : ""), switchToFallback);
    } else {
      attachAndWait();
    }

    // 안전망: 위 신호를 놓치는 경우를 대비해 준비 상태를 계속 확인하고,
    // CDN이 일정 시간 안에 응답 없으면 저장소 사본으로 전환하며,
    // 그래도 지나치게 오래 걸리면 결국 실패 처리합니다.
    const start = Date.now();
    const CDN_SWITCH_MS = 12000;
    const TIMEOUT_MS = 45000;
    let toldSlow = false;
    const poll = setInterval(() => {
      if (settled) { clearInterval(poll); return; }
      if (window.cv && window.cv.Mat) { clearInterval(poll); finish(window.cv); return; }
      const elapsed = Date.now() - start;
      if (!toldSlow && elapsed > 8000 && onProgress) { toldSlow = true; onProgress(); }
      if (!usingFallback && elapsed > CDN_SWITCH_MS) { switchToFallback(); }
      if (elapsed > TIMEOUT_MS) {
        clearInterval(poll);
        fail(new Error(`opencv.js 로딩이 ${TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다.`));
      }
    }, 200);
  });
}

async function ensureFileInFS(cv, name, url, timeoutMs = 20000) {
  try {
    cv.FS_readFile(name);
    return name; // 이미 등록돼 있음
  } catch (e) { /* 아직 없음 → 아래에서 받아옴 */ }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, { signal: controller.signal });
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw new Error(`${url} 요청이 ${timeoutMs / 1000}초 안에 끝나지 않았습니다.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new Error(`${url} 를 불러오지 못했습니다 (HTTP ${resp.status})`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  cv.FS_createDataFile("/", name, buf, true, false, false);
  return name;
}

function makeOpenCVFaceDetector(cv, yunetPath, cascadePath) {
  let yunet = null;
  let cascade = null;
  if (yunetPath) {
    try {
      yunet = new cv.FaceDetectorYN(yunetPath, "", new cv.Size(320, 320), 0.5, 0.3, 5000);
    } catch (e) {
      console.error("YuNet 초기화 실패, Haar cascade로 대체합니다:", e);
      yunet = null;
    }
  }
  if (!yunet && cascadePath && cv.CascadeClassifier) {
    try {
      cascade = new cv.CascadeClassifier();
      cascade.load(cascadePath);
    } catch (e) {
      console.error("Haar cascade 초기화 실패:", e);
      cascade = null;
    }
  } else if (!yunet && cascadePath) {
    console.warn("이 OpenCV.js 빌드에는 CascadeClassifier가 포함돼 있지 않습니다.");
  }
  if (!yunet && !cascade) {
    throw new Error("얼굴 인식을 초기화하지 못했습니다 (YuNet과 Haar cascade 모두 사용할 수 없음)");
  }

  return {
    detect(canvas) {
      const out = [];
      const mat = cv.imread(canvas);
      try {
        if (yunet) {
          // YuNet(동적 입력) 모델은 가로/세로가 32의 배수여야 합니다.
          const pw = Math.ceil(mat.cols / 32) * 32;
          const ph = Math.ceil(mat.rows / 32) * 32;
          let input = mat;
          let padded = null;
          if (pw !== mat.cols || ph !== mat.rows) {
            padded = new cv.Mat();
            cv.copyMakeBorder(mat, padded, 0, ph - mat.rows, 0, pw - mat.cols,
                              cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
            input = padded;
          }
          yunet.setInputSize(new cv.Size(pw, ph));
          const faces = new cv.Mat();
          try {
            yunet.detect(input, faces);
            for (let i = 0; i < faces.rows; i++) {
              const row = faces.data32F.subarray(i * 15, i * 15 + 15);
              out.push({ boundingBox: { originX: row[0], originY: row[1], width: row[2], height: row[3] } });
            }
          } finally {
            faces.delete();
            if (padded) padded.delete();
          }
        } else if (cascade) {
          const gray = new cv.Mat();
          try {
            cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
            cv.equalizeHist(gray, gray);
            const faces = new cv.RectVector();
            try {
              cascade.detectMultiScale(gray, faces, 1.08, 5, 0, new cv.Size(24, 24));
              for (let i = 0; i < faces.size(); i++) {
                const r = faces.get(i);
                out.push({ boundingBox: { originX: r.x, originY: r.y, width: r.width, height: r.height } });
              }
            } finally {
              faces.delete();
            }
          } finally {
            gray.delete();
          }
        }
      } finally {
        mat.delete();
      }
      return { detections: out };
    },
  };
}

async function getFaceDetector(onProgress, forceReload) {
  if (forceReload) faceDetectorPromise = null;
  if (!faceDetectorPromise) {
    faceDetectorPromise = (async () => {
      const cv = await loadOpenCV(onProgress, forceReload);
      let yunetPath = null;
      try {
        yunetPath = await ensureFileInFS(cv, "face_detection_yunet.onnx", "./face_detection_yunet.onnx");
      } catch (e) {
        console.error("YuNet 모델 파일을 불러오지 못했습니다(가능하면 Haar로 대체):", e);
      }
      // Haar cascade는 YuNet을 실제로 쓸 수 없고, 이 OpenCV.js 빌드에 그
      // 기능이 있을 때만 받아옵니다 — 안 쓰일 930KB를 미리 받지 않기 위해서입니다.
      let cascadePath = null;
      if ((!yunetPath || !cv.FaceDetectorYN) && cv.CascadeClassifier) {
        try {
          cascadePath = await ensureFileInFS(cv, "haarcascade_frontalface_default.xml", "./haarcascade_frontalface_default.xml");
        } catch (e) {
          console.error("Haar cascade 파일을 불러오지 못했습니다:", e);
        }
      }
      if (!yunetPath && !cascadePath) {
        throw new Error("얼굴 인식에 필요한 파일을 하나도 불러오지 못했습니다.");
      }
      return makeOpenCVFaceDetector(cv, yunetPath, cascadePath);
    })();
  }
  return faceDetectorPromise;
}

// ── 여러 얼굴을 놓치지 않기 위한 전처리 ──────────────────────────
// (1) 원본이 작으면 확대, 너무 크면 축소 — 데스크톱 버전과 같은 방식
// (2) 인원이 많은 사진은 구역을 나눠 각각 검사한 뒤 결과를 합침
//     (BlazeFace는 내부적으로 128×128까지 축소해서 보기 때문에, 사진
//      한 장을 통째로 넣으면 사람이 많을수록 얼굴 하나하나가 너무
//      작아져 놓치기 쉽습니다. 구역을 나눠 보면 같은 얼굴이라도
//      모델이 보는 상대적 크기가 커집니다.)
function detectionScaleFor(w, h) {
  const longSide = Math.max(w, h);
  if (longSide > 1600) return 1600 / longSide;
  if (longSide < 960) return Math.min(2.5, 960 / longSide);
  return 1;
}
function scaledCanvas(src, scale) {
  if (Math.abs(scale - 1) < 0.01) return src;
  const nw = Math.max(1, Math.round(src.width * scale));
  const nh = Math.max(1, Math.round(src.height * scale));
  const c = document.createElement("canvas");
  c.width = nw; c.height = nh;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, nw, nh);
  return c;
}
function computeFaceTiles(w, h, target = 420) {
  const cols = Math.min(4, Math.max(1, Math.round(w / target)));
  const rows = Math.min(4, Math.max(1, Math.round(h / target)));
  if (cols <= 1 && rows <= 1) return [];
  const tw = w / cols, th = h / rows;
  const ox = tw * 0.25, oy = th * 0.25;
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x1 = Math.max(0, c * tw - ox), y1 = Math.max(0, r * th - oy);
      const x2 = Math.min(w, (c + 1) * tw + ox), y2 = Math.min(h, (r + 1) * th + oy);
      tiles.push([x1, y1, x2 - x1, y2 - y1]);
    }
  }
  return tiles;
}
function mergeFaceBoxes(boxes, thr = 0.3) {
  const sorted = boxes.slice().sort((a, b) => b[2] * b[3] - a[2] * a[3]);
  const kept = [];
  for (const b of sorted) {
    const [bx, by, bw, bh] = b;
    let dup = false;
    for (const k of kept) {
      const [kx, ky, kw, kh] = k;
      const ix = Math.max(0, Math.min(bx + bw, kx + kw) - Math.max(bx, kx));
      const iy = Math.max(0, Math.min(by + bh, ky + kh) - Math.max(by, ky));
      const inter = ix * iy;
      if (inter && inter / Math.min(bw * bh, kw * kh) > thr) { dup = true; break; }
    }
    if (!dup) kept.push(b);
  }
  return kept;
}
function runDetectInto(detector, canvas, offX, offY, out) {
  let result;
  try {
    result = detector.detect(canvas);
  } catch (e) {
    console.error("얼굴 인식 중 한 구역에서 오류(해당 구역만 건너뜀):", e);
    return;
  }
  for (const d of result.detections || []) {
    const bb = d.boundingBox;
    out.push([offX + bb.originX, offY + bb.originY, bb.width, bb.height]);
  }
}
function detectFacesMulti(detector, srcCanvas) {
  const W = srcCanvas.width, H = srcCanvas.height;
  const scale = detectionScaleFor(W, H);
  const work = scaledCanvas(srcCanvas, scale);
  const wW = work.width, wH = work.height;

  const collected = [];
  runDetectInto(detector, work, 0, 0, collected);

  const tiles = computeFaceTiles(wW, wH, 420);
  for (const [tx, ty, tw, th] of tiles) {
    const tc = document.createElement("canvas");
    tc.width = Math.max(1, Math.round(tw));
    tc.height = Math.max(1, Math.round(th));
    tc.getContext("2d").drawImage(work, tx, ty, tw, th, 0, 0, tc.width, tc.height);
    runDetectInto(detector, tc, tx, ty, collected);
  }

  const merged = mergeFaceBoxes(collected);
  return merged.map(([x, y, w, h]) => [x / scale, y / scale, w / scale, h / scale]);
}

// ── 얼굴 인식(자동 가리기) 준비 상태 표시 ─────────────────────────
let cvState = "idle"; // idle | loading | ready | error
function setCvStatus(newState, text) {
  cvState = newState;
  const dot = $("cvStatusDot");
  dot.className = newState === "idle" ? "" : newState;
  $("cvStatusText").textContent = text;
}
function extractCvVersion() {
  try {
    const info = window.cv.getBuildInformation();
    const m = info.match(/OpenCV\s+([\d.]+[\w-]*)/i);
    return m ? m[1] : "";
  } catch (e) { return ""; }
}
async function ensureOpenCVReady(forceReload) {
  if (cvState === "ready" && !forceReload) return true;
  const startedAt = Date.now();
  setCvStatus("loading", "자동 가리기 기능을 준비하는 중입니다…");
  $("cvLoadBtn").disabled = true;
  try {
    await getFaceDetector(() => {
      setCvStatus("loading", "자동 가리기 기능을 내려받는 중입니다… (시간이 걸릴 수 있어요)");
    }, forceReload);
    console.log("얼굴 인식 엔진 정보:", extractCvVersion()); // 개발자 참고용, 화면엔 안 보임
    const elapsed = Date.now() - startedAt;
    setCvStatus("ready", elapsed < 2000
      ? "자동 가리기 기능이 준비됐습니다."
      : "자동 가리기 기능을 새로 내려받아 준비했습니다.");
    $("cvLoadBtn").textContent = "다시 불러오기";
    $("cvLoadBtn").disabled = false;
    return true;
  } catch (e) {
    console.error("얼굴 인식 라이브러리를 불러오지 못했습니다:", e);
    setCvStatus("error", "자동 가리기를 준비하지 못했습니다. 다시 시도해 주세요.");
    $("cvLoadBtn").textContent = "다시 시도";
    $("cvLoadBtn").disabled = false;
    return false;
  }
}
$("cvLoadBtn").onclick = () => ensureOpenCVReady(true); // 수동으로 누르면 항상 새로 확인(캐시 무시)

async function autoFaces() {
  if (!state.src) { toast("먼저 사진을 열어 주세요."); return; }
  $("autoBtn").disabled = true;
  const ready = await ensureOpenCVReady(false);
  if (!ready) {
    toast("얼굴 인식 기능을 불러오지 못했습니다. 위 상태 표시의 오류 내용을 확인해 주세요.");
    $("autoBtn").disabled = false;
    return;
  }
  toast("얼굴을 찾는 중입니다…");
  const detector = await getFaceDetector();
  let dets;
  try {
    dets = detectFacesMulti(detector, state.src);
  } catch (e) {
    console.error("얼굴을 찾는 중 문제가 생겼습니다:", e);
    toast("얼굴을 찾는 중 문제가 생겼습니다.");
    $("autoBtn").disabled = false;
    return;
  }
  $("autoBtn").disabled = false;
  if (!dets.length) { toast("얼굴을 찾지 못했습니다. 직접 영역을 그려 주세요."); return; }

  const W = state.src.width, H = state.src.height;
  const before = snapshot();
  for (const [x, y, w, h] of dets) {
    const padx = w * 0.16, padyT = h * 0.26, padyB = h * 0.14;
    const x1 = Math.max(0, x - padx), y1 = Math.max(0, y - padyT);
    const x2 = Math.min(W, x + w + padx), y2 = Math.min(H, y + h + padyB);
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
  else if (ctrl && e.key.toLowerCase() === "c") {
    const hadSel = state.selected >= 0 && state.selected < state.ops.length;
    copySelected();
    if (!hadSel) e.preventDefault();
    else if (writeOpMarker()) e.preventDefault();   // 표식 복사 성공 → 기본 복사는 불필요
    else markOpCopy();                              // 실패 시에만 기본 복사 + copy 이벤트로 표식 기록
  }
  else if (!ctrl && !e.altKey && e.key.toLowerCase() === "h") { setOutlines(!state.showOutlines, true); }
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
setOutlines(state.showOutlines, false);
setTool("rect");
setEffect("blur");
updateStatus();
redraw();

// 서비스 워커 등록 — 큰 파일을 브라우저에 저장해 두어서
// 새로고침해도 다시 받지 않고, 오프라인에서도 쓸 수 있게 합니다.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((e) => {
      console.error("서비스 워커 등록에 실패했습니다(기능에는 영향 없음):", e);
    });
  });
}

// 페이지가 열리면 "자동 가리기(얼굴 인식)" 기능을 미리 준비해 둡니다.
// 사진 열기 · 손으로 영역 그리기 같은 다른 기능은 이 준비와 무관하게
// 바로 사용할 수 있고, 준비 중에 버튼을 눌러도 같은 작업을 이어받을 뿐
// 중복으로 다시 받지 않습니다.
ensureOpenCVReady(false);
