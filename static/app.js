const PALETTE = ['#7c9885','#7b8fa8','#a07060','#8a7bab','#a08060','#5e8c8a','#8a6070','#9a7058','#6a7a5a','#7888a8'];
const LANE_H = 56, CAT_H = 32, DIA = 20;
const WD = ['日','月','火','水','木','金','土'];
const MO = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];

const ZOOM_CFG = {
  day:   { colW: 32,  spanDays: 60,  startOffset: 7,  minRank: 1 },
  week:  { colW: 48,  spanDays: 180, startOffset: 21, minRank: 2 },
  month: { colW: 64,  spanDays: 540, startOffset: 30, minRank: 3 },
};
const RANK_LABEL = { 1: '★★★', 2: '★★', 3: '★' };

let zoom = 'day';
let colW = 32, spanDays = 60, minRank = 1;
let visibleSpanDays = 60;

function setZoom(z) {
  zoom = z;
  const cfg = ZOOM_CFG[z];
  colW = cfg.colW; spanDays = cfg.spanDays; minRank = cfg.minRank;
  document.querySelectorAll('.zoom-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('z' + z.charAt(0).toUpperCase() + z.slice(1)).classList.add('active');
  const rf = document.getElementById('rankFilter');
  if (z === 'day') {
    rf.style.display = 'none';
  } else {
    rf.style.display = 'flex';
    document.getElementById('rfLabel').textContent = RANK_LABEL[minRank] || minRank;
  }
  redraw();
}

const socket = io();
let items = [], allDeps = [], allLanes = [], allCategories = [], rangeStart = null;
let editId = null, drag = null, wasDragged = false;
let drawerMsId = null;
let ctxMs = null;
let modalDownInside = false, modalDragged = false, modalDownPos = { x: 0, y: 0 };
let linkMode = false, linkSrc = null;
let posCache = {};
const collapsedCats = new Set();

socket.on('connect',          ()  => socket.emit('get_state'));
socket.on('ms_update',        d   => { items = d; redraw(); });
socket.on('deps_update',      d   => { allDeps = d; redrawDeps(); });
socket.on('lanes_update',     d   => { allLanes = d; redraw(); });
socket.on('categories_update',d   => { allCategories = d; redraw(); });
socket.on('user_count',       n   => document.getElementById('uCount').textContent = n);
socket.on('comments_data',    d   => { if (d.ms_id === drawerMsId) renderComments(d.comments); });

function parseD(s) { const[y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); }
function fmtD(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function daysBetween(a,b) { return Math.round((b-a)/86400000); }
function today0() { const d=new Date(); d.setHours(0,0,0,0); return d; }

function latestMilestoneDate() {
  let latest = null;
  items.forEach(ms => {
    if (!ms.date) return;
    const d = parseD(ms.date);
    if (!latest || d > latest) latest = d;
  });
  return latest;
}

function earliestMilestoneDate() {
  let earliest = null;
  items.forEach(ms => {
    if (!ms.date) return;
    const d = parseD(ms.date);
    if (!earliest || d < earliest) earliest = d;
  });
  return earliest;
}

function computeRangeStart() {
  const padDays = ZOOM_CFG[zoom].startOffset;
  const baseStart = today0();
  baseStart.setDate(baseStart.getDate() - padDays);

  const earliest = earliestMilestoneDate();
  if (!earliest) return baseStart;

  const earliestStart = new Date(earliest);
  earliestStart.setDate(earliestStart.getDate() - padDays);
  return earliestStart < baseStart ? earliestStart : baseStart;
}

function computeVisibleSpanDays() {
  const latest = latestMilestoneDate();
  if (!latest) return spanDays;

  const spanToLatest = Math.max(0, daysBetween(rangeStart, latest)) + 1;
  const bufferDays = zoom === 'month' ? 30 : 0;
  return Math.max(spanDays, spanToLatest + bufferDays);
}

const DEADLINE_PRESETS = [
  { key: 'B', day: 10 },
  { key: 'M', day: 20 },
  { key: 'E', day: 30 },
];

function datePresetFromDate(dateStr) {
  if (!dateStr) return '';
  const d = parseD(dateStr);
  const preset = DEADLINE_PRESETS.find(p => p.day === d.getDate());
  return preset ? `${d.getMonth() + 1}/${preset.key}` : '';
}

function dateFromPreset(presetValue, year) {
  if (!presetValue) return '';
  const [monthStr, partKey] = presetValue.split('/');
  const preset = DEADLINE_PRESETS.find(p => p.key === partKey);
  const month = Number(monthStr);
  if (!preset || !month || month < 1 || month > 12) return '';
  const baseYear = Number.isFinite(year) ? year : new Date().getFullYear();
  return fmtD(new Date(baseYear, month - 1, preset.day));
}

function initDeadlineControl() {
  const dateInput = document.getElementById('fDate');
  if (!dateInput) return;
  const parent = dateInput.parentElement;
  if (!parent) return;
  parent.classList.add('deadline-row');
  dateInput.classList.add('deadline-date');
  let presetSel = document.getElementById('fDatePreset');
  if (!presetSel) {
    presetSel = document.createElement('select');
    presetSel.id = 'fDatePreset';
    presetSel.className = 'deadline-preset';
    parent.insertBefore(presetSel, dateInput);
    presetSel.addEventListener('change', () => {
      if (!presetSel.value) return;
      const currentYear = dateInput.value ? parseD(dateInput.value).getFullYear() : new Date().getFullYear();
      dateInput.value = dateFromPreset(presetSel.value, currentYear);
    });
    dateInput.addEventListener('change', () => {
      presetSel.value = datePresetFromDate(dateInput.value);
    });
  }
  presetSel.innerHTML = '';
  const custom = document.createElement('option');
  custom.value = ''; custom.textContent = 'カスタム';
  presetSel.appendChild(custom);
  for (let m = 1; m <= 12; m++) {
    DEADLINE_PRESETS.forEach(p => {
      const opt = document.createElement('option');
      opt.value = `${m}/${p.key}`; opt.textContent = `${m}/${p.key}`;
      presetSel.appendChild(opt);
    });
  }
  presetSel.value = datePresetFromDate(dateInput.value);
}

function initLaneControl() {
  const laneInput = document.getElementById('fLane');
  if (!laneInput || laneInput.tagName === 'SELECT') return;
  const select = document.createElement('select');
  select.id = 'fLane';
  laneInput.replaceWith(select);
  refreshLaneOptions(select, laneInput.value || '');
}

function dateToCol(date) {
  const dayOff = daysBetween(rangeStart, date);
  if (zoom === 'day')   return dayOff;
  if (zoom === 'week')  return dayOff / 7;
  if (zoom === 'month') return dayOff / 30;
  return dayOff;
}

function numCols() {
  if (zoom === 'day')   return visibleSpanDays;
  if (zoom === 'week')  return Math.ceil(visibleSpanDays / 7);
  if (zoom === 'month') return Math.ceil(visibleSpanDays / 30);
  return visibleSpanDays;
}

function colToDate(i) {
  const d = new Date(rangeStart);
  if (zoom === 'day')   d.setDate(d.getDate() + i);
  if (zoom === 'week')  d.setDate(d.getDate() + i * 7);
  if (zoom === 'month') d.setDate(d.getDate() + i * 30);
  return d;
}

function dateToPx(date) { return dateToCol(date) * colW + colW / 2; }

function getWeekNum(d) {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
}

// ── Lane / category data ──

function laneData() {
  const catMap = {};
  allCategories.forEach(c => catMap[c.id] = c);

  const catToLanes = {};
  const uncategorized = [];
  allLanes.forEach(l => {
    if (l.category_id && catMap[l.category_id]) {
      if (!catToLanes[l.category_id]) catToLanes[l.category_id] = [];
      catToLanes[l.category_id].push(l);
    } else {
      uncategorized.push(l);
    }
  });

  const orderedItems = [];
  allCategories.forEach(cat => {
    orderedItems.push({ type: 'category', id: cat.id, name: cat.name });
    (catToLanes[cat.id] || []).forEach(lane => {
      orderedItems.push({ type: 'lane', name: lane.name, id: lane.id });
    });
  });
  uncategorized.forEach(lane => {
    orderedItems.push({ type: 'lane', name: lane.name, id: lane.id });
  });

  // safety: lanes referenced by items but not in allLanes (no real id)
  const knownLanes = new Set(allLanes.map(l => l.name));
  items.forEach(ms => {
    if (ms.lane && !knownLanes.has(ms.lane) &&
        !orderedItems.find(x => x.type === 'lane' && x.name === ms.lane)) {
      orderedItems.push({ type: 'lane', name: ms.lane, id: null });
    }
  });

  const msMap = {};
  orderedItems.filter(x => x.type === 'lane').forEach(x => { msMap[x.name] = []; });
  items.forEach(ms => {
    const l = ms.lane || '—';
    if (!msMap[l]) msMap[l] = [];
    msMap[l].push(ms);
  });

  return { orderedItems, msMap };
}

function visibleItems(orderedItems) {
  return orderedItems.filter(item => {
    if (item.type === 'category') return true;
    const lane = item.id ? allLanes.find(l => l.id === item.id) : null;
    const catId = lane ? lane.category_id : null;
    return !(catId && collapsedCats.has(catId));
  });
}

function computeItemY(visItems) {
  let y = 0;
  const laneToY = {};
  visItems.forEach(item => {
    if (item.type === 'category') {
      y += CAT_H;
    } else {
      laneToY[item.name] = y + LANE_H / 2;
      y += LANE_H;
    }
  });
  return { laneToY, totalH: y };
}

// ── Build date header ──
function buildHeader(dhdr, tod) {
  dhdr.innerHTML = '';
  const cols = numCols();
  const totalW = cols * colW;
  dhdr.style.width = totalW + 'px';

  if (zoom === 'day') {
    let prevM = -1;
    for (let i = 0; i < cols; i++) {
      const d = colToDate(i);
      const isT = daysBetween(tod,d)===0, isW = d.getDay()===0||d.getDay()===6;
      const mo = d.getMonth(), showMo = mo!==prevM; if(showMo) prevM=mo;
      const dc = document.createElement('div');
      dc.className = 'dc'+(isT?' today':'')+(isW?' weekend':'');
      dc.style.width = colW+'px';
      dc.innerHTML = `<span class="dc-mo">${showMo?(mo+1)+'月':''}</span>`+
        `<span class="dc-d">${d.getDate()}</span>`+
        `<span class="dc-wd">${WD[d.getDay()]}</span>`;
      dhdr.appendChild(dc);
    }
  } else if (zoom === 'week') {
    let prevM = -1;
    for (let i = 0; i < cols; i++) {
      const d = colToDate(i);
      const dEnd = new Date(d); dEnd.setDate(dEnd.getDate()+6);
      const isT = daysBetween(tod,d) <= 0 && daysBetween(tod,dEnd) >= 0;
      const mo = d.getMonth(), showMo = mo!==prevM; if(showMo) prevM=mo;
      const dc = document.createElement('div');
      dc.className = 'dc'+(isT?' today':'');
      dc.style.width = colW+'px';
      dc.innerHTML = `<span class="dc-mo">${showMo?(mo+1)+'月':''}</span>`+
        `<span class="dc-d" style="font-size:11px">${d.getDate()}–${dEnd.getDate()}</span>`+
        `<span class="dc-wd">W${getWeekNum(d)}</span>`;
      dhdr.appendChild(dc);
    }
  } else {
    for (let i = 0; i < cols; i++) {
      const d = colToDate(i);
      const isT = d.getFullYear()===tod.getFullYear() && d.getMonth()===tod.getMonth();
      const dc = document.createElement('div');
      dc.className = 'dc'+(isT?' today':'');
      dc.style.width = colW+'px';
      dc.innerHTML = `<span class="dc-mo">${d.getFullYear()}</span>`+
        `<span class="dc-d" style="font-size:13px">${MO[d.getMonth()]}</span>`+
        `<span class="dc-wd"></span>`;
      dhdr.appendChild(dc);
    }
  }
  return totalW;
}

// ── Full redraw ──
function redraw() {
  const tod = today0();
  rangeStart = computeRangeStart();
  visibleSpanDays = computeVisibleSpanDays();
  const cols = numCols();
  const totalW = cols * colW;
  const { orderedItems, msMap } = laneData();
  const visItems = visibleItems(orderedItems);
  const { laneToY, totalH } = computeItemY(visItems);
  posCache = {};

  const dhdr = document.getElementById('dhdr');
  buildHeader(dhdr, tod);

  const ga = document.getElementById('gridArea');
  [...ga.children].forEach(c => { if (c.id !== 'depSvg') ga.removeChild(c); });
  ga.style.width = totalW + 'px';
  ga.style.minHeight = totalH + 'px';

  visItems.forEach(item => {
    if (item.type === 'category') {
      const row = document.createElement('div');
      row.className = 'grid-cat-row';
      row.style.width = totalW + 'px';
      row.textContent = item.name;
      ga.appendChild(row);
    } else {
      const row = document.createElement('div');
      row.className = 'grid-lane';
      row.style.width = totalW + 'px';
      row.dataset.lane = item.name;   // for right-click "add here"
      for (let i = 0; i < cols; i++) {
        const d = colToDate(i);
        let isT = false, isW = false;
        if (zoom === 'day') {
          isT = daysBetween(tod,d)===0;
          isW = d.getDay()===0||d.getDay()===6;
        } else if (zoom === 'week') {
          const dEnd = new Date(d); dEnd.setDate(dEnd.getDate()+6);
          isT = daysBetween(tod,d)<=0 && daysBetween(tod,dEnd)>=0;
        } else {
          isT = d.getFullYear()===tod.getFullYear() && d.getMonth()===tod.getMonth();
        }
        const gc = document.createElement('div');
        gc.className = 'gc'+(isT?' today':'')+(isW?' weekend':'');
        gc.style.width = colW+'px';
        row.appendChild(gc);
      }
      ga.appendChild(row);
    }
  });

  // Today line
  const todayPx = dateToPx(tod);
  if (todayPx >= 0 && todayPx <= totalW) {
    const tl = document.createElement('div'); tl.className = 'today-line';
    tl.style.left = todayPx + 'px';
    tl.style.height = totalH + 'px';
    tl.innerHTML = '<div class="today-cap"></div>';
    ga.appendChild(tl);
  }

  // Milestones
  visItems.filter(x => x.type === 'lane').forEach(item => {
    const laneName = item.name;
    const cy = laneToY[laneName];
    (msMap[laneName] || []).forEach(ms => {
      const msRank = ms.rank || 1;
      if (msRank < minRank) return;
      const d = parseD(ms.date);
      const cx = dateToPx(d);
      if (cx < -DIA || cx > totalW + DIA) return;

      const wrapTop = cy - (DIA * 1.25) / 2 - 8;
      const circleCY = wrapTop + (DIA * 1.25) / 2;
      posCache[ms.id] = { cx, cy: circleCY };

      const wrap = document.createElement('div');
      wrap.className = 'ms';
      wrap.dataset.id = ms.id;
      wrap.style.left = cx + 'px';
      wrap.style.top  = wrapTop + 'px';

      const prog = ms.progress || 0;
      const r = 14, circ = 2*Math.PI*r, dash = circ*prog/100;
      const ringDiv = document.createElement('div'); ringDiv.className = 'ms-ring';
      ringDiv.innerHTML = `<svg viewBox="0 0 ${r*2+4} ${r*2+4}">
        <circle cx="${r+2}" cy="${r+2}" r="${r}" fill="none" stroke="${ms.color}" stroke-width="2.5" opacity=".15"/>
        <circle cx="${r+2}" cy="${r+2}" r="${r}" fill="none" stroke="${ms.color}" stroke-width="2.5"
          stroke-dasharray="${dash} ${circ-dash}" stroke-dashoffset="${circ/4}"
          stroke-linecap="round" opacity="${prog>0?.65:0}"/>
      </svg>`;

      const dia = document.createElement('div');
      dia.className = 'ms-diamond';
      dia.style.background = ms.color;
      dia.appendChild(ringDiv);

      const dayNum = document.createElement('div');
      dayNum.className = 'ms-day-num';
      dayNum.textContent = String(parseD(ms.date).getDate());
      dia.appendChild(dayNum);

      const lbl = document.createElement('div'); lbl.className = 'ms-label';
      lbl.textContent = ms.name;

      wrap.appendChild(dia); wrap.appendChild(lbl);
      attachEvents(wrap, ms);
      ga.appendChild(wrap);
    });
  });

  redrawDeps();
  renderPanel(visItems, msMap, orderedItems);
}

// ── Draw dependency arrows ──
function redrawDeps() {
  const svg = document.getElementById('depSvg');
  svg.innerHTML = '';
  const defs = document.createElementNS('http://www.w3.org/2000/svg','defs');
  defs.innerHTML = `
    <marker id="arr" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <polygon points="0 1, 6 3.5, 0 6" fill="#111" opacity=".72"/>
    </marker>
    <marker id="arr-hot" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
      <polygon points="0 1, 6 3.5, 0 6" fill="#000"/>
    </marker>`;
  svg.appendChild(defs);

  allDeps.forEach(dep => {
    const fp = posCache[dep.from_id], tp = posCache[dep.to_id];
    if (!fp || !tp) return;
    const half = (DIA * 1.25) / 2;
    const x1 = fp.cx + half, y1 = fp.cy;
    const x2 = tp.cx - half, y2 = tp.cy;
    const dx = x2 - x1, dy = y2 - y1;
    const midX = x1 + dx * 0.5;
    let pathD;
    if (Math.abs(dy) < 4) {
      pathD = `M${x1},${y1} L${x2},${y2}`;
    } else {
      pathD = `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`;
    }
    const g = document.createElementNS('http://www.w3.org/2000/svg','g');
    g.style.cursor = 'pointer';
    const path = document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d', pathD);
    path.setAttribute('class', 'dep-path');
    path.setAttribute('marker-end','url(#arr)');
    const hit = document.createElementNS('http://www.w3.org/2000/svg','path');
    hit.setAttribute('d', pathD);
    hit.setAttribute('fill','none'); hit.setAttribute('stroke','transparent'); hit.setAttribute('stroke-width','10');
    hit.style.cursor = 'pointer';
    g.appendChild(path); g.appendChild(hit);
    g.addEventListener('mouseenter', () => { path.style.stroke='#a04020'; path.style.opacity='1'; path.setAttribute('marker-end','url(#arr-hot)'); });
    g.addEventListener('mouseleave', () => { path.style.stroke=''; path.style.opacity=''; path.setAttribute('marker-end','url(#arr)'); });
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('この依存関係を削除しますか？')) socket.emit('delete_dep', { id: dep.id });
    });
    svg.appendChild(g);
  });
}

