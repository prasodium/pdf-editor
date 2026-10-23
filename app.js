import * as pdfjs from './vendor/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const $ = (s) => document.querySelector(s);
const dpr = Math.min(window.devicePixelRatio || 1, 2);
const mod = (a) => ((a % 360) + 360) % 360;

let docs = []; // {name, bytes, pdf}
let pages = []; // {id, doc, src, view, base, rot, ops, pg, runs, blank}
let zoom = 1,
  tool = 'edit',
  uid = 1,
  undo = [],
  redo = [];
const fonts = {}; // pdf.js loaded font name -> {css, real, data, b, i, fam}
let pendingImage = null,
  drag = null,
  editing = null;

/* ---------- helpers ---------- */
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), ms);
}
const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const css = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
function snapshot() {
  return pages.map((p) => ({ ...p, ops: p.ops.slice() }));
}
function commit() {
  undo.push(snapshot());
  if (undo.length > 60) undo.shift();
  redo = [];
}
function restore(s) {
  pages = s;
  build();
}
// pdf.js does not export its viewport class, so blank pages use this minimal equivalent
class Viewport {
  constructor(view, scale, rotation) {
    const [x0, y0, x1, y1] = view,
      cx = (x0 + x1) / 2,
      cy = (y0 + y1) / 2;
    const [a, b, c, d] = {
      0: [1, 0, 0, -1],
      90: [0, 1, 1, 0],
      180: [-1, 0, 0, 1],
      270: [0, -1, -1, 0],
    }[rotation];
    const sw = Math.abs(x1 - x0) * scale,
      sh = Math.abs(y1 - y0) * scale,
      sw2 = a === 0;
    this.width = sw2 ? sh : sw;
    this.height = sw2 ? sw : sh;
    this.rotation = rotation;
    const ox = (sw2 ? Math.abs(cy - y0) : Math.abs(cx - x0)) * scale,
      oy = (sw2 ? Math.abs(cx - x0) : Math.abs(cy - y0)) * scale;
    this.transform = [
      a * scale,
      b * scale,
      c * scale,
      d * scale,
      ox - a * scale * cx - c * scale * cy,
      oy - b * scale * cx - d * scale * cy,
    ];
  }
  convertToViewportPoint(x, y) {
    const t = this.transform;
    return [x * t[0] + y * t[2] + t[4], x * t[1] + y * t[3] + t[5]];
  }
  convertToViewportRectangle(r) {
    const [a, b] = this.convertToViewportPoint(r[0], r[1]),
      [c, d] = this.convertToViewportPoint(r[2], r[3]);
    return [a, b, c, d];
  }
  convertToPdfPoint(x, y) {
    const t = this.transform,
      det = t[0] * t[3] - t[1] * t[2],
      X = x - t[4],
      Y = y - t[5];
    return [(X * t[3] - Y * t[2]) / det, (Y * t[0] - X * t[1]) / det];
  }
}
function vpOf(p, scale = zoom) {
  const rotation = mod(p.base + p.rot);
  return p.pg
    ? p.pg.getViewport({ scale, rotation })
    : new Viewport(p.view, scale, rotation);
}

/* ---------- loading ---------- */
async function addFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.type.startsWith('image/')) return addImagePage(file, bytes);
  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data: bytes.slice(), fontExtraProperties: true })
      .promise;
  } catch (e) {
    return toast(
      e.name === 'PasswordException'
        ? 'This PDF is password protected.'
        : 'Could not open that file.',
    );
  }
  docs.push({ name: file.name, bytes, pdf });
  const d = docs.length - 1,
    fresh = pages.length === 0;
  commit();
  for (let i = 0; i < pdf.numPages; i++) {
    const pg = await pdf.getPage(i + 1);
    pages.push({
      id: uid++,
      doc: d,
      src: i,
      view: pg.view,
      base: pg.rotate,
      rot: 0,
      ops: [],
      pg,
    });
  }
  if (fresh) {
    const w = pages[0].view[2] - pages[0].view[0];
    zoom = Math.max(0.5, Math.min(1.6, (Math.min(innerWidth, 1000) - 80) / w));
    $('#welcome').hidden = true;
    for (const id of ['tools', 'actions', 'opts']) $('#' + id).hidden = false;
    setTool('edit');
  }
  build();
}

