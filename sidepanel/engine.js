// engine.js
function isGarbageName(name) {
    return ['Name', 'Имя', 'Название', '<Имя>', '...', '(.+?)'].includes(name);
}

// Нормализация имени для надежного сравнения (ё/е, регистр, пробелы, эмодзи) —
// ИИ любит писать "Тёплый плащ" вместо "Теплый плащ", а эмодзи в [iu:] может
// отличаться от эмодзи в [i:] (🕯️ с/без вариационного селектора и т.п.)
function normName(s) {
    return String(s)
        // эмодзи, вариационные селекторы, ZWJ, кейкапы, региональные индикаторы
        .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|[\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu, '')
        .toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ')
        .replace(/^[\s:;,.\-–—]+|[\s:;,.\-–—]+$/g, '') // хвостовые "Револьвер:" / "— Плащ"
        .trim();
}

// Грубая нормализация: только буквы и цифры (второй шанс поиска, если строгий
// не совпал — "Револьвер-7" vs "Револьвер 7", лишние дефисы/скобки ИИ)
function looseName(s) {
    return normName(s).replace(/[^\p{L}\p{N}]+/gu, '');
}

// ============================================================
// v4.1: КАЛЕНДАРИ МИРА ([cal:]), ТАБЛИЦЫ МЕСЯЦЕВ И РАЗБИВКИ СЧЕТЧИКОВ
// ============================================================

// Пресеты календарей. Скайрим: дни недели и 12 месяцев по русской локализации
// (длины месяцев унифицированы: 30 дней; свою таблицу длин ИИ может задать тегом).
// ИИ может и не знать их наизусть — достаточно прислать [cal: Скайрим].
const CALENDAR_PRESETS = {
    'скайрим': {
        name: 'Скайрим',
        weekdays: ['Морндас', 'Тирдас', 'Миддас', 'Турдас', 'Фредас', 'Лоредас', 'Сондас'],
        months: [
            { name: 'Утренняя Звезда', days: 30 }, { name: 'Восход Солнца', days: 30 },
            { name: 'Первое Зерно', days: 30 }, { name: 'Длань Дождя', days: 30 },
            { name: 'Второе Зерно', days: 30 }, { name: 'Середина Года', days: 30 },
            { name: 'Высота Солнца', days: 30 }, { name: 'Последнее Зерно', days: 30 },
            { name: 'Очаг', days: 30 }, { name: 'Мороз', days: 30 },
            { name: 'Закат Солнца', days: 30 }, { name: 'Вечерняя Звезда', days: 30 }
        ]
    }
};

// Активные дни недели мира: календарь мира или стандарт Пн–Вс
function calendarWeekdays() {
    const cal = gameState.time && gameState.time.calendar;
    return (cal && Array.isArray(cal.weekdays) && cal.weekdays.length >= 2) ? cal.weekdays : null;
}
function calendarMonths() {
    const cal = gameState.time && gameState.time.calendar;
    return (cal && Array.isArray(cal.months) && cal.months.length >= 2 &&
            cal.months.every(m => m && m.name)) ? cal.months : null;
}

// v4.1 ТАБЛИЦА МЕСЯЦЕВ: ИИ прописывает месяцы с их длиной в днях. Формат
// элемента: "Имя:Дни" ("Урожая:31"), "Имя/Дни" ("месяца закона/28"),
// "Имя — Дни" ("Месяц любви - 14"); голое число — БЕЗЫМЯННЫЙ месяц по порядку
// ("31, 28" → "1-й месяц", "2-й месяц"); голое имя — месяц по умолчанию 30 дней.
// Разделитель элементов: sep (',' в [cal:], '|' в [c: ..., Календарь: ...]).
function parseMonthEntry(entry, index) {
    const e = String(entry).trim();
    if (!e) return null;
    if (/^\d{1,3}$/.test(e)) return { name: `${index + 1}-й месяц`, days: parseInt(e) };
    const m = e.match(/^(.+?)\s*[:\/—–-]\s*(\d{1,3})$/);
    if (m) return { name: m[1].trim(), days: Math.max(1, parseInt(m[2])) };
    return { name: e, days: 30 };
}
function parseMonthList(spec, sepRe) {
    return String(spec).split(sepRe)
        .map((entry, i) => parseMonthEntry(entry, i))
        .filter(m => m && m.name);
}

// v4.1 УМНАЯ РАЗБИВКА ФЭНТЕЗИЙНОЙ ДАТЫ: в строке даты находится ЧИСЛО ДНЯ и
// увеличивается только оно, весь остальной текст сохраняется
// ("3-й день Эры Тьмы" → "5-й день Эры Тьмы", "Мороз 4, 4Э 201" → "Мороз 6, 4Э 201").
// Если в дате есть название месяца календаря — днем считается число рядом с ним
// (а не год "4Э 201"); при переполнении месяц переводится на следующий УЧИТЫВАЯ
// ДЛИНУ месяца из таблицы (у "Месяца закона/28" следующий наступит после 28-го).
function advanceFantasyDate(str, addDays) {
    const months = calendarMonths();
    // Свернутая копия ТОЙ ЖЕ длины (регистр/ё) — спаны совпадают с оригиналом
    const folded = String(str).toLowerCase().replace(/ё/g, 'е');
    // Вариант без дефисов той же длины ("3-й месяц" vs "3 месяц")
    const foldedSoft = folded.replace(/[-–—]/g, ' ');
    const nums = [...folded.matchAll(/\d+/g)];
    if (!nums.length) return null;

    let daySpan = null, monthIdx = -1, monthSpan = null;
    if (months) {
        let bestDist = Infinity;
        months.forEach((mn, mi) => {
            const fn = normName(mn.name);
            if (!fn) return;
            let at = folded.indexOf(fn);
            let src = folded;
            if (at === -1) { at = foldedSoft.indexOf(fn.replace(/[-–—]/g, ' ')); src = foldedSoft; }
            if (at === -1) return;
            // месяц заменяем ЦЕЛИКОМ словом (может быть в склонении: "Мороза")
            let ms = at, me = at + fn.length;
            while (ms > 0 && /\p{L}/u.test(src[ms - 1])) ms--;
            while (me < src.length && /\p{L}/u.test(src[me])) me++;
            nums.forEach(n => {
                const dist = Math.abs((n.index + n[0].length / 2) - (at + fn.length / 2));
                if (dist < bestDist) { bestDist = dist; daySpan = n; monthIdx = mi; monthSpan = [ms, me]; }
            });
        });
    }
    if (!daySpan) {
        // Без месяцев: день = НАИМЕНЬШЕЕ число строки (годы "4Э 201" большие,
        // дни малые; у "3-й день Эры Тьмы" число одно)
        daySpan = nums.reduce((best, n) => (parseInt(n[0]) < parseInt(best[0]) ? n : best), nums[0]);
    }
    let day = parseInt(daySpan[0]) + addDays;
    let monthChanged = false;
    if (monthIdx !== -1) {
        // Переполнение → следующий месяц по кругу, с учетом ДЛИНЫ каждого месяца
        let guard = 0;
        while (day > (Number(months[monthIdx].days) || 30) && guard++ < 10000) {
            day -= Number(months[monthIdx].days) || 30;
            monthIdx = (monthIdx + 1) % months.length;
            monthChanged = true;
        }
        if (day < 1) day = 1;
    }
    // Замены с КОНЦА строки (по убыванию позиции), чтобы спаны не съезжали:
    // месяц может стать длиннее ("Мороз" → "Закат Солнца") и сдвинуть число
    let out = str;
    const edits = [];
    if (monthChanged && monthSpan) edits.push({ s: monthSpan[0], e: monthSpan[1], t: months[monthIdx].name });
    edits.push({ s: daySpan.index, e: daySpan.index + daySpan[0].length, t: String(day) });
    edits.sort((a, b) => b.s - a.s);
    edits.forEach(x => { out = out.slice(0, x.s) + x.t + out.slice(x.e); });
    return out;
}