// ── Panel ──
function renderPanel(visItems, msMap, orderedItems) {
  const ll = document.getElementById('laneList');
  ll.innerHTML = '';

  visItems.forEach((item, idx) => {
    if (item.type === 'category') {
      const hdr = document.createElement('div');
      hdr.className = 'cat-header';

      const toggle = document.createElement('span');
      toggle.className = 'cat-toggle';
      toggle.textContent = collapsedCats.has(item.id) ? '▶' : '▼';
      toggle.onclick = (e) => { e.stopPropagation(); toggleCatCollapse(item.id); };

      const nameEl = document.createElement('span');
      nameEl.className = 'cat-name';
      nameEl.textContent = item.name;
      nameEl.onclick = () => startCatRename(nameEl, item.id, item.name);

      const acts = document.createElement('div'); acts.className = 'cat-actions';
      const delBtn = document.createElement('button');
      delBtn.className = 'lane-btn del'; delBtn.textContent = '✕'; delBtn.title = 'カテゴリー削除';
      delBtn.onclick = (e) => { e.stopPropagation(); deleteCategory(item.id, item.name); };
      acts.appendChild(delBtn);

      hdr._catId = item.id;   // drop target marker for lane drag

      hdr.appendChild(toggle); hdr.appendChild(nameEl); hdr.appendChild(acts);
      ll.appendChild(hdr);

    } else {
      const laneName = item.name;
      const laneId = item.id;
      const ms = msMap[laneName] || [];
      const color = ms.length ? ms[0].color : '#9a9088';
      const lane = laneId ? allLanes.find(l => l.id === laneId) : null;

      // Position in full ordered lane list (for move buttons)
      const allLaneItems = orderedItems.filter(x => x.type === 'lane');
      const li = allLaneItems.findIndex(x => x.name === laneName);

      // Is previous/next vis item also a lane? (for move buttons)
      const prevVis = idx > 0 ? visItems[idx - 1] : null;
      const nextVis = idx < visItems.length - 1 ? visItems[idx + 1] : null;

      const row = document.createElement('div');
      row.className = 'lane-row' + (lane && lane.category_id ? ' indented' : '');

      const dot = document.createElement('div');
      dot.className = 'lane-dot'; dot.style.background = color;

      const nameWrap = document.createElement('div'); nameWrap.className = 'lane-name-wrap';
      const nameElL = document.createElement('div'); nameElL.className = 'lane-name';
      nameElL.textContent = laneName; nameElL.title = 'クリックで名前変更・ドラッグで並べ替え';
      nameElL.addEventListener('click', () => { if (laneWasDragged) return; startRename(nameElL, laneName); });
      nameWrap.appendChild(nameElL);

      const count = document.createElement('div'); count.className = 'lane-count';
      count.textContent = ms.length;

      const actions = document.createElement('div'); actions.className = 'lane-actions';

      if (laneId && prevVis && prevVis.type === 'lane') {
        const up = document.createElement('button'); up.className = 'lane-btn'; up.textContent = '↑'; up.title = '上へ';
        up.onclick = () => moveLane(laneId, -1);
        actions.appendChild(up);
      }
      if (laneId && nextVis && nextVis.type === 'lane') {
        const dn = document.createElement('button'); dn.className = 'lane-btn'; dn.textContent = '↓'; dn.title = '下へ';
        dn.onclick = () => moveLane(laneId, 1);
        actions.appendChild(dn);
      }

      const del = document.createElement('button'); del.className = 'lane-btn del'; del.textContent = '✕'; del.title = '削除';
      del.onclick = () => deleteLane(laneName, ms.length);
      actions.appendChild(del);

      // Category assignment button
      const catBtn = document.createElement('button');
      catBtn.className = 'lane-btn'; catBtn.title = 'カテゴリーを設定'; catBtn.textContent = '⊞';
      catBtn.onclick = (e) => { e.stopPropagation(); showCatPopup(e, laneName); };
      actions.appendChild(catBtn);

      row._laneName = laneName;   // drag target markers
      row._laneId = laneId;
      row.addEventListener('mousedown', e => {
        if (e.button !== 0 || !laneId) return;             // ghost lanes can't be reordered
        if (e.target.closest('button, input')) return;     // let buttons/inputs work
        e.preventDefault();                                 // avoid text selection
        laneDrag = { id: laneId, startY: e.clientY, moved: false };
        laneWasDragged = false;
      });

      row.appendChild(dot); row.appendChild(nameWrap); row.appendChild(count); row.appendChild(actions);
      ll.appendChild(row);
    }
  });

  const tw = document.getElementById('tw');
  ll.scrollTop = tw.scrollTop;
}