async function addImagePage(file, bytes) {
  const img = await loadImage(file);
  const w = 595,
    h = Math.round((595 * img.height) / img.width);
  const first = pages.length === 0;
  if (first) {
    $('#welcome').hidden = true;
    for (const id of ['tools', 'actions', 'opts']) $('#' + id).hidden = false;
    zoom = 1;
  }
  commit();
  pages.push({
    id: uid++,
    doc: -1,
    view: [0, 0, w, h],
    base: 0,
    rot: 0,
    blank: true,
    ops: [{ t: 'image', x: 0, y: 0, w, h, img }],
  });
  build();
}

function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file),
      img = new Image();
    img.onload = () => {
      img.mime = file.type === 'image/jpeg' ? 'jpg' : 'png';
      img.src0 = file;
      res(img);
    };
    img.onerror = rej;
    img.src = url;
  });
}

/* ---------- rendering ---------- */
const io = new IntersectionObserver(
  (es) =>
    es.forEach((e) => {
      if (e.isIntersecting) {
        io.unobserve(e.target);
        renderPage(e.target);
      }
    }),
  { rootMargin: '600px' },
);

function build() {
  const root = $('#pages');
  root.textContent = '';
  pages.forEach((p, i) => {
    const vp = (p.vp = vpOf(p));
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.id = p.id;
    el.innerHTML = `<div class="pnum">Page ${i + 1}</div>
      <div class="ptools">
        <button data-a="up" title="Move up">↑</button><button data-a="down" title="Move down">↓</button>
        <button data-a="rl" title="Rotate left">⟲</button><button data-a="rr" title="Rotate right">⟳</button>
        <button data-a="dup" title="Duplicate">⧉</button><button data-a="del" title="Delete page">🗑</button>
        <button data-a="ext" title="Download only this page">⇩</button>
      </div>
      <div class="sheet" style="width:${vp.width}px;height:${vp.height}px">
        <canvas class="pdf"></canvas><canvas class="ov"></canvas><div class="runs"></div>
      </div>`;
    root.append(el);
    io.observe(el);
    el.querySelector('.ptools').onclick = (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a) pageAction(p.id, a);
    };
    wireSheet(p, el.querySelector('.sheet'));
    drawOverlay(p);
  });
  $('#undo').disabled = !undo.length;
  $('#redo').disabled = !redo.length;
}

async function renderPage(el) {
  const p = pages.find((x) => x.id == el.dataset.id);
  if (!p) return;
  const vp = p.vp,
    c = el.querySelector('canvas.pdf');
  c.width = vp.width * dpr;
  c.height = vp.height * dpr;
  if (p.pg) {
    await p.pg
      .render({
        canvasContext: c.getContext('2d'),
        viewport: vp,
        transform: [dpr, 0, 0, dpr, 0, 0],
      })
      .promise.catch(() => {});
    if (!p.runs) await extractRuns(p);
    layoutRuns(p, el);
  }
  drawOverlay(p);
}

async function extractRuns(p) {
  const tc = await p.pg.getTextContent();
  for (const name of new Set(Object.keys(tc.styles))) {
    if (fonts[name]) continue;
    let o = {};
    try {
      o = p.pg.commonObjs.get(name) || {};
    } catch {}
    const real = o.name || tc.styles[name].fontFamily || '';
    fonts[name] = {
      css: tc.styles[name].fontFamily,
      real,
      data: o.data,
      b: o.bold || /bold|black|heavy|semibold|demi/i.test(real),
      i: o.italic || /italic|oblique/i.test(real),
      fam: /courier|mono|consol/i.test(real)
        ? 'Courier'
        : o.isMonospace
          ? 'Courier'
          : /sans|arial|helvet|calibri|verdana|tahoma|segoe|roboto|open|gothic/i.test(
                real,
              )
            ? 'Helvetica'
            : o.isSerifFont ||
                /times|serif|georgia|garamond|minion|palatino|cambria|book/i.test(real)
              ? 'Times'
              : 'Helvetica',
    };
  }
  const runs = [];
  for (const it of tc.items) {
    if (!it.str && !it.hasEOL) continue;
    const [a, b, c, d, e, f] = it.transform,
      fs = Math.hypot(c, d);
    if (!fs || Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue; // horizontal text only
    const last = runs[runs.length - 1];
    if (
      last &&
      last.font === it.fontName &&
      Math.abs(last.y - f) < 0.5 &&
      Math.abs(last.size - fs) < 0.1 &&
      e - (last.x + last.w) < fs * 0.35 &&
      e - (last.x + last.w) > -fs * 0.2
    ) {
      last.str += it.str;
      last.w = e + it.width - last.x;
    } else if (it.str)
      runs.push({ str: it.str, x: e, y: f, w: it.width, size: fs, font: it.fontName });
  }
  p.runs = runs.filter((r) => r.str.trim());
}

function layoutRuns(p, el) {
  const box = el.querySelector('.runs');
  box.textContent = '';
  p.runs.forEach((r, i) => {
    const [x1, y1, x2, y2] = p.vp.convertToViewportRectangle([
      r.x,
      r.y - r.size * 0.3,
      r.x + r.w,
      r.y + r.size * 0.88,
    ]);
    const d = document.createElement('div');
    d.className = 'run';
    Object.assign(d.style, {
      left: Math.min(x1, x2) + 'px',
      top: Math.min(y1, y2) + 'px',
      width: Math.abs(x2 - x1) + 'px',
      height: Math.abs(y2 - y1) + 'px',
    });
    d.onpointerdown = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      editRun(p, i, el.querySelector('.sheet'));
    };
    box.append(d);
  });
}

