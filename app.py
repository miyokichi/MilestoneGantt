"""
Milestone Gantt — 依存関係付き・SQLite永続化
================================================
Flask + Flask-SocketIO によるリアルタイム多人数編集

Usage:
  pip install flask flask-socketio
  python app_new.py  →  http://localhost:5000

データは gantt.db に自動保存されます。
"""

from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
import uuid, sqlite3, json, os, random
from datetime import datetime, timedelta

app = Flask(__name__)
app.config['SECRET_KEY'] = 'ms-gantt-2025'
socketio = SocketIO(app, cors_allowed_origins="*")

DB_PATH = os.path.join(os.path.dirname(__file__), 'gantt.db')
connected_users: int = 0

# ── In-memory mirrors (populated from DB on startup) ──
milestones: dict = {}
deps:       list = []
lanes:      list = []
categories: list = []
comments:   dict = {}


# ══════════════════════════════════════════
#  DB helpers
# ══════════════════════════════════════════

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS categories (
                id   TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                ord  INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS lanes (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                ord         INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS milestones (
                id       TEXT PRIMARY KEY,
                name     TEXT,
                date     TEXT,
                lane     TEXT,
                assignee TEXT,
                progress INTEGER DEFAULT 0,
                color    TEXT,
                rank     INTEGER DEFAULT 2,
                kind     TEXT DEFAULT 'milestone',
                effort   REAL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS deps (
                id      TEXT PRIMARY KEY,
                from_id TEXT,
                to_id   TEXT
            );
            CREATE TABLE IF NOT EXISTS comments (
                id      TEXT PRIMARY KEY,
                ms_id   TEXT,
                author  TEXT,
                text    TEXT,
                ts      TEXT
            );
        """)
        # Migrations for existing DBs
        for col, typedef in [('category_id', 'TEXT')]:
            existing = [r[1] for r in db.execute("PRAGMA table_info(lanes)")]
            if col not in existing:
                db.execute(f'ALTER TABLE lanes ADD COLUMN {col} {typedef}')
        for col, typedef in [('kind', "TEXT DEFAULT 'milestone'"), ('effort', 'REAL DEFAULT 0')]:
            existing = [r[1] for r in db.execute("PRAGMA table_info(milestones)")]
            if col not in existing:
                db.execute(f'ALTER TABLE milestones ADD COLUMN {col} {typedef}')


def load_from_db():
    global milestones, deps, lanes, categories, comments
    with get_db() as db:
        categories = [dict(id=r['id'], name=r['name'])
                      for r in db.execute('SELECT id,name FROM categories ORDER BY ord')]
        lanes = [dict(id=r['id'], name=r['name'], category_id=r['category_id'])
                 for r in db.execute('SELECT id,name,category_id FROM lanes ORDER BY ord')]
        milestones = {r['id']: dict(r) for r in db.execute('SELECT * FROM milestones')}
        deps = [dict(r) for r in db.execute('SELECT * FROM deps')]
        rows = db.execute('SELECT * FROM comments ORDER BY rowid')
        comments = {}
        for r in rows:
            d = dict(r)
            comments.setdefault(d['ms_id'], []).append(
                dict(id=d['id'], author=d['author'], text=d['text'], ts=d['ts']))


def save_categories():
    with get_db() as db:
        db.execute('DELETE FROM categories')
        db.executemany('INSERT INTO categories(id,name,ord) VALUES(?,?,?)',
                       [(c['id'], c['name'], i) for i, c in enumerate(categories)])


def save_lanes():
    with get_db() as db:
        db.execute('DELETE FROM lanes')
        db.executemany('INSERT INTO lanes(id,name,ord,category_id) VALUES(?,?,?,?)',
                       [(l['id'], l['name'], i, l.get('category_id')) for i, l in enumerate(lanes)])


def save_milestones():
    with get_db() as db:
        db.execute('DELETE FROM milestones')
        db.executemany(
            'INSERT INTO milestones(id,name,date,lane,assignee,progress,color,rank,kind,effort) '
            'VALUES(?,?,?,?,?,?,?,?,?,?)',
            [(m['id'], m.get('name'), m.get('date'), m.get('lane'), m.get('assignee'),
              m.get('progress', 0), m.get('color'), m.get('rank', 2),
              m.get('kind', 'milestone'), m.get('effort', 0)) for m in milestones.values()])


def save_deps():
    with get_db() as db:
        db.execute('DELETE FROM deps')
        db.executemany('INSERT INTO deps(id,from_id,to_id) VALUES(:id,:from_id,:to_id)', deps)


def save_comments_for(ms_id):
    with get_db() as db:
        db.execute('DELETE FROM comments WHERE ms_id=?', (ms_id,))
        for c in comments.get(ms_id, []):
            db.execute('INSERT INTO comments(id,ms_id,author,text,ts) VALUES(?,?,?,?,?)',
                       (c['id'], ms_id, c['author'], c['text'], c['ts']))


def _pdate(s):
    return datetime.strptime(s, '%Y-%m-%d').date()


def compute_schedule():
    """Forward pass. dep(from->to) = `from` precedes `to`. Derived, never stored.
    task:  start = max(prereq ends) or project start; end = start + effort days.
    ms:    target = its date; ready = max(prereq ends) or target; slip = ready - target."""
    prereq = {}
    for d in deps:
        prereq.setdefault(d['to_id'], []).append(d['from_id'])
    all_dates = [_pdate(m['date']) for m in milestones.values() if m.get('date')]
    proj0 = min(all_dates) if all_dates else datetime.now().date()
    memo, visiting, out = {}, set(), {}

    def end_of(mid):
        if mid in memo:
            return memo[mid]
        if mid in visiting:                       # cycle guard
            return proj0
        m = milestones.get(mid)
        if not m:
            return proj0
        visiting.add(mid)
        pre = [end_of(p) for p in prereq.get(mid, []) if p in milestones]
        if (m.get('kind') or 'milestone') == 'task':
            start = max(pre) if pre else proj0
            eff = int(m.get('effort') or 1)
            end = start + timedelta(days=max(1, eff))
            out[mid] = {'kind': 'task', 'c_start': start.isoformat(), 'c_end': end.isoformat()}
            memo[mid] = end
        else:
            target = _pdate(m['date']) if m.get('date') else proj0
            ready = max(pre) if pre else target
            out[mid] = {'kind': 'milestone', 'c_ready': ready.isoformat(),
                        'c_slip': (ready - target).days}
            memo[mid] = ready
        visiting.discard(mid)
        return memo[mid]

    for mid in list(milestones):
        end_of(mid)
    return out


def ms_view():
    """Milestones augmented with derived schedule, for the renderer / API."""
    sched = compute_schedule()
    rows = []
    for m in milestones.values():
        c = dict(m)
        c.setdefault('kind', 'milestone')
        c.setdefault('effort', 0)
        c.update(sched.get(m['id'], {}))
        rows.append(c)
    return rows


def _seed():
    """Insert sample data only when DB is empty."""
    today = datetime.now().date()
    global lanes, categories

    cat_defs = [("企画・設計", None), ("開発", None), ("リリース", None)]
    for cname, _ in cat_defs:
        cid = str(uuid.uuid4())
        categories.append({"id": cid, "name": cname})
    cat_by_name = {c['name']: c['id'] for c in categories}

    lane_defs = [
        ("Phase 1", "企画・設計"),
        ("Phase 2", "開発"),
        ("Phase 3", "リリース"),
    ]
    for ln, cn in lane_defs:
        lid = str(uuid.uuid4())
        lanes.append({"id": lid, "name": ln, "category_id": cat_by_name.get(cn)})

    data = [
        ("要件定義完了",     -5, "Phase 1", "Airi",   100, "#7c9885", 3),
        ("設計レビュー",     +4, "Phase 1", "Bunta",   70, "#7b8fa8", 2),
        ("DB設計完了",      +10, "Phase 2", "Chiyo",   30, "#a07060", 2),
        ("API仕様確定",     +14, "Phase 2", "Bunta",    0, "#8a7bab", 2),
        ("フロント実装完了", +24, "Phase 2", "Daiki",    0, "#a08060", 1),
        ("α版リリース",     +28, "Phase 3", "Airi",     0, "#5e8c8a", 3),
        ("テスト完了",      +35, "Phase 3", "Chiyo",    0, "#8a6070", 2),
        ("本番リリース",    +40, "Phase 3", "Daiki",    0, "#9a7058", 3),
    ]
    ids = []
    for name, off, lane_name, assignee, progress, color, rank in data:
        tid = str(uuid.uuid4())
        date = str(today + timedelta(days=off))
        milestones[tid] = dict(id=tid, name=name, date=date, lane=lane_name,
                               assignee=assignee, progress=progress, color=color, rank=rank,
                               kind='milestone', effort=0)
        ids.append(tid)
    chains = [(0,1),(1,2),(1,3),(2,4),(3,4),(4,5),(5,6),(6,7)]
    for f, t in chains:
        deps.append({"id": str(uuid.uuid4()), "from_id": ids[f], "to_id": ids[t]})

    # sample TASKS (kind='task'): bar position is derived from deps + effort
    t_defs = [("API実装",   "Phase 2", "Bunta", "#7b8fa8", 6, 60),
              ("画面実装",   "Phase 2", "Daiki", "#a08060", 5, 20),
              ("結合テスト", "Phase 3", "Chiyo", "#8a6070", 4, 0)]
    t_ids = []
    for name, lane_name, assignee, color, effort, progress in t_defs:
        tid = str(uuid.uuid4())
        milestones[tid] = dict(id=tid, name=name, date=str(today), lane=lane_name,
                               assignee=assignee, progress=progress, color=color, rank=1,
                               kind='task', effort=effort)
        t_ids.append(tid)
    tdeps = [(ids[3], t_ids[0]), (ids[1], t_ids[1]),
             (t_ids[0], t_ids[2]), (t_ids[1], t_ids[2]), (t_ids[2], ids[6])]
    for f, t in tdeps:
        deps.append({"id": str(uuid.uuid4()), "from_id": f, "to_id": t})

    save_categories(); save_lanes(); save_milestones(); save_deps()


# ── Startup ──
init_db()
load_from_db()
if not lanes:          # first run: populate with sample data
    _seed()


# ══════════════════════════════════════════
#  Flask routes
# ══════════════════════════════════════════

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/export')
def export_json():
    from flask import Response
    data = {
        "categories": categories,
        "lanes":      lanes,
        "milestones": list(milestones.values()),
        "deps":       deps,
        "comments":   comments,
        "exported_at": datetime.now().isoformat(),
    }
    return Response(
        json.dumps(data, ensure_ascii=False, indent=2),
        mimetype='application/json',
        headers={'Content-Disposition': 'attachment; filename="gantt_export.json"'}
    )


@app.route('/import', methods=['POST'])
def import_json():
    from flask import request, jsonify
    global milestones, deps, lanes, categories, comments
    try:
        data = request.get_json(force=True)
        if not isinstance(data, dict):
            raise ValueError("invalid format")

        categories = data.get('categories', [])
        lanes      = data.get('lanes', [])
        milestones = {m['id']: m for m in data.get('milestones', [])}
        deps       = data.get('deps', [])
        comments   = {k: v for k, v in data.get('comments', {}).items()}

        save_categories(); save_lanes(); save_milestones(); save_deps()
        with get_db() as db:
            db.execute('DELETE FROM comments')
            for ms_id, clist in comments.items():
                for c in clist:
                    db.execute('INSERT INTO comments(id,ms_id,author,text,ts) VALUES(?,?,?,?,?)',
                               (c['id'], ms_id, c['author'], c['text'], c['ts']))

        socketio.emit('categories_update', categories)
        socketio.emit('ms_update',    ms_view())
        socketio.emit('deps_update',  deps)
        socketio.emit('lanes_update', lanes)

        return jsonify({"ok": True, "milestones": len(milestones), "lanes": len(lanes)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


# ══════════════════════════════════════════
#  REST API  (for scripts / AI agents)
# ══════════════════════════════════════════
#  Every mutation updates the DB *and* pushes a live update to connected
#  browsers, so an agent and a human edit the same board in real time.
#
#  GET    /api                                  → this endpoint list
#  GET    /api/state                            → full board
#  GET    /api/lanes                            → lanes
#  GET    /api/milestones                       → all milestones
#  POST   /api/milestones                       → create {name,date,lane,assignee?,progress?,color?,rank?}
#  GET    /api/milestones/<id>                  → one milestone (+ its comments)
#  PATCH  /api/milestones/<id>                  → update any subset of fields
#  DELETE /api/milestones/<id>                  → delete (also drops its deps)
#  GET    /api/milestones/<id>/comments         → list comments
#  POST   /api/milestones/<id>/comments         → add {text, author?}
#  DELETE /api/milestones/<id>/comments/<cid>   → delete a comment
#  GET    /api/deps                             → dependencies
#  POST   /api/deps                             → add {from_id, to_id}
#  DELETE /api/deps/<id>                        → delete

API_PALETTE = ['#7c9885', '#7b8fa8', '#a07060', '#8a7bab', '#a08060',
               '#5e8c8a', '#8a6070', '#9a7058', '#6a7a5a', '#7888a8']


@app.after_request
def _add_cors(resp):
    resp.headers['Access-Control-Allow-Origin']  = '*'
    resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return resp


def push_state():
    """Broadcast the whole board to every connected browser."""
    socketio.emit('categories_update', categories)
    socketio.emit('ms_update',    ms_view())
    socketio.emit('deps_update',  deps)
    socketio.emit('lanes_update', lanes)


def _valid_date(s):
    try:
        datetime.strptime(str(s), '%Y-%m-%d')
        return True
    except (ValueError, TypeError):
        return False


def _err(msg, code=400):
    return jsonify({"ok": False, "error": msg}), code


@app.route('/api')
def api_index():
    return jsonify({"ok": True, "endpoints": [
        "GET    /api/state",
        "GET    /api/lanes",
        "GET    /api/milestones",
        "POST   /api/milestones",
        "GET    /api/milestones/<id>",
        "PATCH  /api/milestones/<id>",
        "DELETE /api/milestones/<id>",
        "GET    /api/milestones/<id>/comments",
        "POST   /api/milestones/<id>/comments",
        "DELETE /api/milestones/<id>/comments/<cid>",
        "GET    /api/deps",
        "POST   /api/deps",
        "DELETE /api/deps/<id>",
    ]})


@app.route('/api/state')
def api_state():
    return jsonify({
        "categories": categories,
        "lanes":      lanes,
        "milestones": ms_view(),
        "deps":       deps,
        "comments":   comments,
    })


@app.route('/api/lanes')
def api_lanes():
    return jsonify(lanes)


@app.route('/api/milestones')
def api_list_ms():
    return jsonify(ms_view())


@app.route('/api/milestones', methods=['POST'])
def api_create_ms():
    data = request.get_json(silent=True) or {}
    date = data.get('date')
    if not _valid_date(date):
        return _err("`date` is required in YYYY-MM-DD format")
    try:
        progress = max(0, min(100, int(data.get('progress', 0) or 0)))
        rank     = max(1, min(3, int(data.get('rank', 2) or 2)))
    except (ValueError, TypeError):
        return _err("`progress` and `rank` must be numbers")
    tid = str(uuid.uuid4())
    ms = {
        "id":       tid,
        "name":     str(data.get('name', '')).strip() or '(無名)',
        "date":     date,
        "lane":     str(data.get('lane', '—')) or '—',
        "assignee": str(data.get('assignee', '')),
        "progress": progress,
        "color":    data.get('color') or random.choice(API_PALETTE),
        "rank":     rank,
        "kind":     'task' if data.get('kind') == 'task' else 'milestone',
        "effort":   max(0.0, float(data.get('effort') or 0)),
    }
    milestones[tid] = ms
    save_milestones()
    push_state()
    return jsonify({"ok": True, "milestone": ms}), 201


@app.route('/api/milestones/<mid>')
def api_get_ms(mid):
    if mid not in milestones:
        return _err("milestone not found", 404)
    return jsonify({**milestones[mid], "comments": comments.get(mid, [])})


@app.route('/api/milestones/<mid>', methods=['PATCH'])
def api_update_ms(mid):
    if mid not in milestones:
        return _err("milestone not found", 404)
    data = request.get_json(silent=True) or {}
    ms = milestones[mid]
    try:
        if 'date' in data:
            if not _valid_date(data['date']):
                return _err("`date` must be YYYY-MM-DD")
            ms['date'] = data['date']
        if 'name' in data:     ms['name'] = str(data['name']).strip() or '(無名)'
        if 'lane' in data:     ms['lane'] = str(data['lane']) or '—'
        if 'assignee' in data: ms['assignee'] = str(data['assignee'])
        if 'progress' in data: ms['progress'] = max(0, min(100, int(data['progress'] or 0)))
        if 'rank' in data:     ms['rank'] = max(1, min(3, int(data['rank'] or 2)))
        if data.get('color'):  ms['color'] = data['color']
        if 'kind' in data:     ms['kind'] = 'task' if data['kind'] == 'task' else 'milestone'
        if 'effort' in data:   ms['effort'] = max(0.0, float(data['effort'] or 0))
    except (ValueError, TypeError):
        return _err("`progress` and `rank` must be numbers")
    save_milestones()
    push_state()
    return jsonify({"ok": True, "milestone": ms})


@app.route('/api/milestones/<mid>', methods=['DELETE'])
def api_delete_ms(mid):
    global deps
    if mid not in milestones:
        return _err("milestone not found", 404)
    del milestones[mid]
    deps = [d for d in deps if d['from_id'] != mid and d['to_id'] != mid]
    save_milestones(); save_deps()
    push_state()
    return jsonify({"ok": True})


@app.route('/api/milestones/<mid>/comments')
def api_list_comments(mid):
    if mid not in milestones:
        return _err("milestone not found", 404)
    return jsonify(comments.get(mid, []))


@app.route('/api/milestones/<mid>/comments', methods=['POST'])
def api_add_comment(mid):
    if mid not in milestones:
        return _err("milestone not found", 404)
    data = request.get_json(silent=True) or {}
    text = str(data.get('text', '')).strip()
    if not text:
        return _err("`text` is required")
    entry = {
        "id":     str(uuid.uuid4()),
        "author": str(data.get('author', '')),
        "text":   text,
        "ts":     datetime.now().strftime('%m/%d %H:%M'),
    }
    comments.setdefault(mid, []).append(entry)
    save_comments_for(mid)
    socketio.emit('comments_data', {'ms_id': mid, 'comments': comments[mid]})
    return jsonify({"ok": True, "comment": entry}), 201


@app.route('/api/milestones/<mid>/comments/<cid>', methods=['DELETE'])
def api_delete_comment(mid, cid):
    if mid not in comments:
        return _err("milestone has no comments", 404)
    before = len(comments[mid])
    comments[mid] = [c for c in comments[mid] if c['id'] != cid]
    if len(comments[mid]) == before:
        return _err("comment not found", 404)
    save_comments_for(mid)
    socketio.emit('comments_data', {'ms_id': mid, 'comments': comments[mid]})
    return jsonify({"ok": True})


@app.route('/api/deps')
def api_list_deps():
    return jsonify(deps)


@app.route('/api/deps', methods=['POST'])
def api_add_dep():
    data = request.get_json(silent=True) or {}
    f, t = data.get('from_id'), data.get('to_id')
    if f not in milestones or t not in milestones:
        return _err("`from_id` and `to_id` must be existing milestone ids")
    for d in deps:
        if d['from_id'] == f and d['to_id'] == t:
            return jsonify({"ok": True, "dep": d})   # idempotent
    dep = {"id": str(uuid.uuid4()), "from_id": f, "to_id": t}
    deps.append(dep)
    save_deps()
    push_state()
    return jsonify({"ok": True, "dep": dep}), 201


@app.route('/api/deps/<did>', methods=['DELETE'])
def api_delete_dep(did):
    global deps
    before = len(deps)
    deps = [d for d in deps if d['id'] != did]
    if len(deps) == before:
        return _err("dep not found", 404)
    save_deps()
    push_state()
    return jsonify({"ok": True})


# ══════════════════════════════════════════
#  Socket events
# ══════════════════════════════════════════

def broadcast_state():
    emit('categories_update', categories,               broadcast=True)
    emit('ms_update',         ms_view(), broadcast=True)
    emit('deps_update',       deps,                      broadcast=True)
    emit('lanes_update',      lanes,                     broadcast=True)


@socketio.on('connect')
def on_connect():
    global connected_users
    connected_users += 1
    emit('categories_update', categories)
    emit('ms_update',    ms_view())
    emit('deps_update',  deps)
    emit('lanes_update', lanes)
    emit('user_count',   connected_users, broadcast=True)


@socketio.on('disconnect')
def on_disconnect():
    global connected_users
    connected_users = max(0, connected_users - 1)
    emit('user_count', connected_users, broadcast=True)


@socketio.on('get_state')
def on_get():
    emit('categories_update', categories)
    emit('ms_update',    ms_view())
    emit('deps_update',  deps)
    emit('lanes_update', lanes)


# ── Category events ──

@socketio.on('add_category')
def on_add_category(data):
    cid = str(uuid.uuid4())
    categories.append({"id": cid, "name": data.get("name", "New Category")})
    save_categories()
    broadcast_state()


@socketio.on('rename_category')
def on_rename_category(data):
    cid = data.get('id')
    new_name = data.get('name', '').strip()
    if not new_name:
        return
    for cat in categories:
        if cat['id'] == cid:
            cat['name'] = new_name
    save_categories()
    broadcast_state()


@socketio.on('delete_category')
def on_delete_category(data):
    global categories
    cid = data.get('id')
    categories = [c for c in categories if c['id'] != cid]
    for lane in lanes:
        if lane.get('category_id') == cid:
            lane['category_id'] = None
    save_categories(); save_lanes()
    broadcast_state()


@socketio.on('set_lane_category')
def on_set_lane_category(data):
    lane_name   = data.get('lane_name')
    category_id = data.get('category_id')  # None to unassign
    for lane in lanes:
        if lane['name'] == lane_name:
            lane['category_id'] = category_id
    save_lanes()
    broadcast_state()


# ── Lane events ──

@socketio.on('add_lane')
def on_add_lane(data):
    lid = str(uuid.uuid4())
    lanes.append({"id": lid, "name": data.get("name", "New Lane"),
                  "category_id": data.get("category_id")})
    save_lanes()
    broadcast_state()


@socketio.on('rename_lane')
def on_rename_lane(data):
    old_name = data.get('old_name')
    new_name = data.get('new_name', '').strip()
    if not new_name:
        return
    for lane in lanes:
        if lane['name'] == old_name:
            lane['name'] = new_name
    for ms in milestones.values():
        if ms.get('lane') == old_name:
            ms['lane'] = new_name
    save_lanes(); save_milestones()
    broadcast_state()


@socketio.on('delete_lane')
def on_delete_lane(data):
    global lanes
    name = data.get('name')
    lanes = [l for l in lanes if l['name'] != name]
    to_del = [tid for tid, ms in milestones.items() if ms.get('lane') == name]
    for tid in to_del:
        del milestones[tid]
    save_lanes(); save_milestones()
    broadcast_state()


@socketio.on('move_lane')
def on_move_lane(data):
    """Drag & drop / up-down: reorder lanes (and optionally reassign category).

    Lanes are keyed by their unique id (names may be duplicated)."""
    global lanes
    lane_id     = data.get('id')
    new_order   = data.get('order', [])      # list of lane ids, new order
    category_id = data.get('category_id')    # None = uncategorized

    id_to_lane = {l['id']: l for l in lanes}
    if lane_id in id_to_lane:
        id_to_lane[lane_id]['category_id'] = category_id

    reordered = [id_to_lane[i] for i in new_order if i in id_to_lane]
    # Safety: keep any lane that wasn't listed (don't drop data)
    seen = set(new_order)
    reordered += [l for l in lanes if l['id'] not in seen]

    lanes = reordered
    save_lanes()
    broadcast_state()


@socketio.on('add_ms')
def on_add_ms(data):
    tid = str(uuid.uuid4())
    milestones[tid] = {'kind': 'milestone', 'effort': 0, **data, 'id': tid}
    save_milestones()
    broadcast_state()


@socketio.on('update_ms')
def on_update_ms(data):
    tid = data.get('id')
    if tid in milestones:
        milestones[tid].update(data)
        save_milestones()
        broadcast_state()


@socketio.on('delete_ms')
def on_delete_ms(data):
    global deps
    tid = data.get('id')
    if tid in milestones:
        del milestones[tid]
        deps = [d for d in deps if d['from_id'] != tid and d['to_id'] != tid]
        save_milestones(); save_deps()
        broadcast_state()


@socketio.on('add_dep')
def on_add_dep(data):
    for d in deps:
        if d['from_id'] == data['from_id'] and d['to_id'] == data['to_id']:
            return
    deps.append({"id": str(uuid.uuid4()), "from_id": data['from_id'], "to_id": data['to_id']})
    save_deps()
    broadcast_state()


@socketio.on('delete_dep')
def on_delete_dep(data):
    global deps
    deps = [d for d in deps if d['id'] != data['id']]
    save_deps()
    broadcast_state()


@socketio.on('get_comments')
def on_get_comments(data):
    ms_id = data.get('ms_id')
    emit('comments_data', {'ms_id': ms_id, 'comments': comments.get(ms_id, [])})


@socketio.on('add_comment')
def on_add_comment(data):
    ms_id = data.get('ms_id')
    if not ms_id or ms_id not in milestones:
        return
    if ms_id not in comments:
        comments[ms_id] = []
    cid = str(uuid.uuid4())
    ts = datetime.now().strftime('%m/%d %H:%M')
    entry = {"id": cid, "author": data.get('author', ''), "text": data.get('text', ''), "ts": ts}
    comments[ms_id].append(entry)
    save_comments_for(ms_id)
    emit('comments_data', {'ms_id': ms_id, 'comments': comments[ms_id]}, broadcast=True)


@socketio.on('delete_comment')
def on_delete_comment(data):
    ms_id = data.get('ms_id')
    cid = data.get('comment_id')
    if ms_id in comments:
        comments[ms_id] = [c for c in comments[ms_id] if c['id'] != cid]
        save_comments_for(ms_id)
        emit('comments_data', {'ms_id': ms_id, 'comments': comments[ms_id]}, broadcast=True)


if __name__ == '__main__':
    print("=" * 50)
    print("  ◆  Milestone Gantt — 依存関係付き")
    print("=" * 50)
    print("  → http://localhost:5000")
    print("=" * 50)
    socketio.run(app, debug=True, port=5000)