// v4.1 ТАБЛИЦА РАЗБИВОК: значение счетчика (в базовых единицах) показывается
// в мировых единицах по порогам. Порог юнита = сколько БАЗОВЫХ единиц в одном
// таком юните; цепочка слева направо ([c: Время, ..., Разбивка: Час:60|Сутки:24]
// — 60 минут = 1 Час, 24 часа = 1 Сутки). Юнит может РАСТИ: "Уровень:100+50" —
// каждый следующий дороже на 50 (100, 150, 200...), "Уровень:100×2" — в 2 раза
// (100, 200, 400...). Значит "каждый новый уровень требует больше опыта".
function tierCum(tier, n) {
    // суммарная цена n юнитов (n ≥ 0), в базовых единицах
    if (n <= 0) return 0;
    if (tier.mult > 1) return tier.base * (Math.pow(tier.mult, n) - 1) / (tier.mult - 1);
    if (tier.step > 0) return n * tier.base + tier.step * n * (n - 1) / 2;
    return n * tier.base;
}
function tierTake(tier, rest) {
    // сколько ЦЕЛЫХ юнитов входит в rest и сколько базовых единиц они съедают
    let n;
    if (tier.mult > 1) n = Math.floor(Math.log(1 + rest * (tier.mult - 1) / tier.base) / Math.log(tier.mult));
    else if (tier.step > 0) {
        const B = 2 * tier.base - tier.step;
        n = Math.floor((-B + Math.sqrt(B * B + 8 * tier.step * rest)) / (2 * tier.step));
    } else n = Math.floor(rest / tier.base);
    if (!isFinite(n)) n = 0;
    n = Math.max(0, Math.floor(n));
    // нормализация погрешности log/pow на точных границах
    let guard = 0;
    while (tierCum(tier, n) > rest && n > 0 && guard++ < 64) n--;
    while (tierCum(tier, n + 1) <= rest && guard++ < 64) n++;
    return [n, tierCum(tier, n)];
}
function breakdownText(raw, bd) {
    raw = Number(raw);
    if (!Array.isArray(bd) || !bd.length || !isFinite(raw)) return String(raw);
    let rest = Math.max(0, Math.floor(raw));
    const parts = [];
    // от старшего юнита к младшему; юнит i стоит произведение порогов 0..i
    for (let i = bd.length - 1; i >= 0; i--) {
        let base = Number(bd[i].per);
        for (let j = 0; j < i; j++) base *= Number(bd[j].per) || 1;
        const tier = { base: base, step: Number(bd[i].step) || 0, mult: Number(bd[i].mult) || 1 };
        const take = tierTake(tier, rest);
        if (take[0] > 0) parts.push(`${take[0]} ${bd[i].name}`);
        rest -= take[1];
    }
    if (rest > 0 || parts.length === 0) parts.push(String(rest));
    return parts.join(' ');
}

// v4.1 СЧЕТЧИК-ДАТА ([c: Дата, N, Календарь: Месяц:31|...]): значение — сколько
// ДНЕЙ прошло с начала годового цикла. Таблица месяцев последовательная (не
// цепочка!): каждый месяц занимает свою длину, после последнего цикл начинается
// заново ("Год 2"). Голые числа в таблице → месяцы по порядку ("1-й месяц").
function dateCounterText(raw, months) {
    raw = Number(raw);
    if (!Array.isArray(months) || !months.length || !isFinite(raw)) return String(raw);
    const v0 = Math.max(0, Math.floor(raw));
    const total = months.reduce((s, m) => s + (Number(m.days) || 30), 0);
    if (total < 1) return String(raw);
    let v = v0 % total;
    const year = Math.floor(v0 / total);
    for (const m of months) {
        const d = Number(m.days) || 30;
        if (v < d) return `${year > 0 ? 'Год ' + year + ', ' : ''}${m.name} ${v + 1}`;
        v -= d;
    }
    return String(raw);
}

// ============================================================
// v3.9: STATEFUL ITEMS, ТАЙМЕРЫ, ЗАПРОСЫ СОСТОЯНИЯ
// ============================================================

// Игровое время в абсолютных минутах (сравнение таймеров, независимо от тайзоны)
function gameTimeMinutes(t) {
    t = t || {};
    const hm = String(t.time || '12:00').split(':');
    const h = parseInt(hm[0]) || 0, m = parseInt(hm[1]) || 0;
    const p = String(t.date || '01.01.2026').split('.');
    const d = parseInt(p[0]) || 1, mo = parseInt(p[1]) || 1, y = parseInt(p[2]) || 2026;
    return Date.UTC(y, mo - 1, d) / 60000 + h * 60 + m;
}

