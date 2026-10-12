"""Wskaźniki z dziennika treningowego i z artykułu Sandau i Granacher (2022).

Objętość = serie × podniesienia.
Tonaż (volume load) = serie × podniesienia × kg.
Średnie obciążenie (average load) = tonaż / objętość.
Intensywność = kg / rekord ćwiczenia bazowego.
RPE-load = czas części (min) × RPE.
ACWR = wartość mikrocyklu / średnia z 4 poprzednich mikrocykli.
"""

COMPLEX_LABELS = {
    "C1": "C1 rwaniowe",
    "C2": "C2 podrzutowe",
    "C3": "C3 ciągi",
    "C4": "C4 przysiady",
    "C5": "C5 martwe ciągi",
    "C6": "C6 wyciskania",
    "C7": "C7 siłowe z oporem",
    "C8": "C8 masa własna",
    "C9": "C9 moc (skoki, rzuty)",
    "C10": "C10 rozciąganie",
    "C11": "C11 inne",
}

ARTICLE_GROUPS = (
    ("C1-2", "C1–2 szybkość i technika", ("C1", "C2")),
    ("C3", "C3 moc", ("C3",)),
    ("C4-5", "C4–5 siła maksymalna", ("C4", "C5")),
)


def field(row, key, default=None):
    try:
        value = row[key]
    except (KeyError, IndexError, TypeError):
        return default
    return default if value is None else value


def parse_count(value):
    """Zamienia '2+2', '3*6' albo '10' na liczbę podniesień lub serii."""
    if value is None:
        return 0.0
    text = str(value).strip().replace(",", ".").replace(" ", "")
    if text == "":
        return 0.0
    if "*" in text:
        total = 1.0
        for part in text.split("*"):
            total *= parse_count(part)
        return total
    if "+" in text:
        return sum(parse_count(part) for part in text.split("+"))
    return float(text)


def as_fraction(value):
    """70, 70% i 0,70 oznaczają tę samą intensywność."""
    if value is None:
        return None
    text = str(value).strip().replace("%", "").replace(",", ".")
    if text == "":
        return None
    number = float(text)
    if number > 1.5:
        number = number / 100.0
    return number


def _num(value):
    if value is None or value == "":
        return 0.0
    return float(str(value).replace(",", "."))


def exercise_load(sets_text, reps_text, load_kg, record_kg=None):
    sets = parse_count(sets_text)
    reps = parse_count(reps_text)
    volume = sets * reps
    kilograms = _num(load_kg)
    tonnage = volume * kilograms
    intensity = None
    record = _num(record_kg)
    if record > 0 and volume > 0:
        intensity = kilograms / record
    return {
        "sets": sets,
        "reps_each": reps,
        "volume": volume,
        "tonnage": tonnage,
        "intensity": intensity,
    }


def summarize_rows(rows):
    """rows: sets_text, reps_text, load_kg, record_kg, complex."""
    sets = 0.0
    volume = 0.0
    tonnage = 0.0
    intensity_num = 0.0
    intensity_den = 0.0
    for row in rows:
        item = exercise_load(
            field(row, "sets_text"),
            field(row, "reps_text"),
            field(row, "load_kg"),
            field(row, "record_kg"),
        )
        sets += item["sets"]
        volume += item["volume"]
        tonnage += item["tonnage"]
        if item["intensity"] is not None:
            intensity_num += item["volume"] * item["intensity"]
            intensity_den += item["volume"]
    return {
        "sets": sets,
        "volume": volume,
        "tonnage": tonnage,
        "avg_load": (tonnage / volume) if volume else None,
        "avg_intensity": (intensity_num / intensity_den) if intensity_den else None,
    }


def summarize_session(rows, time_s, rpe_s, time_w, rpe_w):
    base = summarize_rows(rows)
    time_s = _num(time_s)
    rpe_s = _num(rpe_s)
    time_w = _num(time_w)
    rpe_w = _num(rpe_w)
    rpe_load_s = time_s * rpe_s
    rpe_load_w = time_w * rpe_w
    tonnage = base["tonnage"]
    base.update(
        {
            "time_s": time_s,
            "rpe_s": rpe_s,
            "rpe_load_s": rpe_load_s,
            "time_w": time_w,
            "rpe_w": rpe_w,
            "rpe_load_w": rpe_load_w,
            "srpe_load": rpe_load_s + rpe_load_w,
            "time_sum": time_s + time_w,
            "internal_external": (rpe_load_s / tonnage) if tonnage else None,
        }
    )
    return base