// ── Category functions ──
function addCategory() {
  const existing = allCategories.map(c => c.name);
  let n = allCategories.length + 1;
  let name = `Category ${n}`;
  while (existing.includes(name)) name = `Category ${++n}`;
  socket.emit('add_category', { name });
}

function deleteCategory(id, name) {
  if (confirm(`カテゴリー「${name}」を削除しますか？\n（レーンは未分類になります）`)) {
    socket.emit('delete_category', { id });
  }
}

function startCatRename(nameEl, id, oldName) {
  const input = document.createElement('input');
  input.className = 'cat-name-input'; input.value = oldName;
  nameEl.replaceWith(input);
  input.focus(); input.select();
  const commit = () => {
    const newName = input.value.trim();
    if (newName && newName !== oldName) socket.emit('rename_category', { id, name: newName });
    else input.replaceWith(nameEl);
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.replaceWith(nameEl); }
  });
}

function toggleCatCollapse(catId) {
  if (collapsedCats.has(catId)) collapsedCats.delete(catId);
  else collapsedCats.add(catId);
  redraw();
}

// ── Category assignment popup ──
function showCatPopup(e, laneName) {
  closeCatPopup();
  const popup = document.createElement('div');
  popup.id = 'catPopup'; popup.className = 'cat-popup';

  const lane = allLanes.find(l => l.name === laneName);
  const currentCatId = lane ? lane.category_id : null;

  const noneItem = document.createElement('div');
  noneItem.className = 'cat-popup-item' + (!currentCatId ? ' active' : '');
  noneItem.textContent = '未分類';
  noneItem.onclick = () => { socket.emit('set_lane_category', { lane_name: laneName, category_id: null }); closeCatPopup(); };
  popup.appendChild(noneItem);

  if (allCategories.length) {
    const sep = document.createElement('div'); sep.className = 'cat-popup-sep';
    popup.appendChild(sep);
    allCategories.forEach(cat => {
      const opt = document.createElement('div');
      opt.className = 'cat-popup-item' + (cat.id === currentCatId ? ' active' : '');
      opt.textContent = cat.name;
      opt.onclick = () => { socket.emit('set_lane_category', { lane_name: laneName, category_id: cat.id }); closeCatPopup(); };
      popup.appendChild(opt);
    });
  }

  document.body.appendChild(popup);

  const rect = e.target.getBoundingClientRect();
  const W = window.innerWidth, H = window.innerHeight;
  popup.style.left = Math.min(rect.right + 4, W - 160) + 'px';
  popup.style.top  = Math.min(rect.top, H - 200) + 'px';

  setTimeout(() => document.addEventListener('click', closeCatPopup, { once: true }), 0);
  e.stopPropagation();
}

