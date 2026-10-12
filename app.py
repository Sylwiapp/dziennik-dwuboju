"""Plan treningowy trenera i dziennik zawodnika — dwubój olimpijski.

Uruchomienie:
    py -3 -m pip install flask
    py -3 app.py
Potem otwórz http://127.0.0.1:5055

Konta demonstracyjne: trener / trener oraz zawodnik / zawodnik.
"""

import sqlite3
from datetime import date, timedelta
from pathlib import Path

from flask import (
    Flask,
    abort,
    flash,
    g,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

from calc import (
    ARTICLE_GROUPS,
    COMPLEX_LABELS,
    article_by_group,
    as_fraction,
    summarize_microcycles,
    summarize_plan,
    summarize_session,
)

BASE = Path(__file__).resolve().parent
DB_PATH = BASE / "data.db"

app = Flask(__name__)
app.secret_key = "mgr-dwuboj-lokalnie"
app.config["TEMPLATES_AUTO_RELOAD"] = True

KINDS = ("specjalne", "uzupełniające", "rozciągające")
SESSION_TYPES = (("PC", "PC — podnoszenie ciężarów"), ("SIL", "siłowy"), ("INNE", "inny"))
DAY_NAMES = (
    "poniedziałek",
    "wtorek",
    "środa",
    "czwartek",
    "piątek",
    "sobota",
    "niedziela",
)


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = connect()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT UNIQUE,
            password TEXT,
            role TEXT
        );
        CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY,
            name TEXT,
            max_kg REAL
        );
        CREATE TABLE IF NOT EXISTS microcycles (
            id INTEGER PRIMARY KEY,
            period_no INTEGER,
            micro_no INTEGER,
            start_date TEXT,
            intensity_note TEXT,
            volume_note TEXT,
            UNIQUE (period_no, micro_no)
        );
        CREATE TABLE IF NOT EXISTS plan_days (
            id INTEGER PRIMARY KEY,
            microcycle_id INTEGER,
            day_index INTEGER,
            load_level TEXT,
            note TEXT
        );
        CREATE TABLE IF NOT EXISTS plan_exercises (
            id INTEGER PRIMARY KEY,
            plan_day_id INTEGER,
            name TEXT,
            complex TEXT,
            kind TEXT,
            sets_text TEXT,
            reps_text TEXT,
            intensity REAL,
            record_id INTEGER
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY,
            session_date TEXT,
            period_no INTEGER,
            micro_no INTEGER,
            session_in_micro INTEGER,
            session_type TEXT,
            time_s REAL,
            rpe_s REAL,
            time_w REAL,
            rpe_w REAL
        );
        CREATE TABLE IF NOT EXISTS diary_rows (
            id INTEGER PRIMARY KEY,
            session_id INTEGER,
            exercise_no INTEGER,
            name TEXT,
            complex TEXT,
            sets_text TEXT,
            reps_text TEXT,
            load_kg REAL,
            record_kg REAL,
            record_name TEXT
        );
        """
    )
    if conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"] == 0:
        conn.executemany(
            "INSERT INTO users (username, password, role) VALUES (?, ?, ?)",
            [("trener", "trener", "coach"), ("zawodnik", "zawodnik", "athlete")],
        )
        seed(conn)
    conn.commit()
    conn.close()


def seed(conn):
    records = [
        ("rwanie", 95),
        ("podrzut", 115),
        ("ciąg", 115),
        ("przysiad", 153),
        ("wyciskanie", 55),
    ]
    for name, max_kg in records:
        conn.execute("INSERT INTO records (name, max_kg) VALUES (?, ?)", (name, max_kg))
    by_name = {
        row["name"]: row["id"]
        for row in conn.execute("SELECT id, name FROM records")
    }

    start = date(2024, 12, 30)
    for micro in range(1, 6):
        conn.execute(
            """
            INSERT INTO microcycles (period_no, micro_no, start_date, intensity_note, volume_note)
            VALUES (1, ?, ?, ?, ?)
            """,
            (
                micro,
                (start + timedelta(days=7 * (micro - 1))).isoformat(),
                "70–80% rekordu w środkach specjalnych",
                "objętość średnia, niedziela regeneracja" if micro < 5 else "objętość niższa przed startem",
            ),
        )
        micro_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        levels = ("średnie", "duże", "średnie", "małe", "duże", "średnie", "regeneracja")
        for day_index, level in enumerate(levels, start=1):
            conn.execute(
                """
                INSERT INTO plan_days (microcycle_id, day_index, load_level, note)
                VALUES (?, ?, ?, ?)
                """,
                (micro_id, day_index, level, ""),
            )

    plan_days = {
        row["day_index"]: row["id"]
        for row in conn.execute(
            """
            SELECT d.id, d.day_index
            FROM plan_days d
            JOIN microcycles m ON m.id = d.microcycle_id
            WHERE m.micro_no = 5
            """
        )
    }
    planned = [
        (1, "rwanie na siad", "C1", "specjalne", "4", "3", 0.70, "rwanie"),
        (1, "zarzut na siad + podrzut", "C2", "specjalne", "3", "2+1", 0.75, "podrzut"),
        (1, "przysiady tył", "C4", "specjalne", "3", "6", 0.70, "przysiad"),
        (1, "skoki przez płotki", "C9", "uzupełniające", "4", "5", None, None),
        (3, "ciągi podrzutowe", "C3", "specjalne", "5", "3", 0.80, "ciąg"),
        (3, "rwanie na wysoko", "C1", "specjalne", "5", "2", 0.75, "rwanie"),
        (3, "rozciąganie mm. czworogłowych", "C10", "rozciągające", "2", "8", None, None),
        (5, "wyciskanie stojąc", "C6", "specjalne", "3", "8", 0.60, "wyciskanie"),
        (5, "przysiady przód", "C4", "specjalne", "4", "5", 0.75, "przysiad"),
    ]
    for day_index, name, complex_code, kind, sets_text, reps_text, intensity, record_name in planned:
        conn.execute(
            """
            INSERT INTO plan_exercises
                (plan_day_id, name, complex, kind, sets_text, reps_text, intensity, record_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                plan_days[day_index],
                name,
                complex_code,
                kind,
                sets_text,
                reps_text,
                intensity,
                by_name.get(record_name),
            ),
        )

    # Pięć mikrocykli realizacji, żeby ACWR miało z czego liczyć średnią.
    loads = (0.62, 0.70, 0.78, 0.84, 0.72)
    volumes = (3, 4, 5, 5, 3)
    for micro, (fraction, sets) in enumerate(zip(loads, volumes), start=1):
        week = start + timedelta(days=7 * (micro - 1))
        sessions = [
            (0, "PC", 1, 50, 5, 15, 4),
            (2, "PC", 2, 60, 6, 20, 5),
            (4, "SIL", 3, 45, 6, 15, 4),
        ]
        for offset, kind, number, time_s, rpe_s, time_w, rpe_w in sessions:
            conn.execute(
                """
                INSERT INTO sessions
                    (session_date, period_no, micro_no, session_in_micro, session_type,
                     time_s, rpe_s, time_w, rpe_w)
                VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
                """,
                ((week + timedelta(days=offset)).isoformat(), micro, number, kind, time_s, rpe_s, time_w, rpe_w),
            )
            session_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            if kind == "PC":
                rows = [
                    (1, "rwanie", "C1", str(sets), "3", round(95 * fraction), "rwanie"),
                    (2, "zarzut + podrzut", "C2", str(max(sets - 1, 2)), "3", round(115 * fraction), "podrzut"),
                    (3, "ciągi", "C3", str(sets), "3", round(115 * (fraction + 0.05)), "ciąg"),
                ]
            else:
                rows = [
                    (1, "przysiady tył", "C4", str(sets), "5", round(153 * fraction), "przysiad"),
                    (2, "wyciskanie", "C6", "3", "8", round(55 * fraction), "wyciskanie"),
                ]
            for exercise_no, name, complex_code, sets_text, reps_text, load_kg, record_name in rows:
                conn.execute(
                    """
                    INSERT INTO diary_rows
                        (session_id, exercise_no, name, complex, sets_text, reps_text,
                         load_kg, record_kg, record_name)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        session_id,
                        exercise_no,
                        name,
                        complex_code,
                        sets_text,
                        reps_text,
                        load_kg,
                        dict(records)[record_name],
                        record_name,
                    ),
                )


@app.before_request
def open_db():
    g.db = connect()


@app.teardown_request
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


@app.template_filter("pl")
def format_pl(value, digits=1):
    if value is None:
        return "—"
    text = f"{float(value):.{int(digits)}f}"
    return text.replace(".", ",")


@app.template_filter("pct")
def format_pct(value):
    if value is None:
        return "—"
    return format_pl(float(value) * 100, 0) + "%"


def current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    return g.db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


class NeedLogin(Exception):
    pass


def login_required():
    user = current_user()
    if user is None:
        raise NeedLogin()
    return user


@app.errorhandler(NeedLogin)
def _need_login(_exc):
    return redirect(url_for("login"))


def coach_required():
    user = login_required()
    if user["role"] != "coach":
        abort(403)
    return user


@app.context_processor
def inject_user():
    return {
        "me": current_user(),
        "complexes": COMPLEX_LABELS,
        "kinds": KINDS,
        "session_types": SESSION_TYPES,
    }


@app.route("/")
def home():
    user = current_user()
    if user is None:
        return redirect(url_for("login"))
    if user["role"] == "coach":
        return redirect(url_for("plan_list"))
    return redirect(url_for("diary_list"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        user = g.db.execute(
            "SELECT * FROM users WHERE username = ? AND password = ?",
            (request.form.get("username", "").strip(), request.form.get("password", "")),
        ).fetchone()
        if user is None:
            flash("Nie ma takiego konta. Użyj trener / trener albo zawodnik / zawodnik.")
        else:
            session["user_id"] = user["id"]
            return redirect(url_for("home"))
    return render_template("login.html")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


def week_number(iso_date):
    return date.fromisoformat(iso_date).isocalendar()[1]


def day_title(start_iso, day_index):
    current = date.fromisoformat(start_iso) + timedelta(days=day_index - 1)
    return f"{DAY_NAMES[current.weekday()]} {current.strftime('%d.%m.%Y')}", current


@app.route("/plan")
def plan_list():
    login_required()
    rows = g.db.execute(
        "SELECT * FROM microcycles ORDER BY period_no, micro_no"
    ).fetchall()
    return render_template("plan_list.html", microcycles=rows)


@app.route("/plan/nowy", methods=["POST"])
def plan_new():
    coach_required()
    period_no = int(request.form["period_no"])
    micro_no = int(request.form["micro_no"])
    start_date = request.form["start_date"]
    try:
        date.fromisoformat(start_date)
    except ValueError:
        flash("Data początku mikrocyklu jest niepoprawna.")
        return redirect(url_for("plan_list"))
    exists = g.db.execute(
        "SELECT id FROM microcycles WHERE period_no = ? AND micro_no = ?",
        (period_no, micro_no),
    ).fetchone()
    if exists:
        flash("Taki okres i mikrocykl już jest w planie.")
        return redirect(url_for("plan_detail", micro_id=exists["id"]))
    g.db.execute(
        """
        INSERT INTO microcycles (period_no, micro_no, start_date, intensity_note, volume_note)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            period_no,
            micro_no,
            start_date,
            request.form.get("intensity_note", "").strip(),
            request.form.get("volume_note", "").strip(),
        ),
    )
    micro_id = g.db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    levels = ("średnie", "duże", "średnie", "małe", "duże", "średnie", "regeneracja")
    for day_index, level in enumerate(levels, start=1):
        g.db.execute(
            "INSERT INTO plan_days (microcycle_id, day_index, load_level, note) VALUES (?, ?, ?, '')",
            (micro_id, day_index, level),
        )
    g.db.commit()
    return redirect(url_for("plan_detail", micro_id=micro_id))