def summarize_microcycles(sessions):
    """sessions posortowane rosnąco: period_no, micro_no, plus pola ze summarize_session i session_type."""
    grouped = []
    index = {}
    for session in sessions:
        key = (int(session["period_no"]), int(session["micro_no"]))
        if key not in index:
            bucket = {
                "period_no": key[0],
                "micro_no": key[1],
                "sessions": 0,
                "pc": 0,
                "sil": 0,
                "inne": 0,
                "sets": 0.0,
                "volume": 0.0,
                "tonnage": 0.0,
                "time_s": 0.0,
                "rpe_s": 0.0,
                "rpe_load_s": 0.0,
                "time_w": 0.0,
                "rpe_w": 0.0,
                "rpe_load_w": 0.0,
            }
            index[key] = bucket
            grouped.append(bucket)
        bucket = index[key]
        bucket["sessions"] += 1
        kind = session.get("session_type") or "INNE"
        if kind == "PC":
            bucket["pc"] += 1
        elif kind == "SIL":
            bucket["sil"] += 1
        else:
            bucket["inne"] += 1
        for field in (
            "sets",
            "volume",
            "tonnage",
            "time_s",
            "rpe_s",
            "rpe_load_s",
            "time_w",
            "rpe_w",
            "rpe_load_w",
        ):
            bucket[field] += session.get(field) or 0.0

    for position, bucket in enumerate(grouped):
        lifting = bucket["pc"] + bucket["sil"]
        bucket["avg_tonnage_session"] = (bucket["tonnage"] / lifting) if lifting else None
        bucket["avg_load"] = (bucket["tonnage"] / bucket["volume"]) if bucket["volume"] else None
        total_time = bucket["time_s"] + bucket["time_w"]
        bucket["time_sum"] = total_time
        bucket["srpe_load"] = bucket["rpe_load_s"] + bucket["rpe_load_w"]
        bucket["share_time_w"] = (bucket["time_w"] / total_time) if total_time else None
        bucket["internal_external"] = (
            bucket["rpe_load_s"] / bucket["tonnage"] if bucket["tonnage"] else None
        )
        bucket["acwr_tonnage"] = _acwr(grouped, position, "tonnage")
        bucket["acwr_rpe"] = _acwr(grouped, position, "rpe_load_s")
    return grouped


def _acwr(grouped, position, field):
    if position < 4:
        return None
    window = [grouped[i][field] for i in range(position - 4, position)]
    baseline = sum(window) / 4.0
    if baseline == 0:
        return None
    return grouped[position][field] / baseline


def article_by_group(rows):
    """Objętość, tonaż i średnie obciążenie w kompleksach z artykułu."""
    buckets = {key: [] for key, _label, _codes in ARTICLE_GROUPS}
    other = []
    codes = {code: key for key, _label, group_codes in ARTICLE_GROUPS for code in group_codes}
    for row in rows:
        key = codes.get(field(row, "complex"))
        if key is None:
            other.append(row)
        else:
            buckets[key].append(row)
    result = []
    combined = []
    for key, label, _codes in ARTICLE_GROUPS:
        summary = summarize_rows(buckets[key])
        summary["key"] = key
        summary["label"] = label
        result.append(summary)
        combined.extend(buckets[key])
    overall = summarize_rows(combined)
    overall["key"] = "C1-5"
    overall["label"] = "C1–5 łącznie (kończyny dolne)"
    rest = summarize_rows(other)
    rest["key"] = "inne"
    rest["label"] = "poza C1–5 (m.in. wyciskania, rozciąganie)"
    return result, overall, rest


def summarize_plan(exercises):
    """Plan trenera: intensywność jest już ułamkiem, nie kilogramami."""
    sets = 0.0
    volume = 0.0
    intensity_num = 0.0
    intensity_den = 0.0
    tonnage = 0.0
    for row in exercises:
        count_sets = parse_count(field(row, "sets_text"))
        count_reps = parse_count(field(row, "reps_text"))
        block = count_sets * count_reps
        sets += count_sets
        volume += block
        intensity = field(row, "intensity")
        if intensity is not None and block:
            intensity_num += block * intensity
            intensity_den += block
            record = _num(field(row, "record_kg"))
            if record > 0:
                tonnage += block * intensity * record
    return {
        "sets": sets,
        "volume": volume,
        "avg_intensity": (intensity_num / intensity_den) if intensity_den else None,
        "tonnage": tonnage if tonnage else None,
    }