function closeCatPopup() {
  const p = document.getElementById('catPopup');
  if (p) p.remove();
}

function startRename(nameEl, oldName) {
  const input = document.createElement('input');
  input.className = 'lane-name-input'; input.value = oldName;
  nameEl.replaceWith(input);
  input.focus(); input.select();
  const commit = () => {
    const newName = input.value.trim();
    if (newName && newName !== oldName) socket.emit('rename_lane', { old_name: oldName, new_name: newName });
    else input.replaceWith(nameEl);
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.replaceWith(nameEl); }
  });
}

// ── Lane drag & drop reorder (pointer-based) ──
let laneDrag = null;          // { name, startY, moved } while a row is held
let laneWasDragged = false;   // suppresses the rename-click after a drag

function clearLaneDropMarkers() {
  document.querySelectorAll('.lane-row.drop-before, .lane-row.drop-after')
    .forEach(el => el.classList.remove('drop-before', 'drop-after'));
  document.querySelectorAll('.cat-header.drop-into')
    .forEach(el => el.classList.remove('drop-into'));
}

function findLaneRow(id) {
  return [...document.querySelectorAll('#laneList .lane-row')].find(r => r._laneId === id);
}

// Resolve what's under the pointer: another lane (with before/after) or a category header.
function laneTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const row = el.closest('.lane-row');
  if (row && row._laneId) {
    const r = row.getBoundingClientRect();
    return { type: 'lane', id: row._laneId, before: y < r.top + r.height / 2, row };
  }
  const cat = el.closest('.cat-header');
  if (cat && cat._catId) return { type: 'cat', id: cat._catId, el: cat };
  return null;
}