/* ---------- overlay drawing ---------- */
function fontCss(f, size) {
  if (f.k === 'src' && fonts[f.name]?.data) return `${size}px ${fonts[f.name].css}`;
  if (f.k === 'src') f = { ...(f.fb || fonts[f.name]) }; // not embedded: use the matching standard font
  const fam =
    f.fam === 'Times'
      ? '"Times New Roman",Times,serif'
      : f.fam === 'Courier'
        ? '"Courier New",monospace'
        : 'Helvetica,Arial,sans-serif';
  return `${f.i ? 'italic ' : ''}${f.b ? 'bold ' : ''}${size}px ${fam}`;
}

function drawOverlay(p, extra) {
  const el = document.querySelector(`.page[data-id="${p.id}"] canvas.ov`);
  if (!el) return;
  const vp = p.vp;
  el.width = vp.width * dpr;
  el.height = vp.height * dpr;
  const g = el.getContext('2d'),
    t = vp.transform.map((v) => v * dpr);
  g.setTransform(...t);
  for (const op of [...p.ops, ...(extra ? [extra] : [])]) {
    if (op === editing) continue;
    g.save();
    if (op.t === 'text') {
      if (op.cover) {
        g.fillStyle = css(op.cover.c);
        g.fillRect(op.cover.x, op.cover.y, op.cover.w, op.cover.h);
      }
      g.translate(op.x, op.y);
      g.scale(1, -1);
      g.font = fontCss(op.font, op.size);
      g.fillStyle = css(op.color);
      g.fillText(op.text, 0, 0);
    } else if (op.t === 'rect') {
      g.globalAlpha = op.alpha ?? 1;
      if (op.fill) {
        g.fillStyle = css(op.fill);
        g.fillRect(op.x, op.y, op.w, op.h);
      }
      if (op.stroke) {
        g.strokeStyle = css(op.stroke);
        g.lineWidth = 1.5;
        g.strokeRect(op.x, op.y, op.w, op.h);
      }
    } else if (op.t === 'draw') {
      g.strokeStyle = css(op.color);
      g.lineWidth = 2;
      g.lineJoin = g.lineCap = 'round';
      g.beginPath();
      op.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
    } else if (op.t === 'image') {
      g.translate(op.x, op.y + op.h);
      g.scale(1, -1);
      g.drawImage(op.img, 0, 0, op.w, op.h);
    }
    g.restore();
  }
}

/* ---------- text measuring / hit test ---------- */
const mctx = document.createElement('canvas').getContext('2d');
function textWidth(op) {
  mctx.font = fontCss(op.font, op.size);
  return mctx.measureText(op.text).width;
}