// Красивое обратное преобразование (для отчета, когда сработает таймер)
function minutesToGameTime(min) {
    const d = new Date(min * 60000);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}, ${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

// Цель таймера → абсолютные минуты: "+2d"/"+5h"/"+1h30m"/"25.11.2026 14:00"/"14:00"
function parseTimerTarget(raw) {
    const s = String(raw || '').trim();
    const now = gameTimeMinutes(gameState.time);
    let m, mm;
    if (s.startsWith('+')) {
        // Поддержка составных интервалов и русских единиц: 2d, 5h/ч, 30m/м
        let add = 0;
        const re = /(\d+)\s*([dhmчм])/gi;
        while ((mm = re.exec(s))) {
            const u = mm[2].toLowerCase();
            add += parseInt(mm[1]) * ((u === 'd' || u === 'д') ? 1440 : (u === 'h' || u === 'ч') ? 60 : 1);
        }
        return add > 0 ? now + add : null;
    }
    if ((m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/))) {
        let y = parseInt(m[3]);
        if (y < 100) y += 2000;
        return Date.UTC(y, (parseInt(m[2]) || 1) - 1, parseInt(m[1]) || 1) / 60000 +
            (m[4] ? (parseInt(m[4]) || 0) * 60 + (parseInt(m[5]) || 0) : 0);
    }
    if ((m = s.match(/^(\d{1,2}):(\d{2})$/))) {
        let t = now - (now % 1440) + parseInt(m[1]) * 60 + parseInt(m[2]);
        if (t <= now) t += 1440; // «сегодня уже прошло» → завтра в это время
        return t;
    }
    return null;
}

function findItem(name) {
    const target = normName(name);
    const items = Array.isArray(gameState.items) ? gameState.items : [];
    // 1-й шанс: точное совпадение нормализованных имен
    const exact = items.find(i => normName(i.name) === target) || null;
    if (exact) return exact;
    // 2-й шанс (v4.0, ФИКС эмодзи): сравниваем только буквы/цифры —
    // "🕯️ Старый фонарь" и "Старый фонарь" и "Старый-фонарь" совпадут
    const loose = looseName(name);
    return loose ? (items.find(i => looseName(i.name) === loose) || null) : null;
}

// Свойство предмета: "6/6" → {cur:6, max:6}, "50" → {cur:50, max:null}
function parsePropVal(v) {
    if (v === undefined || v === null || String(v).trim() === '') return { cur: 0, max: null };
    const s = String(v).trim();
    const mm = s.match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
    if (mm) return { cur: parseInt(mm[1]), max: parseInt(mm[2]) };
    const n = parseInt(s);
    return isNaN(n) ? { cur: 0, max: null, raw: s } : { cur: n, max: null };
}

function formatPropVal(pv) {
    return pv.max !== null ? `${pv.cur}/${pv.max}` : String(pv.cur);
}

// Правила предметов [ir:]: break (удалить) / spawn: Имя (заменить)
function runItemRules(item, propKey, reportToAI) {
    if (!Array.isArray(gameState.itemRules)) return;
    const cur = parsePropVal(item.props ? item.props[propKey] : undefined).cur;
    for (const rule of [...gameState.itemRules]) {
        if (normName(rule.name) !== normName(item.name) || normName(rule.prop) !== normName(propKey)) continue;
        let met = false;
        if (rule.condOp === '<=') met = cur <= rule.condVal;
        else if (rule.condOp === '>=') met = cur >= rule.condVal;
        else if (rule.condOp === '<') met = cur < rule.condVal;
        else if (rule.condOp === '>') met = cur > rule.condVal;
        else if (rule.condOp === '==') met = cur === rule.condVal;
        if (!met) continue;
        const act = String(rule.action || '').trim();
        const spawn = act.match(/^spawn\s*:\s*(.+)$/i);
        if (/^break$/i.test(act) || spawn) {
            gameState.items = gameState.items.filter(i => i !== item);
            if (spawn) {
                gameState.items.push({ name: spawn[1].trim(), props: {} });
                if (reportToAI) addLog(`# RPG: правило [${item.name}.${propKey} ${rule.condOp}${rule.condVal}] → предмет удален, создан «${spawn[1].trim()}»`);
            } else if (reportToAI) {
                addLog(`# RPG: правило [${item.name}.${propKey} ${rule.condOp}${rule.condVal}] → предмет сломан и удален`);
            }
        } else if (reportToAI) {
            addLog(`# RPG: правило [${item.name}.${propKey} ${rule.condOp}${rule.condVal}] → неизвестное действие "${act}"`);
        }
    }
}

// Проверка отложенных событий: текущее игровое время >= время таймера
let timerChecking = 0;
function checkTimers(report) {
    if (!Array.isArray(gameState.timers) || gameState.timers.length === 0) return;
    if (timerChecking >= 5) return; // защита от каскада «таймер ставит таймер»
    timerChecking++;
    try {
        const now = gameTimeMinutes(gameState.time);
        const due = gameState.timers.filter(t => typeof t.at === 'number' && t.at <= now);
        for (const t of due) {
            // Удаляем ДО исполнения — повторный сдвиг времени не вызовет его снова
            gameState.timers = gameState.timers.filter(x => x !== t);
            if (report) addLog(`# RPG: ⏰ Событие [${t.id}] сработало!`);
            if (t.commands) {
                // Команды таймера пишутся в ОДНОЙ строке через '///' — разделяем
                // их переносами, иначе parseSysBlock съест только первый тег
                // ("[msg: Привет!] /// [i: ...]" → msg схватил бы весь хвост)
                const res = parseSysBlock(String(t.commands).replace(/\s*\/\/\/\s*/g, '\n'));
                applyOps(res.ops, report);
                if (report && res.warnings.length) res.warnings.forEach(w => addLog(`# RPG: ⚠ в таймере [${t.id}]: ${w}`));
            }
        }
    } finally {
        timerChecking--;
    }
    saveState();
    if (typeof updateUI === 'function') updateUI();
}