document.addEventListener('mousemove', e => {
  if (!laneDrag) return;
  if (!laneDrag.moved) {
    if (Math.abs(e.clientY - laneDrag.startY) < 4) return;   // movement threshold
    laneDrag.moved = true;
    laneWasDragged = true;
    document.body.classList.add('lane-dragging');
    const sr = findLaneRow(laneDrag.id);
    if (sr) sr.classList.add('dragging-lane');
  }
  clearLaneDropMarkers();
  const t = laneTargetAt(e.clientX, e.clientY);
  if (!t) return;
  if (t.type === 'lane') {
    if (t.id === laneDrag.id) return;
    t.row.classList.add(t.before ? 'drop-before' : 'drop-after');
  } else {
    t.el.classList.add('drop-into');
  }
});

document.addEventListener('mouseup', e => {
  if (!laneDrag) return;
  const ld = laneDrag;
  laneDrag = null;
  if (ld.moved) {
    document.body.classList.remove('lane-dragging');
    const sr = findLaneRow(ld.id);
    if (sr) sr.classList.remove('dragging-lane');
    const t = laneTargetAt(e.clientX, e.clientY);
    if (t && t.type === 'lane' && t.id !== ld.id) dropLaneOnLane(ld.id, t.id, t.before);
    else if (t && t.type === 'cat') dropLaneOnCategory(ld.id, t.id);
    clearLaneDropMarkers();
    setTimeout(() => { laneWasDragged = false; }, 0);   // reset after the click would fire
  } else {
    laneWasDragged = false;
  }
});

function laneOrderIds(excludeId) {
  const { orderedItems } = laneData();
  return orderedItems
    .filter(x => x.type === 'lane' && x.id && x.id !== excludeId)
    .map(x => x.id);
}

function dropLaneOnLane(srcId, targetId, before) {
  if (srcId === targetId) return;
  const targetLane = allLanes.find(l => l.id === targetId);
  if (!targetLane) return;
  const order = laneOrderIds(srcId);
  let idx = order.indexOf(targetId);
  if (idx < 0) return;
  if (!before) idx += 1;
  order.splice(idx, 0, srcId);
  socket.emit('move_lane', { id: srcId, order, category_id: targetLane.category_id || null });
}

function dropLaneOnCategory(srcId, catId) {
  const { orderedItems } = laneData();
  const order = [];
  let insertAt = null;
  orderedItems.forEach(x => {
    if (x.type === 'category' && x.id === catId) insertAt = order.length;
    else if (x.type === 'lane' && x.id && x.id !== srcId) order.push(x.id);
  });
  if (insertAt === null) insertAt = order.length;
  order.splice(insertAt, 0, srcId);
  socket.emit('move_lane', { id: srcId, order, category_id: catId });
}

function moveLane(laneId, dir) {
  const { orderedItems } = laneData();
  const vis = visibleItems(orderedItems);
  const idx = vis.findIndex(x => x.type === 'lane' && x.id === laneId);
  if (idx < 0) return;
  // Find adjacent lane in vis direction
  let targetId = null;
  if (dir === -1) {
    for (let i = idx - 1; i >= 0; i--) { if (vis[i].type === 'lane' && vis[i].id) { targetId = vis[i].id; break; } }
  } else {
    for (let i = idx + 1; i < vis.length; i++) { if (vis[i].type === 'lane' && vis[i].id) { targetId = vis[i].id; break; } }
  }
  if (!targetId) return;
  const order = orderedItems.filter(x => x.type === 'lane' && x.id).map(x => x.id);
  const i1 = order.indexOf(laneId), i2 = order.indexOf(targetId);
  if (i1 < 0 || i2 < 0) return;
  [order[i1], order[i2]] = [order[i2], order[i1]];
  const lane = allLanes.find(l => l.id === laneId);
  socket.emit('move_lane', { id: laneId, order, category_id: lane ? (lane.category_id || null) : null });
}

function deleteLane(name, count) {
  const msg = count > 0
    ? `「${name}」を削除しますか？\n（このレーンのマイルストーン ${count} 件も削除されます）`
    : `「${name}」を削除しますか？`;
  if (confirm(msg)) socket.emit('delete_lane', { name });
}

function addLane() {
  const existing = allLanes.map(l => l.name);
  let n = allLanes.length + 1;
  let name = `Lane ${n}`;
  while (existing.includes(name)) name = `Lane ${++n}`;
  socket.emit('add_lane', { name });
}

// ── Events on milestone markers ──
function attachEvents(wrap, ms) {
  wrap.addEventListener('mousedown', e => {
    if (linkMode) return;
    e.preventDefault();
    wasDragged = false;
    drag = { wrap, ms, sx: e.clientX, origL: parseInt(wrap.style.left), moved: false };
    wrap.classList.add('dragging');
  });
  wrap.addEventListener('click', e => {
    e.stopPropagation();
    if (linkMode) { handleLinkClick(ms.id, wrap); return; }
    if (wasDragged) return;
    openEditModal(ms);
  });
  wrap.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    showCtxMenu(e.clientX, e.clientY, ms);
  });
  wrap.addEventListener('mouseenter', () => {
    if (linkMode && linkSrc && linkSrc !== ms.id) wrap.classList.add('link-hover');
  });
  wrap.addEventListener('mouseleave', () => wrap.classList.remove('link-hover'));
}