/* ---------- colour sampling (match background + text colour) ---------- */
function sample(p, el, r) {
  const c = el.querySelector('canvas.pdf'),
    g = c.getContext('2d', { willReadFrequently: true });
  const [x1, y1, x2, y2] = p.vp.convertToViewportRectangle([
    r.x,
    r.y - r.size * 0.3,
    r.x + r.w,
    r.y + r.size * 0.88,
  ]);
  const L = Math.max(0, Math.floor(Math.min(x1, x2) * dpr) - 2),
    T = Math.max(0, Math.floor(Math.min(y1, y2) * dpr) - 2);
  const W = Math.min(c.width - L, Math.ceil(Math.abs(x2 - x1) * dpr) + 4),
    H = Math.min(c.height - T, Math.ceil(Math.abs(y2 - y1) * dpr) + 4);
  if (W < 2 || H < 2) return { bg: [255, 255, 255], fg: [0, 0, 0] };
  const d = g.getImageData(L, T, W, H).data,
    cnt = new Map();
  const at = (x, y) => (y * W + x) * 4;
  const edge = [];
  for (let x = 0; x < W; x++) edge.push(at(x, 0), at(x, H - 1));
  for (let y = 0; y < H; y++) edge.push(at(0, y), at(W - 1, y));
  for (const i of edge) {
    const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const e = cnt.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += d[i];
    e.g += d[i + 1];
    e.b += d[i + 2];
    cnt.set(k, e);
  }
  const top = [...cnt.values()].sort((a, b) => b.n - a.n)[0];
  const bg = [top.r / top.n, top.g / top.n, top.b / top.n].map(Math.round);
  let best = 0,
    fg = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) {
    const dist =
      Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
    if (dist > best) {
      best = dist;
      fg = [d[i], d[i + 1], d[i + 2]];
    }
  }
  // stem thickness (in em) from horizontal ink runs through the middle of the text: ~0.09 regular, ~0.15 bold
  const lens = [],
    thr = best * 0.5,
    px = r.size * zoom * dpr;
  for (let y = Math.floor(H * 0.35); y < H * 0.65; y++) {
    let run = 0;
    for (let x = 2; x < W - 2; x++) {
      const i = at(x, y),
        dark =
          Math.abs(d[i] - bg[0]) +
            Math.abs(d[i + 1] - bg[1]) +
            Math.abs(d[i + 2] - bg[2]) >
          thr;
      if (dark) run++;
      else {
        if (run) lens.push(run);
        run = 0;
      }
    }
  }
  lens.sort((a, b) => a - b);
  const stem = lens.length ? lens[Math.floor(lens.length / 2)] / px : 0;
  return { bg, fg: best > 60 ? fg : [0, 0, 0], bold: stem > 0.135 };
}

/* ---------- in-place text editor ---------- */
function openEditor(p, sheet, s) {
  closeEditor();
  const [vx, vy] = p.vp.convertToViewportPoint(s.x, s.y);
  const inp = document.createElement('input');
  inp.className = 'editor';
  inp.value = s.text;
  inp.spellcheck = false;
  const px = s.size * zoom;
  inp.style.cssText =
    `left:${vx}px;top:${vy - px * 1.0}px;height:${px * 1.25}px;font:${fontCss(s.font, px)};color:${css(s.color)};transform:rotate(${p.vp.rotation}deg);width:${Math.max(120, (s.w || 0) * zoom + 40)}px;` +
    (s.bg ? `background:${css(s.bg)}` : '');
  sheet.append(inp);
  inp.focus();
  inp.select();
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    inp.remove();
    editing = null;
    if (ok) s.apply(inp.value);
    drawOverlay(p);
  };
  inp.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  inp.onblur = () => finish(true);
  inp.oninput = () => {
    inp.style.width = Math.max(120, inp.value.length * px * 0.6 + 40) + 'px';
  };
  editing = s.op || null;
  drawOverlay(p);
  closeEditor.fn = () => finish(true);
}
function closeEditor() {
  closeEditor.fn?.();
  closeEditor.fn = null;
}

function fontFromUI(orig) {
  const v = $('#font').value,
    b = $('#bold').checked,
    i = $('#ital').checked;
  if (v === 'orig' && orig) return { k: 'src', name: orig };
  return { k: 'std', fam: v === 'orig' ? 'Helvetica' : v, b, i };
}

function editRun(p, idx, sheet) {
  const r = p.runs[idx],
    el = sheet.parentElement;
  let op = p.ops.find((o) => o.run === r);
  if (op)
    return openEditor(p, sheet, {
      ...op,
      w: textWidth(op),
      bg: op.cover.c,
      op,
      apply: (t) => setRunText(p, r, op, t, op.cover, op.color, op.font),
    });
  const { bg, fg, bold } = sample(p, el, r);
  const useOrig = $('#font').value === 'orig' && fonts[r.font];
  const f0 = fonts[r.font],
    font = useOrig
      ? { k: 'src', name: r.font, fb: { fam: f0.fam, b: f0.b || bold, i: f0.i } }
      : fontFromUI(null);
  if (!useOrig && $('#font').value === 'orig') {
    const f = fonts[r.font];
    Object.assign(font, { fam: f?.fam || 'Helvetica', b: f?.b || bold, i: f?.i });
  }
  const cover = {
    x: r.x - 0.5,
    y: r.y - r.size * 0.3,
    w: r.w + 1,
    h: r.size * 1.2,
    c: bg,
  };
  openEditor(p, sheet, {
    x: r.x,
    y: r.y,
    size: r.size,
    text: r.str,
    font,
    color: fg,
    w: r.w,
    bg,
    apply: (t) => setRunText(p, r, null, t, cover, fg, font),
  });
}