// Сборка отчета о состоянии для [query: ...]
function buildStateInfo(scope) {
    const sc = normName(scope || 'all');
    const parts = [];
    const wantCounters = sc === 'all' || sc.indexOf('счет') !== -1 || sc.indexOf('counter') !== -1;
    const wantInv = sc === 'all' || sc.indexOf('инвен') !== -1 || sc.indexOf('invent') !== -1;
    if (wantCounters) {
        // v4.1: счетчики с таблицей разбивок — сразу в мировых единицах
        // ("Опыт 510 (5 Уровень 10)")
        const counters = Object.entries(gameState.counters || {})
            .filter(([n]) => !isGarbageName(n))
            .map(([n, d]) => {
                const base = `${n} ${d.current}${d.max ? '/' + d.max : ''}`;
                if (d.months) return `${base} (${dateCounterText(d.current, d.months)})`;
                return d.breakdown ? `${base} (${breakdownText(d.current, d.breakdown)})` : base;
            });
        if (counters.length) parts.push(counters.join(', '));
    }
    if (wantInv) {
        // v4.0: группировка по вкладкам — "[Инвентарь: Меч, Зелье] [Оружие: Револьвер (Патроны: 6/6)]"
        const groups = new Map();
        (Array.isArray(gameState.items) ? gameState.items : []).forEach(i => {
            const keys = Object.keys(i.props || {});
            const tabKey = keys.find(k => normName(k) === 'tab');
            const tab = tabKey ? String(i.props[tabKey]).trim() : 'Разное';
            if (!groups.has(tab)) groups.set(tab, []);
            const props = keys.filter(k => normName(k) !== 'tab').map(k => `${k}: ${i.props[k]}`);
            groups.get(tab).push(props.length ? `${i.name} (${props.join(', ')})` : i.name);
        });
        const invParts = [...groups.entries()].map(([tab, list]) => `[${tab}: ${list.join(', ')}]`);
        parts.push(invParts.length ? invParts.join(' ') : 'Инвентарь: пусто');
    }
    if (sc === 'all') {
        const t = gameState.time || {};
        parts.push(`Время ${t.time || '??'} ${t.date || ''}`.trim());
        const cal = t.calendar;
        if (cal && cal.name) parts.push(`Календарь: ${cal.name}`);
        const timers = (Array.isArray(gameState.timers) ? gameState.timers : []).map(x => x.id).join(', ');
        if (timers) parts.push(`Таймеры: ${timers}`);
        const sts = (Array.isArray(gameState.statuses) ? gameState.statuses : [])
            .map(s => `${s.effect} · ${s.target}${s.value ? ' (' + s.value + ')' : ''}`).join(', ');
        if (sts) parts.push(`Статусы: ${sts}`);
    }
    return parts.join('; ') || 'пусто';
}

function addLog(text) {
    logQueue.push(text);
    // Очередь логов не должна разрастаться бесконечно
    if (logQueue.length > 50) logQueue.shift();
    if (typeof renderLogs === 'function') renderLogs();
    chrome.runtime.sendMessage({ type: "LOG_UPDATE", logs: logQueue });
}

function changeCounter(name, amount, visited, reporter, silent) {
    // reporter: null → ручное изменение (лог [cd:] всегда);
    //           функция → дельта ИИ: лог "# RPG:"-отчета, без [cd:] строк;
    // silent: true → реплей истории, без любых логов.
    // v4.0: имя счетчика ищем устойчиво (эмодзи/регистр/ё в [cd:] не должны
    // ронять поиск точного ключа словаря)
    let key = null;
    if (!isGarbageName(name) && gameState.counters[name]) key = name;
    else {
        const target = normName(name);
        key = Object.keys(gameState.counters).find(k => !isGarbageName(k) && normName(k) === target) || null;
    }
    if (!key || isNaN(amount)) {
        if (reporter) reporter('игнор: счетчик не существует');
        return;
    }
    // v4.0: счетчики типа time хранят строку ('14:30') — арифметика их портит
    if (typeof gameState.counters[key].current !== 'number' || isNaN(gameState.counters[key].current)) {
        if (reporter) reporter('игнор: нечисловой счетчик (строка времени/текста)');
        return;
    }
    // Защита от зацикливания правил ([r: A, ..., B] + [r: B, ..., A])
    visited = visited || new Set();
    if (visited.has(key)) {
        if (reporter) reporter('остановлено: цикл правил');
        return;
    }
    visited.add(key);
    const oldVal = gameState.counters[key].current;
    gameState.counters[key].current += amount;

    if (gameState.counters[key].current < 0) gameState.counters[key].current = 0;
    if (gameState.counters[key].max && gameState.counters[key].current > gameState.counters[key].max) {
        gameState.counters[key].current = gameState.counters[key].max;
    }

    const actualDelta = gameState.counters[key].current - oldVal;
    if (actualDelta === 0) {
        if (reporter) reporter('без изменений (значение на границе 0/max)');
        return;
    }

    if (reporter) {
        const cur = gameState.counters[key].current;
        // v4.1: у счетчика с таблицей разбивок отчет сразу в мировых единицах —
        // "применено: 90 → 110 (1 Уровень 10)". Левелап по порогам происходит
        // сам, чистой арифметикой: рост дельты переходит через растущий порог.
        // Счетчик-дата показывает месяц цикла: "применено: 44 → 45 (месяца закона 15)".
        const cData = gameState.counters[key];
        const suffix = (Array.isArray(cData.months) && cData.months.length)
            ? ` (${dateCounterText(cur, cData.months)})`
            : (cData.breakdown ? ` (${breakdownText(cur, cData.breakdown)})` : '');
        if (actualDelta !== amount) {
            reporter(`КЛАМП: применено ${actualDelta > 0 ? '+' : ''}${actualDelta} (${oldVal} → ${cur})${suffix}`);
        } else {
            reporter(`применено: ${oldVal} → ${cur}${suffix}`);
        }
    } else if (!silent) {
        addLog(`[cd: ${key}, ${actualDelta > 0 ? '+' : ''}${actualDelta}]`);
    }

    gameState.rules.forEach(rule => {
        if (rule.source === key) {
            let conditionMet = false;
            if (rule.condition.includes('<=')) conditionMet = gameState.counters[key].current <= parseInt(rule.condition.replace('<=', ''));
            if (rule.condition.includes('>=')) conditionMet = gameState.counters[key].current >= parseInt(rule.condition.replace('>=', ''));
            if (conditionMet) {
                // Каскад правила получает собственный префикс отчета,
                // чтобы ИИ видел СЛЕДСТВИЕ своего изменения, а не повтор дельты
                const rep2 = reporter
                    ? (msg) => addLog(`# RPG: правило [${rule.source} ${rule.condition} → ${rule.target}, ${rule.delta}] ${msg}`)
                    : null;
                changeCounter(rule.target, rule.delta, visited, rep2, silent);
            }
        }
    });
    saveState();
    if (typeof updateUI === 'function') updateUI();
}