def load_microcycle(micro_id):
    micro = g.db.execute("SELECT * FROM microcycles WHERE id = ?", (micro_id,)).fetchone()
    if micro is None:
        abort(404)
    days = g.db.execute(
        "SELECT * FROM plan_days WHERE microcycle_id = ? ORDER BY day_index",
        (micro_id,),
    ).fetchall()
    exercises = g.db.execute(
        """
        SELECT e.*, r.name AS record_name, r.max_kg AS record_kg
        FROM plan_exercises e
        LEFT JOIN records r ON r.id = e.record_id
        WHERE e.plan_day_id IN (SELECT id FROM plan_days WHERE microcycle_id = ?)
        ORDER BY e.id
        """,
        (micro_id,),
    ).fetchall()
    by_day = {day["id"]: [] for day in days}
    for exercise in exercises:
        by_day[exercise["plan_day_id"]].append(exercise)
    records = g.db.execute("SELECT * FROM records ORDER BY name").fetchall()
    return micro, days, by_day, records


@app.route("/plan/<int:micro_id>")
def plan_detail(micro_id):
    login_required()
    micro, days, by_day, records = load_microcycle(micro_id)
    prepared = []
    for day in days:
        title, current = day_title(micro["start_date"], day["day_index"])
        items = by_day[day["id"]]
        prepared.append(
            {
                "day": day,
                "title": title,
                "date": current,
                "exercises": items,
                "summary": summarize_plan(items),
            }
        )
    return render_template(
        "plan_detail.html",
        micro=micro,
        days=prepared,
        records=records,
        whole=summarize_plan([item for day in by_day.values() for item in day]),
    )