function setRunText(p, r, old, text, cover, color, font) {
  if (!old && text === r.str) return;
  commit();
  if (old) p.ops.splice(p.ops.indexOf(old), 1);
  if (text !== r.str)
    p.ops.push({
      t: 'text',
      x: r.x,
      y: r.y,
      size: r.size,
      text,
      color,
      font,
      cover,
      run: r,
    });
  build();
}

/* ---------- pointer tools ---------- */
function wireSheet(p, sheet) {
  const pt = (e) => {
    const b = sheet.getBoundingClientRect();
    return p.vp.convertToPdfPoint(e.clientX - b.left, e.clientY - b.top);
  };
  sheet.onpointerdown = (e) => {
    if (e.target.classList.contains('editor')) return;
    closeEditor();
    const [x, y] = pt(e),
      col = hex2rgb($('#color').value),
      size = +$('#size').value || 14;
    if (tool === 'edit') {
      // click on text added earlier
      const hit = [...p.ops]
        .reverse()
        .find(
          (o) =>
            o.t === 'text' &&
            !o.run &&
            x >= o.x - 2 &&
            x <= o.x + textWidth(o) + 2 &&
            y >= o.y - o.size * 0.25 &&
            y <= o.y + o.size * 0.9,
        );
      if (hit)
        openEditor(p, sheet, {
          ...hit,
          w: textWidth(hit),
          op: hit,
          apply: (t) => {
            commit();
            p.ops.splice(p.ops.indexOf(hit), 1);
            if (t) p.ops.push({ ...hit, text: t });
            build();
          },
        });
      return;
    }
    if (tool === 'text') {
      e.preventDefault();
      const font = fontFromUI(null);
      openEditor(p, sheet, {
        x,
        y: y - size * 0.3,
        size,
        text: '',
        font,
        color: col,
        apply: (t) => {
          if (!t) return;
          commit();
          p.ops.push({
            t: 'text',
            x,
            y: y - size * 0.3,
            size,
            text: t,
            color: col,
            font,
          });
          build();
        },
      });
      return;
    }
    if (tool === 'img') {
      if (!pendingImage) return toast('Pick an image first.');
      const im = pendingImage,
        w = (p.view[2] - p.view[0]) * 0.35,
        h = (w * im.height) / im.width;
      commit();
      p.ops.push({ t: 'image', x: x - w / 2, y: y - h / 2, w, h, img: im });
      build();
      return;
    }
    sheet.setPointerCapture(e.pointerId);
    drag = { p, x, y, pts: [[x, y]], col };
  };
  sheet.onpointermove = (e) => {
    if (!drag || drag.p !== p) return;
    const [x, y] = pt(e);
    drag.pts.push([x, y]);
    drawOverlay(p, shape(drag, x, y));
  };
  sheet.onpointerup = (e) => {
    if (!drag || drag.p !== p) return;
    const [x, y] = pt(e),
      op = shape(drag, x, y);
    drag = null;
    if (op && (op.t === 'draw' ? op.pts.length > 1 : op.w > 1 && op.h > 1)) {
      commit();
      p.ops.push(op);
      build();
    } else drawOverlay(p);
  };
}

function shape(d, x, y) {
  if (tool === 'draw') return { t: 'draw', pts: d.pts, color: d.col };
  const o = {
    t: 'rect',
    x: Math.min(d.x, x),
    y: Math.min(d.y, y),
    w: Math.abs(x - d.x),
    h: Math.abs(y - d.y),
  };
  if (tool === 'hl') return { ...o, fill: [255, 230, 0], alpha: 0.4 };
  if (tool === 'white') return { ...o, fill: [255, 255, 255] };
  if (tool === 'rect') return { ...o, stroke: d.col };
}