// Парсер мини-языка v2: регулярки вместо chained-replace.
// Возвращает { ops, warnings } — warnings уходят агенту в отчет # RPG:,
// чтобы он видел свои поврежденные/неизвестные теги.
// Строки-комментарии (# RPG: ...) полностью игнорируются (ФИКС эхо-цикла).
function parseSysBlock(text) {
    const ops = [];
    const warnings = [];
    if (!text) return { ops, warnings };
    text.split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) return;
        let m;
        if ((m = line.match(/^\[t:\s*(\d+)\s*\]/))) {
            ops.push({ type: 'turn', id: parseInt(m[1]) });
        }
        else if ((m = line.match(/^\[tm:\s*([^\]]+)\]/))) {
            const p = m[1].split(',').map(s => s.trim());
            // v4.1: дата может содержать запятые ("Мороз 30, 4Э 201") — при
            // более чем 3 частях середина склеивается в дату, последняя часть — день
            let date = p[1], day = p[2];
            if (p.length > 3) { date = p.slice(1, -1).join(', '); day = p[p.length - 1]; }
            ops.push({ type: 'time_set', time: p[0], date: date, day: day });
        }
        else if ((m = line.match(/^\[td:\s*([^\]]+)\]/))) {
            ops.push({ type: 'time_delta', val: m[1].trim() });
        }
        // v4.0 ГИБКИЕ СЧЕТЧИКИ: [c: Имя, Значение[, Макс][, Тип: bar|text|time|enemy][, Группа: Имя]]
        // Первый элемент хвоста — Макс (число) или props; Значение может быть
        // строкой времени '14:30' при Тип: time
        else if ((m = line.match(/^\[c:\s*([^,\]]+)\s*,\s*([^,\]]+)(?:\s*,\s*(.+))?/))) {
            const rawVal = m[2].trim();
            let rest = m[3] ? m[3].replace(/\].*$/, '').trim() : '';
            let max = null, ctype = null, group = null, bd = null, mcal = null;
            if (rest) {
                const segs = rest.split(',').map(s => s.trim()).filter(Boolean);
                if (segs.length && /^-?\d+$/.test(segs[0])) { max = parseInt(segs[0]); segs.shift(); }
                // v4.1: значения Разбивка/Календарь могут содержать запятые
                // ("Календарь: 31, 28, 14") — сег БЕЗ известного ключа продолжает
                // значение предыдущего пропса, а не отбрасывается
                const props = [];
                const KNOWN = /^(тип|type|группа|group|разбивка|break|календарь|месяцы|calendar)\s*:\s*(.+)$/i;
                segs.forEach(seg => {
                    const pm = seg.match(KNOWN);
                    if (pm) props.push({ key: pm[1], val: pm[2].trim() });
                    else if (props.length) props[props.length - 1].val += ', ' + seg;
                });
                props.forEach(pr => {
                    const k = normName(pr.key);
                    const v = pr.val;
                    if (k === 'тип' || k === 'type') {
                        const tv = normName(v);
                        if (['bar', 'text', 'time', 'enemy'].includes(tv)) ctype = tv;
                    } else if (k === 'группа' || k === 'group') {
                        group = v;
                    } else if (k === 'разбивка' || k === 'break') {
                        // v4.1 ТАБЛИЦА РАЗБИВОК: "Уровень:100" или цепочка через |.
                        // Рост порога: "+Шаг" (каждый следующий юнит дороже на Шаг)
                        // или "×М"/"*М" (каждый следующий в М раз дороже).
                        bd = [];
                        String(v).split(/[|,]/).map(s => s.trim()).filter(Boolean).forEach(seg => {
                            const sm = seg.match(/^(.+?):\s*(\d+)(?:\+(\d+))?(?:[×x*]\s*(\d+(?:\.\d+)?))?$/i);
                            if (!sm) return;
                            const per = parseInt(sm[2]);
                            if (per < 2) return;
                            bd.push({ name: sm[1].trim(), per: per, step: sm[3] ? parseInt(sm[3]) : 0, mult: sm[4] ? Number(sm[4]) : 1 });
                        });
                        if (!bd.length) {
                            bd = null;
                            warnings.push(`в [c: ${m[1].trim()}] таблица разбивок "${v}" не разобрана (формат "Имя:Порог", можно +Шаг или ×М)`);
                        }
                    } else if (k === 'календарь' || k === 'месяцы' || k === 'calendar') {
                        // v4.1 СЧЕТЧИК-ДАТА: ТАБЛИЦА МЕСЯЦЕВ (последовательные месяцы
                        // с разной длиной) через |: "Урожая:31|Закона:28|Любви:14".
                        // Голое число — безымянный месяц по порядку ("1-й месяц").
                        // Значение счетчика = сколько дней прошло с начала цикла.
                        mcal = parseMonthList(String(v), /[|,]/);
                        if (!mcal.length) { mcal = null; warnings.push(`в [c: ${m[1].trim()}] таблица месяцев "${v}" не разобрана`); }
                    }
                });
            }
            if (/^-?\d+$/.test(rawVal)) {
                ops.push({ type: 'counter_set', name: m[1].trim(), cur: parseInt(rawVal), max: max, ctype: ctype, group: group, breakdown: bd, months: mcal });
            } else if (ctype === 'time') {
                // '14:30' и подобные — строка, хранится и отображается как есть
                ops.push({ type: 'counter_set', name: m[1].trim(), cur: rawVal, max: null, ctype: 'time', group: group, breakdown: bd, months: mcal });
            } else {
                warnings.push(`в [c: ${m[1].trim()}] значение "${rawVal}" не число`);
            }
        }
        else if ((m = line.match(/^\[cd:\s*([^,\]]+)\s*,\s*([^\],]+)/))) {
            const delta = parseInt(m[2]);
            if (isNaN(delta)) warnings.push(`в [cd: ${m[1].trim()}] дельта "${m[2].trim()}" не число`);
            else ops.push({ type: 'counter_delta', name: m[1].trim(), delta: delta });
        }
        else if ((m = line.match(/^\[tab:\s*([^,\]]+)\s*,\s*([^,\]]+)(?:\s*,\s*([^\]]+))?/))) {
            let cost = {};
            if (m[3]) m[3].split(',').forEach(c => {
                const [k, v] = c.split(':');
                const num = parseInt(v);
                if (k && v && !isNaN(num)) cost[k.trim()] = num;
            });
            ops.push({ type: 'tab_add', name: m[1].trim(), key: m[2].trim(), cost: cost });
        }
        else if ((m = line.match(/^\[i:\s*([^,\]]+)\s*(.*)/))) {
            let propsObj = {};
            const rest = m[2] ? m[2].replace(/\].*$/, '') : ''; // обрезаем ']...' и хвостовой комментарий ИИ
            rest.split(',').forEach(prop => {
                const [k, v] = prop.split(':');
                if (k && v) propsObj[k.trim()] = v.trim();
            });
            ops.push({ type: 'item_add', name: m[1].trim(), props: propsObj });
        }
        else if ((m = line.match(/^\[r:\s*([^,\]]+)\s*,\s*([^,\]]+)\s*,\s*([^,\]]+)\s*,\s*([^\],]+)/))) {
            const delta = parseInt(m[4]);
            if (isNaN(delta)) warnings.push(`в [r: ...] дельта "${m[4].trim()}" не число`);
            else ops.push({ type: 'rule_add', source: m[1].trim(), cond: m[2].trim(), target: m[3].trim(), delta: delta });
        }
        // ФИКС [rm:]: имя берем строго до первой ']' — хвостовой комментарий ИИ
        // ("[rm: Плащ] — передан торговцу") больше не ломает имя
        else if ((m = line.match(/^\[rm:\s*([^\]]+)\]/))) {
            ops.push({ type: 'remove', name: m[1].trim() });
        }
        // ============================================================
        // v3.9: STATEFUL ITEMS / ТАЙМЕРЫ / ЗАПРОСЫ
        // ============================================================
        else if ((m = line.match(/^\[iu:\s*([^,\]]+)\s*,\s*([^,\]]+)\s*,\s*([^\],]+)/))) {
            const delta = parseInt(m[3]);
            if (isNaN(delta)) warnings.push(`в [iu: ${m[1].trim()}] дельта "${m[3].trim()}" не число`);
            else ops.push({ type: 'item_update', name: m[1].trim(), prop: m[2].trim(), delta: delta });
        }
        else if ((m = line.match(/^\[ir:\s*([^,\]]+)\s*,\s*([^,\]]+)\s*,\s*([^,\]]+)\s*,\s*([^\]]+)\]/))) {
            const cm = m[3].trim().match(/^(<=|>=|<|>|==|=)\s*(-?\d+)$/);
            if (!cm || isNaN(parseInt(cm[2]))) warnings.push(`в [ir: ${m[1].trim()}] не понял условие "${m[3].trim()}" (пример: <=0)`);
            else ops.push({ type: 'item_rule', name: m[1].trim(), prop: m[2].trim(), condOp: (cm[1] === '=' ? '==' : cm[1]), condVal: parseInt(cm[2]), action: m[4].trim() });
        }
        // ФИКС вложенных тегов: внутри [timer:] есть теги с запятыми, поэтому
        // делим строку только по ПЕРВЫМ ДВУМ запятым (ID и время), а все, что
        // после второй запятой — "сырая" строка команд (исполнится при срабатывании)
        else if ((m = line.match(/^\[timer:\s*(.+)$/))) {
            let body = m[1].trim();
            if (body.endsWith(']')) body = body.slice(0, -1); // закрывающая скобка самого [timer:]
            const c1 = body.indexOf(',');
            const c2 = c1 === -1 ? -1 : body.indexOf(',', c1 + 1);
            if (c1 === -1 || c2 === -1) {
                warnings.push(`в [timer:] нужен формат "ID, время, команды" — "${line.slice(0, 50)}"`);
            } else {
                ops.push({ type: 'timer_add', id: body.slice(0, c1).trim(), time: body.slice(c1 + 1, c2).trim(), commands: body.slice(c2 + 1).trim() });
            }
        }
        else if ((m = line.match(/^\[query:\s*([^\]]+)\]/))) {
            ops.push({ type: 'query', scope: m[1].trim() });
        }
        else if ((m = line.match(/^\[msg:\s*([^\]]+)\]/))) {
            ops.push({ type: 'msg', text: m[1].trim() });
        }
        // v4.1 УМНЫЙ КАЛЕНДАРЬ: [cal: Скайрим] — пресет; [cal: Морндас, Тирдас, ...]
        // — свои дни недели; после | — свои месяцы; [cal: сброс] — реальный формат.
        else if ((m = line.match(/^\[cal:\s*([^\]]+)\]/))) {
            ops.push({ type: 'cal_set', spec: m[1].trim() });
        }
        // v4.0: [status: Цель, Эффект, Значение] — устойчивая регулярка с ленивыми
        // полями (запятые внутри Значения не ломают тег; комментарий после ] допустим).
        // Снятие статуса: Значение 0 / "снят".
        else if ((m = line.match(/^\[status:\s*(.+?),\s*(.+?),\s*(.+?)\]/))) {
            ops.push({ type: 'status', target: m[1].trim(), effect: m[2].trim(), value: m[3].trim() });
        }
        else if ((m = line.match(/^\[ROLL:\s*([^\],]+?)(?:\s*,\s*Result:\s*\d+)?\s*\]/i))) {
            // Бросок без результата — расширение кинет кубик само.
            // Если ИИ уже указал Result, это информационный тег — не трогаем.
            if (!/Result/i.test(line)) ops.push({ type: 'roll', spec: m[1].trim() });
        }
        else if (/^\[[a-zа-я_]/i.test(line)) {
            warnings.push(`неизвестный или поврежденный тег "${line.slice(0, 40)}"`);
        }
        // Остальные строки — нарратив, игнорируем
    });
    return { ops, warnings };
}