@app.route("/plan/<int:micro_id>/opis", methods=["POST"])
def plan_update(micro_id):
    coach_required()
    g.db.execute(
        """
        UPDATE microcycles
        SET intensity_note = ?, volume_note = ?
        WHERE id = ?
        """,
        (
            request.form.get("intensity_note", "").strip(),
            request.form.get("volume_note", "").strip(),
            micro_id,
        ),
    )
    for day in g.db.execute("SELECT id FROM plan_days WHERE microcycle_id = ?", (micro_id,)):
        g.db.execute(
            "UPDATE plan_days SET load_level = ?, note = ? WHERE id = ?",
            (
                request.form.get(f"load_{day['id']}", "").strip(),
                request.form.get(f"note_{day['id']}", "").strip(),
                day["id"],
            ),
        )
    g.db.commit()
    return redirect(url_for("plan_detail", micro_id=micro_id))


@app.route("/plan/dzien/<int:day_id>/cwiczenie", methods=["POST"])
def plan_add_exercise(day_id):
    coach_required()
    day = g.db.execute("SELECT * FROM plan_days WHERE id = ?", (day_id,)).fetchone()
    if day is None:
        abort(404)
    name = request.form.get("name", "").strip()
    if not name:
        flash("Wpisz nazwę ćwiczenia.")
        return redirect(url_for("plan_detail", micro_id=day["microcycle_id"]))
    record_id = request.form.get("record_id") or None
    try:
        intensity = as_fraction(request.form.get("intensity"))
    except ValueError:
        flash("Intensywność wpisz jako 0,70 albo 70.")
        return redirect(url_for("plan_detail", micro_id=day["microcycle_id"]))
    g.db.execute(
        """
        INSERT INTO plan_exercises
            (plan_day_id, name, complex, kind, sets_text, reps_text, intensity, record_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            day_id,
            name,
            request.form.get("complex") or "C1",
            request.form.get("kind") or "specjalne",
            request.form.get("sets_text") or "1",
            request.form.get("reps_text") or "1",
            intensity,
            int(record_id) if record_id else None,
        ),
    )
    g.db.commit()
    return redirect(url_for("plan_detail", micro_id=day["microcycle_id"]))


@app.route("/plan/cwiczenie/<int:exercise_id>/usun", methods=["POST"])
def plan_delete_exercise(exercise_id):
    coach_required()
    row = g.db.execute(
        """
        SELECT e.id, d.microcycle_id
        FROM plan_exercises e
        JOIN plan_days d ON d.id = e.plan_day_id
        WHERE e.id = ?
        """,
        (exercise_id,),
    ).fetchone()
    if row is None:
        abort(404)
    g.db.execute("DELETE FROM plan_exercises WHERE id = ?", (exercise_id,))
    g.db.commit()
    return redirect(url_for("plan_detail", micro_id=row["microcycle_id"]))


@app.route("/plan/<int:micro_id>/druk")
def plan_print(micro_id):
    login_required()
    micro, days, by_day, _records = load_microcycle(micro_id)
    prepared = []
    for day in days:
        title, _current = day_title(micro["start_date"], day["day_index"])
        items = by_day[day["id"]]
        grouped = {kind: [] for kind in KINDS}
        for item in items:
            grouped.setdefault(item["kind"], []).append(item)
        prepared.append({"day": day, "title": title, "grouped": grouped, "summary": summarize_plan(items)})
    return render_template("plan_print.html", micro=micro, days=prepared)


@app.route("/rekordy", methods=["GET", "POST"])
def records():
    user = login_required()
    if request.method == "POST":
        if user["role"] != "coach":
            abort(403)
        action = request.form.get("action")
        if action == "add":
            name = request.form.get("name", "").strip()
            try:
                max_kg = float(request.form.get("max_kg", "").replace(",", "."))
            except ValueError:
                flash("Rekord wpisz w kilogramach.")
                return redirect(url_for("records"))
            if name:
                g.db.execute("INSERT INTO records (name, max_kg) VALUES (?, ?)", (name, max_kg))
        elif action == "save":
            g.db.execute(
                "UPDATE records SET name = ?, max_kg = ? WHERE id = ?",
                (
                    request.form.get("name", "").strip(),
                    float(request.form.get("max_kg", "0").replace(",", ".")),
                    int(request.form["record_id"]),
                ),
            )
        elif action == "delete":
            g.db.execute("DELETE FROM records WHERE id = ?", (int(request.form["record_id"]),))
        g.db.commit()
        return redirect(url_for("records"))
    rows = g.db.execute("SELECT * FROM records ORDER BY name").fetchall()
    return render_template("records.html", records=rows)


def session_bundle(row):
    diary = g.db.execute(
        "SELECT * FROM diary_rows WHERE session_id = ? ORDER BY exercise_no, id",
        (row["id"],),
    ).fetchall()
    summary = summarize_session(diary, row["time_s"], row["rpe_s"], row["time_w"], row["rpe_w"])
    summary["week"] = week_number(row["session_date"])
    return diary, summary


@app.route("/dziennik")
def diary_list():
    login_required()
    rows = g.db.execute("SELECT * FROM sessions ORDER BY session_date, id").fetchall()
    prepared = []
    for row in rows:
        _diary, summary = session_bundle(row)
        prepared.append({"session": row, "summary": summary})
    return render_template("diary_list.html", sessions=prepared)


@app.route("/dziennik/nowy", methods=["POST"])
def diary_new():
    user = login_required()
    if user["role"] != "athlete":
        abort(403)
    session_date = request.form["session_date"]
    try:
        date.fromisoformat(session_date)
    except ValueError:
        flash("Data jednostki jest niepoprawna.")
        return redirect(url_for("diary_list"))
    g.db.execute(
        """
        INSERT INTO sessions
            (session_date, period_no, micro_no, session_in_micro, session_type,
             time_s, rpe_s, time_w, rpe_w)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            session_date,
            int(request.form.get("period_no") or 1),
            int(request.form.get("micro_no") or 1),
            int(request.form.get("session_in_micro") or 1),
            request.form.get("session_type") or "PC",
            _float_field("time_s"),
            _float_field("rpe_s"),
            _float_field("time_w"),
            _float_field("rpe_w"),
        ),
    )
    g.db.commit()
    new_id = g.db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    return redirect(url_for("diary_detail", session_id=new_id))


