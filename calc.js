/* Te same wzory co w arkuszu i w calc.py. */

function parseCount(value) {
  if (value == null) return 0;
  const text = String(value).trim().replace(/,/g, ".").replace(/\s/g, "");
  if (!text) return 0;
  if (text.includes("*")) {
    return text.split("*").reduce((total, part) => total * parseCount(part), 1);
  }
  if (text.includes("+")) {
    return text.split("+").reduce((total, part) => total + parseCount(part), 0);
  }
  const number = Number(text);
  if (Number.isNaN(number)) throw new Error("zła liczba");
  return number;
}

function asFraction(value) {
  if (value == null) return null;
  const text = String(value).trim().replace("%", "").replace(",", ".");
  if (!text) return null;
  let number = Number(text);
  if (Number.isNaN(number)) throw new Error("zła intensywność");
  if (number > 1.5) number /= 100;
  return number;
}

function num(value) {
  if (value == null || value === "") return 0;
  const number = Number(String(value).replace(",", "."));
  return Number.isNaN(number) ? 0 : number;
}

function exerciseLoad(setsText, repsText, loadKg, recordKg) {
  const sets = parseCount(setsText);
  const reps = parseCount(repsText);
  const volume = sets * reps;
  const kilograms = num(loadKg);
  const record = num(recordKg);
  return {
    sets,
    volume,
    tonnage: volume * kilograms,
    intensity: record > 0 && volume > 0 ? kilograms / record : null,
  };
}

function summarizeRows(rows) {
  let sets = 0;
  let volume = 0;
  let tonnage = 0;
  let intensityNum = 0;
  let intensityDen = 0;
  rows.forEach((row) => {
    const item = exerciseLoad(row.sets_text, row.reps_text, row.load_kg, row.record_kg);
    sets += item.sets;
    volume += item.volume;
    tonnage += item.tonnage;
    if (item.intensity != null) {
      intensityNum += item.volume * item.intensity;
      intensityDen += item.volume;
    }
  });
  return {
    sets,
    volume,
    tonnage,
    avg_load: volume ? tonnage / volume : null,
    avg_intensity: intensityDen ? intensityNum / intensityDen : null,
  };
}

function summarizeSession(rows, timeS, rpeS, timeW, rpeW) {
  const base = summarizeRows(rows);
  timeS = num(timeS);
  rpeS = num(rpeS);
  timeW = num(timeW);
  rpeW = num(rpeW);
  const rpeLoadS = timeS * rpeS;
  const rpeLoadW = timeW * rpeW;
  base.time_s = timeS;
  base.rpe_s = rpeS;
  base.rpe_load_s = rpeLoadS;
  base.time_w = timeW;
  base.rpe_w = rpeW;
  base.rpe_load_w = rpeLoadW;
  base.srpe_load = rpeLoadS + rpeLoadW;
  base.time_sum = timeS + timeW;
  base.internal_external = base.tonnage ? rpeLoadS / base.tonnage : null;
  return base;
}

function summarizeMicrocycles(sessions) {
  const grouped = [];
  const index = new Map();
  sessions.forEach((session) => {
    const key = `${Number(session.period_no)}-${Number(session.micro_no)}`;
    let bucket = index.get(key);
    if (!bucket) {
      bucket = {
        period_no: Number(session.period_no),
        micro_no: Number(session.micro_no),
        sessions: 0,
        pc: 0,
        sil: 0,
        inne: 0,
        sets: 0,
        volume: 0,
        tonnage: 0,
        time_s: 0,
        rpe_s: 0,
        rpe_load_s: 0,
        time_w: 0,
        rpe_w: 0,
        rpe_load_w: 0,
      };
      index.set(key, bucket);
      grouped.push(bucket);
    }
    bucket.sessions += 1;
    const kind = session.session_type || "INNE";
    if (kind === "PC") bucket.pc += 1;
    else if (kind === "SIL") bucket.sil += 1;
    else bucket.inne += 1;
    ["sets", "volume", "tonnage", "time_s", "rpe_s", "rpe_load_s", "time_w", "rpe_w", "rpe_load_w"].forEach((field) => {
      bucket[field] += session[field] || 0;
    });
  });
  grouped.forEach((bucket, position) => {
    const lifting = bucket.pc + bucket.sil;
    const totalTime = bucket.time_s + bucket.time_w;
    bucket.avg_tonnage_session = lifting ? bucket.tonnage / lifting : null;
    bucket.avg_load = bucket.volume ? bucket.tonnage / bucket.volume : null;
    bucket.time_sum = totalTime;
    bucket.srpe_load = bucket.rpe_load_s + bucket.rpe_load_w;
    bucket.share_time_w = totalTime ? bucket.time_w / totalTime : null;
    bucket.internal_external = bucket.tonnage ? bucket.rpe_load_s / bucket.tonnage : null;
    bucket.acwr_tonnage = acwr(grouped, position, "tonnage");
    bucket.acwr_rpe = acwr(grouped, position, "rpe_load_s");
  });
  return grouped;
}

function acwr(grouped, position, field) {
  if (position < 4) return null;
  const window = grouped.slice(position - 4, position).map((item) => item[field]);
  const baseline = window.reduce((sum, value) => sum + value, 0) / 4;
  if (!baseline) return null;
  return grouped[position][field] / baseline;
}

const ARTICLE_GROUPS = [
  ["C1-2", "C1–2 szybkość i technika", ["C1", "C2"]],
  ["C3", "C3 moc", ["C3"]],
  ["C4-5", "C4–5 siła maksymalna", ["C4", "C5"]],
];