/* ---------- page operations ---------- */
function pageAction(id, a) {
  const i = pages.findIndex((p) => p.id === id),
    p = pages[i];
  if (a === 'ext') return save([p]);
  if (a === 'del' && pages.length === 1) return toast('A PDF needs at least one page.');
  commit();
  if (a === 'up' && i > 0) [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]];
  if (a === 'down' && i < pages.length - 1)
    [pages[i + 1], pages[i]] = [pages[i], pages[i + 1]];
  if (a === 'rl') pages[i] = { ...p, rot: mod(p.rot - 90) };
  if (a === 'rr') pages[i] = { ...p, rot: mod(p.rot + 90) };
  if (a === 'dup') pages.splice(i + 1, 0, { ...p, id: uid++, ops: p.ops.slice() });
  if (a === 'del') pages.splice(i, 1);
  build();
}

function setTool(t) {
  closeEditor();
  tool = t;
  document.body.className = 'tool-' + t;
  document
    .querySelectorAll('#tools button')
    .forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  const hints = {
    edit: 'Click any text to change it. The original font is kept.',
    text: 'Click anywhere on the page to type.',
    draw: 'Drag to draw.',
    hl: 'Drag over text to highlight.',
    white: 'Drag to cover an area with white.',
    rect: 'Drag to draw a box.',
    img: 'Click on the page to place the image.',
  };
  $('#hint').textContent = hints[t];
}

/* ---------- export ---------- */
const STD = {
  Helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  Times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  Courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = rej;
    document.head.append(s);
  });
}