// ── Context menu ──
function showCtxMenu(x, y, ms) {
  ctxMs = ms;
  closeGridCtxMenu();
  const menu = document.getElementById('ctxMenu');
  document.getElementById('ctxDiamond').style.background = ms.color || PALETTE[0];
  document.getElementById('ctxName').textContent = ms.name;
  menu.classList.add('open');
  const W = window.innerWidth, H = window.innerHeight;
  menu.style.left = Math.min(x, W - 180) + 'px';
  menu.style.top  = Math.min(y, H - 200) + 'px';
}

function closeCtxMenu() { document.getElementById('ctxMenu').classList.remove('open'); ctxMs = null; }
function ctxOpenDrawer() { const ms = ctxMs; closeCtxMenu(); if (ms) openDrawer(ms); }
function ctxStartEdit()  { const ms = ctxMs; closeCtxMenu(); if (ms) openEditModal(ms); }
function ctxStartLink() {
  const ms = ctxMs; closeCtxMenu(); if (!ms) return;
  if (!linkMode) toggleLinkMode();
  linkSrc = ms.id;
  document.querySelectorAll('.ms').forEach(el => { if (el.dataset.id === ms.id) el.classList.add('link-source'); });
}
function ctxDelete() {
  const ms = ctxMs; closeCtxMenu(); if (!ms) return;
  if (confirm(`「${ms.name}」を削除しますか？`)) socket.emit('delete_ms', { id: ms.id });
}

document.addEventListener('click', () => { closeCtxMenu(); closeGridCtxMenu(); });
document.addEventListener('contextmenu', e => {
  if (!e.target.closest('.ms')) closeCtxMenu();
  if (!e.target.closest('#gridArea')) closeGridCtxMenu();
});

// ── Grid (empty area) context menu: add a milestone where you right-click ──
let gridCtxData = null;

document.getElementById('gridArea').addEventListener('contextmenu', e => {
  if (e.target.closest('.ms')) return;            // milestones have their own menu
  const row = e.target.closest('.grid-lane');
  if (!row || !row.dataset.lane) return;          // only over an actual lane row
  e.preventDefault();
  const ga = document.getElementById('gridArea');
  const x = e.clientX - ga.getBoundingClientRect().left;
  const colIdx = Math.round((x - colW / 2) / colW);
  showGridCtxMenu(e.clientX, e.clientY, row.dataset.lane, fmtD(colToDate(colIdx)));
});

function showGridCtxMenu(x, y, lane, date) {
  closeCtxMenu();
  gridCtxData = { lane, date };
  document.getElementById('gridCtxMeta').textContent = `${lane} ・ ${date}`;
  const menu = document.getElementById('gridCtxMenu');
  menu.classList.add('open');
  const W = window.innerWidth, H = window.innerHeight;
  menu.style.left = Math.min(x, W - 230) + 'px';
  menu.style.top  = Math.min(y, H - 90) + 'px';
}

function closeGridCtxMenu() {
  const m = document.getElementById('gridCtxMenu');
  if (m) m.classList.remove('open');
  gridCtxData = null;
}

function gridCtxAdd() {
  const d = gridCtxData;
  closeGridCtxMenu();
  if (d) openAdd({ lane: d.lane, date: d.date });
}

document.addEventListener('mousemove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.sx;
  if (Math.abs(dx) < 3) return;
  drag.moved = true; wasDragged = true;
  const newL = Math.max(colW/2, drag.origL + dx);
  drag.wrap.style.left = newL + 'px';
  const colIdx = Math.round((newL - colW/2) / colW);
  const nd = colToDate(colIdx);
  const lbl = drag.wrap.querySelector('.ms-day-num');
  if (lbl) lbl.textContent = String(nd.getDate());
});

document.addEventListener('mouseup', () => {
  if (!drag) return;
  drag.wrap.classList.remove('dragging');
  if (drag.moved) {
    const cx = parseInt(drag.wrap.style.left);
    const colIdx = Math.round((cx - colW/2) / colW);
    const nd = colToDate(colIdx);
    socket.emit('update_ms', { ...drag.ms, date: fmtD(nd) });
  }
  drag = null;
  setTimeout(() => { wasDragged = false; }, 0);
});

function toggleLinkMode() {
  linkMode = !linkMode; linkSrc = null;
  document.body.classList.toggle('link-mode', linkMode);
  document.getElementById('btnLink').classList.toggle('active', linkMode);
  document.getElementById('hint').classList.toggle('show', linkMode);
  document.querySelectorAll('.ms.link-source').forEach(el => el.classList.remove('link-source'));
}

function handleLinkClick(msId, wrap) {
  if (!linkSrc) {
    linkSrc = msId; wrap.classList.add('link-source');
  } else if (linkSrc === msId) {
    linkSrc = null; wrap.classList.remove('link-source');
  } else {
    socket.emit('add_dep', { from_id: linkSrc, to_id: msId });
    document.querySelectorAll('.ms.link-source').forEach(el => el.classList.remove('link-source'));
    linkSrc = null;
  }
}