function articleByGroup(rows) {
  const codes = {};
  ARTICLE_GROUPS.forEach(([key, , groupCodes]) => {
    groupCodes.forEach((code) => {
      codes[code] = key;
    });
  });
  const buckets = {};
  ARTICLE_GROUPS.forEach(([key]) => {
    buckets[key] = [];
  });
  const other = [];
  rows.forEach((row) => {
    const key = codes[row.complex];
    if (key) buckets[key].push(row);
    else other.push(row);
  });
  const groups = ARTICLE_GROUPS.map(([key, label]) => ({ ...summarizeRows(buckets[key]), key, label }));
  const overall = { ...summarizeRows(ARTICLE_GROUPS.flatMap(([key]) => buckets[key])), key: "C1-5", label: "C1–5 łącznie" };
  const rest = { ...summarizeRows(other), key: "inne", label: "poza C1–5" };
  return { groups, overall, rest };
}

function monotony(values) {
  const numbers = values.filter((value) => Number.isFinite(value) && value > 0);
  if (numbers.length < 2) return null;
  const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  const variance = numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (numbers.length - 1);
  const spread = Math.sqrt(variance);
  if (!spread) return mean > 0 ? 99 : null;
  return mean / spread;
}

function relativeChange(current, previous) {
  if (current == null || previous == null || !previous) return null;
  return current / previous - 1;
}

const SINCLAIR = {
  M: { a: 0.70076782, b: 201.159 },
  K: { a: 0.674107991, b: 163.918 },
};

function sinclairTotal(total, bodyKg, sex) {
  const coef = SINCLAIR[sex];
  const lifted = num(total);
  const body = num(bodyKg);
  if (!coef || !(lifted > 0) || !(body > 0)) return null;
  if (body >= coef.b) return lifted;
  const log = Math.log10(body / coef.b);
  return lifted * 10 ** (coef.a * log * log);
}

function qPoints(total, bodyKg) {
  const lifted = num(total);
  const body = num(bodyKg);
  if (!(lifted > 0) || !(body > 0)) return null;
  const scaled = body / 100;
  const denominator = 266.5 - 19.44 * scaled ** -2 + 18.61 * scaled ** 2;
  if (!denominator) return null;
  return lifted * (306.54 / denominator);
}

const TEI_LIFTS = [
  ["BS", "przysiad tył", "BS", 1, 0],
  ["FS", "przysiad przód", "FS", 0.87, 0.03],
  ["SN", "rwanie", "SN", 0.62, 0.02],
  ["PSN", "rwanie siłowe", "PSN", 0.527, 0.02],
  ["CnJ", "dwubój", "CnJ", 0.8, 0.03],
  ["C", "zarzut", "C", 0.8, 0.03],
  ["J", "podrzut", "J", 0.8, 0.03],
  ["PC", "zarzut siłowy", "PC", 0.68, 0.03],
];

function teiProfile(values) {
  const source = values || {};
  const squat = num(source.BS);
  const rows = TEI_LIFTS.map(([key, label, short, ref, tolerance]) => {
    const kg = num(source[key]);
    return {
      key,
      label,
      short,
      ref,
      tolerance,
      kg,
      actual: squat > 0 && kg > 0 ? kg / squat : null,
    };
  }).filter((row) => row.kg > 0);
  return { squat, rows };
}

function summarizePlan(exercises) {
  let sets = 0;
  let volume = 0;
  let intensityNum = 0;
  let intensityDen = 0;
  let tonnage = 0;
  exercises.forEach((row) => {
    const countSets = parseCount(row.sets_text);
    const countReps = parseCount(row.reps_text);
    const block = countSets * countReps;
    sets += countSets;
    volume += block;
    if (row.intensity != null && block) {
      intensityNum += block * row.intensity;
      intensityDen += block;
      const record = num(row.record_kg);
      if (record > 0) tonnage += block * row.intensity * record;
    }
  });
  return {
    sets,
    volume,
    avg_intensity: intensityDen ? intensityNum / intensityDen : null,
    tonnage: tonnage || null,
  };
}

if (typeof window === "undefined") {
  const rows = [
    { sets_text: "4", reps_text: "1+1+1", load_kg: 40, record_kg: 95, complex: "C1" },
    { sets_text: "1", reps_text: "1+1+1+1", load_kg: 48, record_kg: 95, complex: "C1" },
  ];
  const session = summarizeSession(rows, 50, 5, 20, 5);
  if (session.volume !== 16 || session.tonnage !== 672 || session.rpe_load_s !== 250) {
    throw new Error("calc mismatch");
  }
  const sessions = [100, 200, 300, 400, 250].map((tonnage, index) => ({
    period_no: 1,
    micro_no: index + 1,
    session_type: "PC",
    sets: 1,
    volume: 10,
    tonnage,
    time_s: 10,
    rpe_s: 5,
    rpe_load_s: 50,
    time_w: 0,
    rpe_w: 0,
    rpe_load_w: 0,
  }));
  const micros = summarizeMicrocycles(sessions);
  const expected = 250 / ((100 + 200 + 300 + 400) / 4);
  if (Math.abs(micros[4].acwr_tonnage - expected) > 1e-9) throw new Error("acwr mismatch");
  const even = monotony([10, 10, 10, 10]);
  const uneven = monotony([2, 2, 2, 20]);
  if (!(even > uneven)) throw new Error("monotony mismatch");
  const sinclair = sinclairTotal(200, 60, "K");
  if (!(sinclair > 200)) throw new Error("sinclair mismatch");
  const points = qPoints(205, 60);
  if (!(points > 205)) throw new Error("q-points mismatch");
  const profile = teiProfile({ BS: 155, SN: 95 });
  if (Math.abs(profile.rows.find((row) => row.key === "SN").actual - 95 / 155) > 1e-9) {
    throw new Error("tei mismatch");
  }
  console.log("calc ok");
}