function applyOps(ops, reportToAI) {
    // v3.9: сдвиг времени или установка таймера → проверка отложенных событий
    let timeTouched = false;
    ops.forEach(op => {
        if (op.type === 'time_set') { gameState.time = { ...(gameState.time || {}), time: op.time, date: op.date, day: op.day }; timeTouched = true; } // v4.1: календарь мира переживает [tm:]
        if (op.type === 'time_delta') {
            // v3.9: любые интервалы (включая сутки) через абсолютные минуты —
            // корректный переход через полночь: меняются время, дата и день недели
            const md = op.val.match(/(\d+)\s*d/i);
            const mh = op.val.match(/(\d+)\s*h/i);
            const mm = op.val.match(/(\d+)\s*m/i);
            const addMins = (md ? parseInt(md[1]) * 1440 : 0) + (mh ? parseInt(mh[1]) * 60 : 0) + (mm ? parseInt(mm[1]) : 0);
            const oldMin = gameTimeMinutes(gameState.time);
            const t = new Date((oldMin + addMins) * 60000);
            const pad = n => String(n).padStart(2, '0');
            gameState.time.time = `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
            const daysCrossed = Math.floor((oldMin + addMins) / 1440) - Math.floor(oldMin / 1440);
            const dateStr = String(gameState.time.date || '');
            // v4.1 УМНЫЙ КАЛЕНДАРЬ: если дата реальная — математика по ДД.ММ.ГГГГ
            // (как раньше); если фэнтезийная ("Мороз 4, 4Э 201") — число дня
            // находится в строке и увеличивается, остальной текст сохраняется.
            if (/^\s*\d{1,2}\.\d{1,2}\.\d{2,4}\s*$/.test(dateStr)) {
                gameState.time.date = `${pad(t.getUTCDate())}.${pad(t.getUTCMonth() + 1)}.${t.getUTCFullYear()}`;
            } else if (dateStr.trim()) {
                const dayAdd = Math.max(md ? parseInt(md[1]) : 0, daysCrossed);
                if (dayAdd > 0) {
                    const advanced = advanceFantasyDate(dateStr, dayAdd);
                    if (advanced !== null) gameState.time.date = advanced;
                }
            }
            // День недели вращаем по АКТИВНОМУ календарю мира (Скайрим и т.п.),
            // а без календаря — по стандарту Пн–Вс
            if (daysCrossed > 0) {
                const week = calendarWeekdays() || ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
                const idx = week.findIndex(w => normName(w) === normName(gameState.time.day));
                if (idx !== -1) gameState.time.day = week[(idx + (daysCrossed % week.length)) % week.length];
            }
            timeTouched = true;
        }
        // v4.1: установка календаря мира + УМНАЯ КОНВЕРТАЦИЯ реальной даты
        if (op.type === 'cal_set') {
            if (!gameState.time || typeof gameState.time !== 'object') gameState.time = {};
            const spec = String(op.spec || '').trim();
            if (/^(сброс|сбросить|нет|реальный|стандарт|off|-)$/i.test(spec)) {
                gameState.time.calendar = null;
                if (reportToAI) addLog('# RPG: [cal:] → календарь сброшен (реальный формат ДД.ММ.ГГГГ)');
                return;
            }
            const preset = CALENDAR_PRESETS[normName(spec)];
            let cal = null;
            if (preset) {
                cal = { name: preset.name, weekdays: preset.weekdays.slice(), months: preset.months.map(m => ({ name: m.name, days: m.days })) };
            } else {
                // Кастом: "день1, день2, ... | месяц1, месяц2, ..." (месяцы не обязательны).
                // v4.1: месяцы — ТАБЛИЦА с длинами: "Урожая:31", "Закона/28",
                // "Любви - 14"; голое число — безымянный месяц ("1-й месяц").
                const parts = spec.split('|').map(s => s.trim()).filter(Boolean);
                const weekdays = parts[0] ? parts[0].split(',').map(s => s.trim()).filter(Boolean) : [];
                const months = parts[1] ? parseMonthList(parts[1], /,/) : null;
                if (weekdays.length >= 2) cal = { name: null, weekdays: weekdays, months: months };
            }
            if (!cal) {
                // v4.1: сбрасываем в null (не оставляем старый календарь от предыдущего мира)
                gameState.time.calendar = null;
                if (reportToAI) addLog(`# RPG: [cal: ${spec}] → не разобран (нужен пресет "Скайрим" или ≥2 дней недели через запятую)`);
                return;
            }
            gameState.time.calendar = cal;
            const monthTotal = (cal.months || []).reduce((s, m) => s + (Number(m.days) || 30), 0);
            let msg = `# RPG: [cal: ${spec}] → календарь установлен (${cal.weekdays.length} дн. недели${cal.months ? ', ' + cal.months.length + ' мес. / ' + monthTotal + ' дн.' : ''})`;
            // Если дата сейчас в реальном формате и у календаря есть месяцы —
            // переводим ее в формат мира, идя по ТАБЛИЦЕ длин месяцев:
            // "16.11.2026" (320-й день года) → "Закат Солнца 20, 2026"
            const ds = String(gameState.time.date || '').trim();
            if (cal.months && cal.months.length && /^\s*\d{1,2}\.\d{1,2}\.\d{2,4}\s*$/.test(ds)) {
                const pd = ds.split('.').map(v => parseInt(v));
                const doy = Math.round((Date.UTC(pd[2], pd[1] - 1, pd[0]) - Date.UTC(pd[2], 0, 1)) / 86400000) + 1;
                const doyW = ((doy - 1) % monthTotal) + 1;
                let acc = 0, mi = 0, md = 1;
                for (let i = 0; i < cal.months.length; i++) {
                    const d = Number(cal.months[i].days) || 30;
                    if (doyW <= acc + d) { mi = i; md = doyW - acc; break; }
                    acc += d;
                }
                const newDate = `${cal.months[mi].name} ${md}, ${pd[2]}`;
                const weekRU = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
                const wi = weekRU.indexOf(gameState.time.day);
                if (wi !== -1 && cal.weekdays.length === 7) gameState.time.day = cal.weekdays[wi];
                gameState.time.date = newDate;
                msg += `; дата переведена: ${ds} → ${newDate}`;
            }
            if (reportToAI) addLog(msg);
            return;
        }
        if (op.type === 'counter_set') gameState.counters[op.name] = { current: op.cur, max: op.max, color: (op.ctype === 'enemy' ? '#e53935' : '#2196F3'), ctype: op.ctype, group: op.group, breakdown: op.breakdown || null, months: op.months || null };
        // Дельты ИИ идут через changeCounter: клампы по 0/max, каскады правил
        // и (при reportToAI) отчет агенту в logQueue — в формате # RPG:,
        // который парсер SYS игнорирует (нет риска двойного счета).
        // reportToAI = false при реплеях истории (F5), чтобы не спамить старьем.
        if (op.type === 'counter_delta') {
            // v4.0: счетчик может лежать под ключом с эмодзи ('🩸 Кровь') —
            // резолвим имя нормализацией ДО guard'а, иначе тег без эмодзи
            // отбивается здесь и до changeCounter не доходит.
            const resolvedKey = Object.keys(gameState.counters)
                .find(k => !isGarbageName(k) && normName(k) === normName(op.name)) || null;
            if (!resolvedKey) {
                if (reportToAI) addLog(`# RPG: [cd: ${op.name}, ${op.delta > 0 ? '+' : ''}${op.delta}] → игнор (счетчик не найден)`);
                return;
            }
            const rep = reportToAI
                ? (msg) => addLog(`# RPG: [cd: ${op.name}, ${op.delta > 0 ? '+' : ''}${op.delta}] ${msg}`)
                : null;
            changeCounter(resolvedKey, op.delta, undefined, rep, !reportToAI);
            return;
        }
        if (op.type === 'tab_add') gameState.tabs[op.name] = { key: op.key, cost: op.cost };
        
        // ФИКС: Защита от дублирования предметов (+ нормализация ё/е и регистра)
        if (op.type === 'item_add') {
            const existingItem = gameState.items.find(i => normName(i.name) === normName(op.name));
            if (!existingItem) {
                gameState.items.push({ name: op.name, props: op.props });
            } else {
                existingItem.props = { ...existingItem.props, ...op.props };
            }
        }
        
        // ФИКС: дедуп правил — одинаковые [r:] не накапливаются при повторной
        // обработке сообщений (стриминг/перегенерация/реплей истории)
        if (op.type === 'rule_add') {
            const exists = gameState.rules.some(r =>
                r.source === op.source && r.condition === op.cond &&
                r.target === op.target && r.delta === op.delta);
            if (!exists) gameState.rules.push({ source: op.source, condition: op.cond, target: op.target, delta: op.delta });
        }
        if (op.type === 'remove') {
            // ФИКС: удаляем по нормализованному имени (ё/е, регистр, пробелы).
            // Бросок [ROLL: ...] из ИИ обрабатывается отдельно (не state-op).
            const target = normName(op.name);
            let removed = false;
            Object.keys(gameState.counters).forEach(k => { if (normName(k) === target) { delete gameState.counters[k]; removed = true; } });
            Object.keys(gameState.tabs).forEach(k => { if (normName(k) === target) { delete gameState.tabs[k]; removed = true; } });
            const before = gameState.items.length;
            gameState.items = gameState.items.filter(i => normName(i.name) !== target);
            if (gameState.items.length < before) removed = true;
            if (reportToAI) addLog(`# RPG: [rm: ${op.name}] → ${removed ? 'удалено' : 'не найдено (уже удалено или опечатка в имени?)'}`);
        }

        // ============================================================
        // v3.9: STATEFUL ITEMS / ТАЙМЕРЫ / ЗАПРОСЫ
        // ============================================================
        if (op.type === 'item_update') {
            const item = findItem(op.name);
            if (!item) {
                if (reportToAI) addLog(`# RPG: [iu: ${op.name}, ${op.prop}, ${op.delta}] → предмет не найден`);
                return;
            }
            item.props = item.props || {};
            const key = Object.keys(item.props).find(k => normName(k) === normName(op.prop));
            const propKey = key || op.prop;
            const pv = parsePropVal(item.props[propKey]);
            if (pv.raw !== undefined) {
                if (reportToAI) addLog(`# RPG: [iu: ${op.name}, ${op.prop}, ${op.delta}] → свойство не числовое ("${pv.raw}")`);
                return;
            }
            const old = pv.cur;
            pv.cur += op.delta;
            if (pv.cur < 0) pv.cur = 0;
            if (pv.max !== null && pv.cur > pv.max) pv.cur = pv.max;
            item.props[propKey] = formatPropVal(pv);
            if (reportToAI) {
                const noChange = pv.cur === old;
                addLog(`# RPG: [iu: ${op.name}, ${op.prop}, ${op.delta}] → ${noChange ? 'без изменений (граница 0/max)' : `${propKey}: ${old} → ${pv.cur}${pv.max !== null ? '/' + pv.max : ''}`}`);
            }
            runItemRules(item, propKey, reportToAI);
            return;
        }
        if (op.type === 'item_rule') {
            if (!Array.isArray(gameState.itemRules)) gameState.itemRules = [];
            // Дедуп правил (как у [r:]) — перегенерация не накапливает копии
            const exists = gameState.itemRules.some(r =>
                normName(r.name) === normName(op.name) && normName(r.prop) === normName(op.prop) &&
                r.condOp === op.condOp && r.condVal === op.condVal && normName(r.action) === normName(op.action));
            if (!exists) {
                gameState.itemRules.push(op);
                if (reportToAI) addLog(`# RPG: [ir: ${op.name}, ${op.prop}, ${op.condOp}${op.condVal}, ${op.action}] → правило установлено`);
            }
            return;
        }
        if (op.type === 'timer_add') {
            if (!Array.isArray(gameState.timers)) gameState.timers = [];
            const at = parseTimerTarget(op.time);
            if (at === null) {
                if (reportToAI) addLog(`# RPG: [timer: ${op.id}, ${op.time}] → не понял время (примеры: "+2d", "+5h", "25.11.2026 14:00")`);
                return;
            }
            // Повторный тег с тем же ID перезаписывает время/команды (правка таймера)
            gameState.timers = gameState.timers.filter(t => normName(t.id) !== normName(op.id));
            gameState.timers.push({ id: op.id, at: at, commands: op.commands });
            if (reportToAI) addLog(`# RPG: [timer: ${op.id}] установлен — сработает ${minutesToGameTime(at)}`);
            timeTouched = true; // таймер может быть уже просрочен — проверим сразу
        }
        if (op.type === 'query') {
            // ИНВАРИАНТ v3.8 (без автоотправки): отчет уходит в очередь логов
            // и приклеится к следующему сообщению ИГРОКА — ИИ прочитает его
            // в начале своего следующего хода, без риска спама/блокировки.
            if (reportToAI) addLog(`# RPG: INFO: ${buildStateInfo(op.scope)}`);
            return;
        }
        if (op.type === 'msg') {
            if (reportToAI) addLog(`# RPG: 📣 ${op.text}`);
            return;
        }
        if (op.type === 'status') {
            if (!Array.isArray(gameState.statuses)) gameState.statuses = [];
            const val = String(op.value || '').trim();
            const clear = /^(0|снят|снять|нет|убрать|нет статуса)$/i.test(val);
            // Дедап по (Цель + Эффект): повтор тега обновляет значение
            const idx = gameState.statuses.findIndex(s =>
                normName(s.target) === normName(op.target) && normName(s.effect) === normName(op.effect));
            if (clear) {
                if (idx !== -1) {
                    gameState.statuses.splice(idx, 1);
                    if (reportToAI) addLog(`# RPG: [status: ${op.target}, ${op.effect}] → статус снят`);
                } else if (reportToAI) {
                    addLog(`# RPG: [status: ${op.target}, ${op.effect}] → статуса не было`);
                }
            } else if (idx !== -1) {
                gameState.statuses[idx].value = val;
                if (reportToAI) addLog(`# RPG: [status: ${op.target}, ${op.effect}] → обновлено (${val})`);
            } else {
                gameState.statuses.push({ target: op.target, effect: op.effect, value: val });
                if (reportToAI) addLog(`# RPG: [status: ${op.target}, ${op.effect}, ${val}] → статус установлен`);
            }
            return;
        }
    });
    // v3.9: после сдвига времени или установки таймера — исполняем просроченные
    if (timeTouched) checkTimers(reportToAI);
}