def _float_field(name):
    raw = request.form.get(name, "").strip().replace(",", ".")
    if raw == "":
        return 0.0
    try:
        return float(raw)
    except ValueError:
        return 0.0


@app.route("/dziennik/<int:session_id>", methods=["GET", "POST"])
def diary_detail(session_id):
    user = login_required()
    row = g.db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        abort(404)
    if request.method == "POST":
        if user["role"] != "athlete":
            abort(403)
        g.db.execute(
            """
            UPDATE sessions
            SET session_date = ?, period_no = ?, micro_no = ?, session_in_micro = ?,
                session_type = ?, time_s = ?, rpe_s = ?, time_w = ?, rpe_w = ?
            WHERE id = ?
            """,
            (
                request.form["session_date"],
                int(request.form.get("period_no") or 1),
                int(request.form.get("micro_no") or 1),
                int(request.form.get("session_in_micro") or 1),
                request.form.get("session_type") or "PC",
                _float_field("time_s"),
                _float_field("rpe_s"),
                _float_field("time_w"),
                _float_field("rpe_w"),
                session_id,
            ),
        )
        g.db.commit()
        return redirect(url_for("diary_detail", session_id=session_id))
    diary, summary = session_bundle(row)
    records = g.db.execute("SELECT * FROM records ORDER BY name").fetchall()
    return render_template(
        "diary_detail.html",
        item=row,
        diary=diary,
        summary=summary,
        records=records,
    )