async function save(subset) {
  closeEditor();
  const list = subset || pages,
    { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
  try {
    toast('Preparing…', 60000);
    const out = await PDFDocument.create();
    if (!window.fontkit) await loadScript('vendor/fontkit.umd.min.js');
    out.registerFontkit(window.fontkit);
    const srcDocs = new Map(),
      fcache = new Map(),
      icache = new Map();
    let warned = false;

    // index mapping: 0 regular, 1 bold, 2 italic, 3 bold-italic
    const std = async (fam, b, i) => {
      const key = fam + b + i;
      if (fcache.has(key)) return fcache.get(key);
      const f = await out.embedFont(
        StandardFonts[STD[fam][b && i ? 3 : i ? 2 : b ? 1 : 0]],
      );
      fcache.set(key, f);
      return f;
    };

    const pickFont = async (op) => {
      const f = op.font;
      if (f.k === 'src') {
        const info = fonts[f.name];
        if (info?.data) {
          const key = 'src' + f.name;
          if (fcache.has(key)) {
            const c = fcache.get(key);
            if (c.cover(op.text)) return c.font;
          } else {
            try {
              const kit = window.fontkit.create(info.data);
              const font = await out.embedFont(info.data, { subset: false });
              const c = {
                font,
                noSpace: !kit.hasGlyphForCodePoint(32),
                cover: (t) =>
                  [...t].every(
                    (ch) => /\s/.test(ch) || kit.hasGlyphForCodePoint(ch.codePointAt(0)),
                  ),
              };
              font.noSpace = c.noSpace;
              fcache.set(key, c);
              if (c.cover(op.text)) return font;
            } catch {
              fcache.set(key, { font: null, cover: () => false });
            }
          }
        }
        const fb = f.fb || info || {};
        return std(fb.fam || 'Helvetica', fb.b, fb.i);
      }
      return std(f.fam, f.b, f.i);
    };

    for (const p of list) {
      let page;
      if (p.blank) page = out.addPage([p.view[2], p.view[3]]);
      else {
        if (!srcDocs.has(p.doc))
          srcDocs.set(
            p.doc,
            await PDFDocument.load(docs[p.doc].bytes, { ignoreEncryption: true }),
          );
        [page] = await out.copyPages(srcDocs.get(p.doc), [p.src]);
        out.addPage(page);
      }
      page.setRotation(degrees(mod(p.base + p.rot)));
      for (const op of p.ops) {
        if (op.t === 'text') {
          if (op.cover)
            page.drawRectangle({
              x: op.cover.x,
              y: op.cover.y,
              width: op.cover.w,
              height: op.cover.h,
              color: rgb(...op.cover.c.map((v) => v / 255)),
            });
          if (!op.text) continue;
          const font = await pickFont(op);
          let text = op.text;
          try {
            font.encodeText(text);
          } catch {
            text = [...text]
              .map((ch) => {
                try {
                  font.encodeText(ch);
                  return ch;
                } catch {
                  warned = true;
                  return '?';
                }
              })
              .join('');
          }
          const color = rgb(...op.color.map((v) => v / 255));
          if (!font.noSpace)
            page.drawText(text, { x: op.x, y: op.y, size: op.size, font, color });
          else {
            // subset fonts often lack a space glyph: place words manually
            let x = op.x;
            for (const w of text.split(' ')) {
              if (w) {
                page.drawText(w, { x, y: op.y, size: op.size, font, color });
                x += font.widthOfTextAtSize(w, op.size);
              }
              x += op.size * 0.28;
            }
          }
        } else if (op.t === 'rect') {
          page.drawRectangle({
            x: op.x,
            y: op.y,
            width: op.w,
            height: op.h,
            ...(op.fill
              ? { color: rgb(...op.fill.map((v) => v / 255)), opacity: op.alpha ?? 1 }
              : {}),
            ...(op.stroke
              ? { borderColor: rgb(...op.stroke.map((v) => v / 255)), borderWidth: 1.5 }
              : {}),
          });
        } else if (op.t === 'draw') {
          for (let i = 1; i < op.pts.length; i++)
            page.drawLine({
              start: { x: op.pts[i - 1][0], y: op.pts[i - 1][1] },
              end: { x: op.pts[i][0], y: op.pts[i][1] },
              thickness: 2,
              color: rgb(...op.color.map((v) => v / 255)),
              lineCap: 1,
            });
        } else if (op.t === 'image') {
          if (!icache.has(op.img)) {
            let bytes,
              jpg = op.img.mime === 'jpg';
            if (jpg) bytes = new Uint8Array(await op.img.src0.arrayBuffer());
            else {
              const c = document.createElement('canvas');
              c.width = op.img.naturalWidth;
              c.height = op.img.naturalHeight;
              c.getContext('2d').drawImage(op.img, 0, 0);
              bytes = new Uint8Array(
                await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer(),
              );
            }
            icache.set(
              op.img,
              jpg ? await out.embedJpg(bytes) : await out.embedPng(bytes),
            );
          }
          page.drawImage(icache.get(op.img), {
            x: op.x,
            y: op.y,
            width: op.w,
            height: op.h,
          });
        }
      }
    }
    const blob = new Blob([await out.save()], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download =
      (docs[0]?.name.replace(/\.pdf$/i, '') || 'document') +
      (subset ? '-page' : '-edited') +
      '.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(
      warned
        ? 'Saved. Some characters are not supported by the original font and became "?".'
        : 'Saved to your downloads.',
    );
  } catch (e) {
    console.error(e);
    toast('Could not save: ' + e.message);
  }
}

/* ---------- wiring ---------- */
const fileIn = $('#file');
$('#open').onclick = () => fileIn.click();
$('#add').onclick = () => fileIn.click();
fileIn.onchange = async () => {
  for (const f of fileIn.files) await addFile(f);
  fileIn.value = '';
};
$('#blank').onclick = () => {
  const ref = pages.at(-1);
  commit();
  pages.push({
    id: uid++,
    doc: -1,
    view: [0, 0, ref.view[2] - ref.view[0], ref.view[3] - ref.view[1]],
    base: 0,
    rot: 0,
    blank: true,
    ops: [],
  });
  build();
  scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
};
$('#tools').onclick = (e) => {
  const t = e.target.closest('button')?.dataset.tool;
  if (!t) return;
  if (t === 'img') {
    $('#imgfile').click();
  }
  setTool(t);
};
$('#imgfile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) pendingImage = await loadImage(f);
  else setTool('edit');
};
$('#undo').onclick = () => {
  if (!undo.length) return;
  redo.push(snapshot());
  restore(undo.pop());
};
$('#redo').onclick = () => {
  if (!redo.length) return;
  undo.push(snapshot());
  restore(redo.pop());
};
$('#zin').onclick = () => {
  zoom = Math.min(3, zoom * 1.2);
  build();
};
$('#zout').onclick = () => {
  zoom = Math.max(0.3, zoom / 1.2);
  build();
};
$('#save').onclick = () => save();
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    (e.shiftKey ? $('#redo') : $('#undo')).click();
  }
});
addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('drag');
});
addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('drag');
});
addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('drag');
  for (const f of e.dataTransfer.files) await addFile(f);
});
addEventListener('beforeunload', (e) => {
  if (undo.length) e.preventDefault();
});