// ── Panel width resizer ──
function initPanelResizer() {
  const panel = document.querySelector('.panel');
  if (!panel) return;
  const MIN_W = 120, MAX_W = 480;
  const saved = parseInt(localStorage.getItem('panelW'));
  if (saved) {
    document.documentElement.style.setProperty('--panel-w',
      Math.min(MAX_W, Math.max(MIN_W, saved)) + 'px');
  }
  const rs = document.createElement('div');
  rs.className = 'panel-resizer';
  rs.title = 'ドラッグで幅を調整';
  panel.appendChild(rs);
  rs.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX, startW = panel.getBoundingClientRect().width;
    rs.classList.add('active');
    document.body.classList.add('resizing-panel');
    let w = startW;
    const onMove = ev => {
      w = Math.min(MAX_W, Math.max(MIN_W, startW + ev.clientX - startX));
      document.documentElement.style.setProperty('--panel-w', w + 'px');
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      rs.classList.remove('active');
      document.body.classList.remove('resizing-panel');
      localStorage.setItem('panelW', Math.round(w));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// scroll sync
document.addEventListener('DOMContentLoaded', () => {
  const tw = document.getElementById('tw'), ll = document.getElementById('laneList');
  tw.addEventListener('scroll', () => ll.scrollTop = tw.scrollTop);
  ll.addEventListener('scroll', () => tw.scrollTop = ll.scrollTop);
  setZoom('day');
  initDeadlineControl();
  initLaneControl();
  initPanelResizer();
  const modal = document.querySelector('.modal');
  if (modal) {
    modal.addEventListener('mousedown', e => {
      modalDownInside = true; modalDragged = false;
      modalDownPos = { x: e.clientX, y: e.clientY };
    });
  }
  document.addEventListener('mousemove', e => {
    if (!modalDownInside) return;
    if (Math.abs(e.clientX - modalDownPos.x) > 4 || Math.abs(e.clientY - modalDownPos.y) > 4) modalDragged = true;
  });
  document.addEventListener('mouseup', () => {
    if (!modalDownInside) return;
    setTimeout(() => { modalDownInside = false; modalDragged = false; }, 0);
  });
});

// ── Modal ──
function fmtToday() { return fmtD(new Date()); }
function buildSwatches(sel) {
  const cont = document.getElementById('swatches'); cont.innerHTML = '';
  PALETTE.forEach(c => {
    const sw = document.createElement('div');
    sw.className = 'sw'+(c===sel?' on':''); sw.style.background=c; sw.title=c;
    sw.onclick = () => {
      document.querySelectorAll('.sw').forEach(x=>x.classList.remove('on'));
      sw.classList.add('on');
      document.getElementById('mDeco').style.background=c;
    };
    cont.appendChild(sw);
  });
}
function selColor() { const s=document.querySelector('.sw.on'); return s?s.title:PALETTE[0]; }

function buildRankRow(sel) {
  const row = document.getElementById('rankRow'); row.innerHTML = '';
  [3, 2, 1].forEach(r => {
    const pip = document.createElement('div');
    pip.className = 'rank-pip' + (r === sel ? ' on' : '');
    pip.title = r===3?'高（全ズームで表示）':r===2?'中（週・日で表示）':'低（日のみ表示）';
    pip.textContent = '★'.repeat(r); pip.style.fontSize = '8px';
    pip.onclick = () => {
      document.querySelectorAll('.rank-pip').forEach(x=>x.classList.remove('on'));
      pip.classList.add('on');
    };
    row.appendChild(pip);
  });
}
function selRank() {
  const pips = [...document.querySelectorAll('.rank-pip')];
  const idx = pips.findIndex(p=>p.classList.contains('on'));
  return idx >= 0 ? [3,2,1][idx] : 2;
}

function refreshLaneOptions(selectEl = null, selectedValue = '') {
  const el = selectEl || document.getElementById('fLane');
  if (!el) return;
  el.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = allLanes.length ? 'レーンを選択' : 'レーンがありません';
  placeholder.disabled = allLanes.length > 0;
  el.appendChild(placeholder);
  const laneNames = allLanes.map(l => l.name);
  if (selectedValue && !laneNames.includes(selectedValue)) laneNames.unshift(selectedValue);
  laneNames.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    el.appendChild(opt);
  });
  if (selectedValue) el.value = selectedValue;
  else if (allLanes.length) el.value = allLanes[0].name;
}

function openAdd(prefill) {
  editId = null;
  refreshLaneOptions();
  document.getElementById('mTitle').textContent = 'マイルストーン追加';
  document.getElementById('bDel').style.display = 'none';
  document.getElementById('fName').value = '';
  document.getElementById('fDate').value = (prefill && prefill.date) ? prefill.date : fmtToday();
  initDeadlineControl();
  const defLane = allLanes.length ? allLanes[0].name : 'Lane 1';
  document.getElementById('fLane').value = (prefill && prefill.lane) ? prefill.lane : defLane;
  document.getElementById('fAssignee').value = '';
  document.getElementById('fProg').value = 0;
  document.getElementById('pv').textContent = '0%';
  document.getElementById('depSection').style.display = 'none';
  buildRankRow(2);
  const c = PALETTE[Math.floor(Math.random()*PALETTE.length)];
  buildSwatches(c);
  document.getElementById('mDeco').style.background = c;
  document.getElementById('overlay').classList.add('open');
  document.getElementById('fName').focus();
}

function openEditModal(ms) {
  editId = ms.id;
  refreshLaneOptions();
  document.getElementById('mTitle').textContent = '編集';
  document.getElementById('bDel').style.display = 'inline-block';
  document.getElementById('fName').value = ms.name;
  document.getElementById('fDate').value = ms.date;
  initDeadlineControl();
  document.getElementById('fLane').value = ms.lane || '';
  document.getElementById('fAssignee').value = ms.assignee || '';
  document.getElementById('fProg').value = ms.progress || 0;
  document.getElementById('pv').textContent = (ms.progress || 0) + '%';
  buildRankRow(ms.rank || 2);
  buildSwatches(ms.color || PALETTE[0]);
  document.getElementById('mDeco').style.background = ms.color || PALETTE[0];
  document.getElementById('depSection').style.display = 'none';
  document.getElementById('overlay').classList.add('open');
  document.getElementById('fName').focus();
}