@app.route("/dziennik/<int:session_id>/wiersz", methods=["POST"])
def diary_add_row(session_id):
    user = login_required()
    if user["role"] != "athlete":
        abort(403)
    name = request.form.get("name", "").strip()
    if not name:
        flash("Wpisz nazwę ćwiczenia.")
        return redirect(url_for("diary_detail", session_id=session_id))
    record_kg = None
    record_name = ""
    record_id = request.form.get("record_id") or ""
    if record_id:
        record = g.db.execute("SELECT * FROM records WHERE id = ?", (int(record_id),)).fetchone()
        if record:
            record_kg = record["max_kg"]
            record_name = record["name"]
    next_no = g.db.execute(
        "SELECT COALESCE(MAX(exercise_no), 0) + 1 AS n FROM diary_rows WHERE session_id = ?",
        (session_id,),
    ).fetchone()["n"]
    try:
        load_kg = float(request.form.get("load_kg", "0").replace(",", "."))
    except ValueError:
        flash("Obciążenie wpisz w kilogramach.")
        return redirect(url_for("diary_detail", session_id=session_id))
    g.db.execute(
        """
        INSERT INTO diary_rows
            (session_id, exercise_no, name, complex, sets_text, reps_text, load_kg, record_kg, record_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            session_id,
            next_no,
            name,
            request.form.get("complex") or "C1",
            request.form.get("sets_text") or "1",
            request.form.get("reps_text") or "1",
            load_kg,
            record_kg,
            record_name,
        ),
    )
    g.db.commit()
    return redirect(url_for("diary_detail", session_id=session_id))


@app.route("/dziennik/wiersz/<int:row_id>/usun", methods=["POST"])
def diary_delete_row(row_id):
    user = login_required()
    if user["role"] != "athlete":
        abort(403)
    row = g.db.execute("SELECT session_id FROM diary_rows WHERE id = ?", (row_id,)).fetchone()
    if row is None:
        abort(404)
    g.db.execute("DELETE FROM diary_rows WHERE id = ?", (row_id,))
    g.db.commit()
    return redirect(url_for("diary_detail", session_id=row["session_id"]))


@app.route("/dziennik/<int:session_id>/usun", methods=["POST"])
def diary_delete(session_id):
    user = login_required()
    if user["role"] != "athlete":
        abort(403)
    g.db.execute("DELETE FROM diary_rows WHERE session_id = ?", (session_id,))
    g.db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    g.db.commit()
    return redirect(url_for("diary_list"))


def collect_analysis():
    session_rows = g.db.execute("SELECT * FROM sessions ORDER BY period_no, micro_no, session_date, id").fetchall()
    summaries = []
    rows_by_key = {}
    for row in session_rows:
        diary, summary = session_bundle(row)
        summary.update(
            {
                "id": row["id"],
                "session_date": row["session_date"],
                "period_no": row["period_no"],
                "micro_no": row["micro_no"],
                "session_type": row["session_type"],
                "session_in_micro": row["session_in_micro"],
            }
        )
        summaries.append(summary)
        key = (row["period_no"], row["micro_no"])
        rows_by_key.setdefault(key, []).extend(diary)
    microcycles = summarize_microcycles(summaries)
    plans = g.db.execute("SELECT * FROM microcycles ORDER BY period_no, micro_no").fetchall()
    plan_by_key = {(plan["period_no"], plan["micro_no"]): plan for plan in plans}
    article = []
    for bucket in microcycles:
        key = (bucket["period_no"], bucket["micro_no"])
        groups, overall, rest = article_by_group(rows_by_key.get(key, []))
        article.append(
            {
                "period_no": bucket["period_no"],
                "micro_no": bucket["micro_no"],
                "groups": groups,
                "overall": overall,
                "rest": rest,
            }
        )
    return summaries, microcycles, plan_by_key, article


def compare_plan(plan, diary_rows_by_date):
    _micro, days, by_day, _records = load_microcycle(plan["id"])
    compared = []
    for day in days:
        _title, current = day_title(plan["start_date"], day["day_index"])
        exercises = []
        for item in by_day[day["id"]]:
            record_kg = item["record_kg"]
            exercises.append({**dict(item), "record_kg": record_kg})
        planned = summarize_plan(exercises)
        realized_rows = diary_rows_by_date.get(current.isoformat(), [])
        realized = summarize_session(realized_rows, 0, 0, 0, 0)
        compared.append(
            {
                "title": _title,
                "load_level": day["load_level"],
                "planned": planned,
                "realized": realized,
                "has_diary": bool(realized_rows),
            }
        )
    return compared


@app.route("/analiza")
def analysis():
    login_required()
    summaries, microcycles, plan_by_key, article = collect_analysis()
    selected = request.args.get("mc")
    keys = [(item["period_no"], item["micro_no"]) for item in microcycles]
    for key in plan_by_key:
        if key not in keys:
            keys.append(key)
    keys.sort()
    if selected and "-" in selected:
        period_text, micro_text = selected.split("-", 1)
        chosen = (int(period_text), int(micro_text))
    elif keys:
        chosen = keys[-1]
    else:
        chosen = None
    comparison = None
    if chosen and chosen in plan_by_key:
        diary_by_date = {}
        for row in g.db.execute(
            "SELECT * FROM sessions WHERE period_no = ? AND micro_no = ?",
            chosen,
        ):
            diary = g.db.execute(
                "SELECT * FROM diary_rows WHERE session_id = ?",
                (row["id"],),
            ).fetchall()
            diary_by_date.setdefault(row["session_date"], []).extend(diary)
        comparison = compare_plan(plan_by_key[chosen], diary_by_date)
    return render_template(
        "analysis.html",
        sessions=summaries,
        microcycles=microcycles,
        article=article,
        keys=keys,
        chosen=chosen,
        comparison=comparison,
        article_groups=ARTICLE_GROUPS,
    )


@app.errorhandler(403)
def forbidden(_exc):
    return render_template("forbidden.html"), 403


if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5055, debug=False)