function openDrawer(ms) {
  drawerMsId = ms.id;
  const d = parseD(ms.date);
  const dateStr = `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
  document.getElementById('dDiamond').style.background = ms.color||PALETTE[0];
  document.getElementById('dTitle').textContent = ms.name;
  document.getElementById('dMeta').textContent =
    [ms.assignee, ms.lane, `期限 ${dateStr}`, `進捗 ${ms.progress||0}%`].filter(Boolean).join('  ·  ');
  document.getElementById('drawer').classList.add('open');
  document.getElementById('commentList').innerHTML = '<div class="comment-empty">読み込み中…</div>';
  socket.emit('get_comments', { ms_id: ms.id });
  setTimeout(() => document.getElementById('cText').focus(), 250);
}

function closeDrawer() { document.getElementById('drawer').classList.remove('open'); drawerMsId = null; }

function renderComments(comments) {
  const list = document.getElementById('commentList');
  list.innerHTML = '';
  if (!comments || !comments.length) {
    list.innerHTML = '<div class="comment-empty">まだコメントはありません</div>';
    return;
  }
  comments.forEach(c => {
    const item = document.createElement('div'); item.className = 'comment-item';
    const top = document.createElement('div'); top.className = 'comment-top';
    top.innerHTML =
      `<span class="comment-author">${esc(c.author||'匿名')}</span>` +
      `<span class="comment-ts">${esc(c.ts)}</span>` +
      `<button class="comment-del" onclick="deleteComment('${c.id}')" title="削除">✕</button>`;
    const text = document.createElement('div'); text.className = 'comment-text';
    text.textContent = c.text;
    item.appendChild(top); item.appendChild(text);
    list.appendChild(item);
  });
  list.scrollTop = list.scrollHeight;
}

function sendComment() {
  if (!drawerMsId) return;
  const text = document.getElementById('cText').value.trim();
  if (!text) return;
  const author = document.getElementById('cAuthor').value.trim();
  socket.emit('add_comment', { ms_id: drawerMsId, author, text });
  document.getElementById('cText').value = '';
}

function deleteComment(cid) {
  if (!drawerMsId) return;
  socket.emit('delete_comment', { ms_id: drawerMsId, comment_id: cid });
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('bulkOverlay').classList.contains('open')) closeBulkAdd();
    else if (document.getElementById('overlay').classList.contains('open')) closeModal();
    else if (linkMode) toggleLinkMode();
    else closeDrawer();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (drawerMsId && document.activeElement.id === 'cText') sendComment();
  }
});

function removeDep(depId, e) { e.stopPropagation(); socket.emit('delete_dep', { id: depId }); allDeps = allDeps.filter(d=>d.id!==depId); }

function closeModal() {
  document.getElementById('overlay').classList.remove('open');
  modalDownInside = false; modalDragged = false;
}
function bgClick(e) {
  if (e.target !== e.currentTarget) return;
  if (modalDownInside || modalDragged) return;
  saveMs();
}

function saveMs() {
  const d = {
    name:     document.getElementById('fName').value.trim()||'(無名)',
    date:     document.getElementById('fDate').value,
    lane:     document.getElementById('fLane').value.trim()||'—',
    assignee: document.getElementById('fAssignee').value.trim(),
    progress: parseInt(document.getElementById('fProg').value),
    color:    selColor(),
    rank:     selRank(),
  };
  if (!d.date) { alert('期限日を入力してください'); return; }
  if (editId) socket.emit('update_ms', { ...d, id: editId });
  else        socket.emit('add_ms', d);
  closeModal();
}

function delMs() {
  if (!editId) return;
  if (confirm('削除しますか？')) { socket.emit('delete_ms', { id: editId }); closeModal(); }
}

function exportJson() { window.location.href = '/export'; }

function importJson(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      const data = JSON.parse(ev.target.result);
      const res = await fetch('/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (result.ok) { e.target.value = ''; showToast(`インポート完了：${result.milestones} 件のマイルストーン`); }
      else alert('インポート失敗: ' + result.error);
    } catch (err) { alert('JSONの解析に失敗しました: ' + err.message); }
  };
  reader.readAsText(file);
}

function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div'); t.id = 'toast';
    t.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
      background:var(--text);color:var(--surface);padding:8px 18px;border-radius:20px;
      font-size:12px;z-index:999;opacity:0;transition:opacity .2s;pointer-events:none;`;
    document.body.appendChild(t);
  }
  t.textContent = msg; t.style.opacity = '1';
  setTimeout(() => t.style.opacity = '0', 2500);
}

function esc(s='') { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }

function openBulkAdd() {
  document.getElementById('bulkText').value = '';
  document.getElementById('bulkPreview').innerHTML = '';
  document.getElementById('bulkCount').textContent = '';
  document.getElementById('bulkOverlay').classList.add('open');
  setTimeout(() => document.getElementById('bulkText').focus(), 50);
}
function closeBulkAdd() { document.getElementById('bulkOverlay').classList.remove('open'); }
function bgClickBulk(e) { if (e.target === e.currentTarget) closeBulkAdd(); }

function parseBulkDate(s) {
  if (!s) return null;
  s = s.trim();
  const rel = s.match(/^([+-])(\d+)$/);
  if (rel) {
    const d = new Date(); d.setHours(0,0,0,0);
    d.setDate(d.getDate() + (rel[1] === '+' ? 1 : -1) * parseInt(rel[2]));
    return fmtD(d);
  }
  const md = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (md) {
    const yr = new Date().getFullYear();
    const dt = new Date(yr, parseInt(md[1]) - 1, parseInt(md[2]));
    return isNaN(dt) ? null : fmtD(dt);
  }
  const ymd = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (ymd) {
    const dt = new Date(parseInt(ymd[1]), parseInt(ymd[2]) - 1, parseInt(ymd[3]));
    return isNaN(dt) ? null : fmtD(dt);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const dt = new Date(s + 'T00:00:00');
    return isNaN(dt) ? null : s;
  }
  return null;
}

function parseBulkLine(line) {
  line = line.trim();
  if (!line || line.startsWith('#')) return null;
  const sep = line.includes('|') ? '|' : line.includes('\t') ? '\t' : ',';
  const parts = line.split(sep).map(p => p.trim());
  const name = parts[0];
  if (!name) return { err: '名前が空です' };
  const rawDate = parts[1] || '';
  const dateStr = parseBulkDate(rawDate);
  if (!dateStr) return { err: `日付を解析できません: "${rawDate}"`, name };
  const lane     = parts[2] || (allLanes.length ? allLanes[0].name : 'Lane 1');
  const assignee = parts[3] || '';
  const progress = parts[4] !== undefined ? Math.min(100, Math.max(0, parseInt(parts[4]) || 0)) : 0;
  const rank     = parts[5] !== undefined ? Math.min(3, Math.max(1, parseInt(parts[5]) || 2)) : 2;
  const color    = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  return { name, date: dateStr, lane, assignee, progress, rank, color };
}

function updateBulkPreview() {
  const lines = document.getElementById('bulkText').value.split('\n');
  const preview = document.getElementById('bulkPreview');
  preview.innerHTML = '';
  let okCount = 0, errCount = 0;
  lines.forEach((line, i) => {
    const r = parseBulkLine(line);
    if (!r) return;
    const item = document.createElement('div');
    if (r.err) {
      errCount++;
      item.className = 'bulk-preview-item err';
      item.textContent = `行 ${i + 1}: ${r.err}`;
    } else {
      okCount++;
      item.className = 'bulk-preview-item';
      const dot = document.createElement('div'); dot.className = 'bulk-preview-dot'; dot.style.background = r.color;
      const nm = document.createElement('span'); nm.className = 'bulk-preview-name'; nm.textContent = r.name;
      const meta = document.createElement('span'); meta.className = 'bulk-preview-meta';
      const parts = [r.date, r.lane];
      if (r.assignee) parts.push(r.assignee);
      if (r.progress) parts.push(r.progress + '%');
      meta.textContent = parts.join('  ·  ');
      item.appendChild(dot); item.appendChild(nm); item.appendChild(meta);
    }
    preview.appendChild(item);
  });
  const cntEl = document.getElementById('bulkCount');
  if (okCount + errCount === 0) { cntEl.textContent = ''; return; }
  cntEl.textContent = errCount ? `${okCount} 件 OK、${errCount} 件エラー` : `${okCount} 件を追加予定`;
}

function submitBulkAdd() {
  const lines = document.getElementById('bulkText').value.split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const r = parseBulkLine(lines[i]);
    if (!r) continue;
    if (r.err) { alert(`行 ${i + 1}: ${r.err}`); return; }
    entries.push(r);
  }
  if (!entries.length) { alert('追加する予定がありません'); return; }
  entries.forEach(e => socket.emit('add_ms', e));
  closeBulkAdd();
  showToast(`${entries.length} 件追加しました`);
}
