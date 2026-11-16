// content.js — v34
// Перехват чата: парсинг [SYS]-блоков, скрытие системных данных,
// приклейка логов при отправке (Enter и клик, textarea и contenteditable),
// HUD над полем ввода (логи, промпт, кубики), броски по запросу ИИ,
// защита от эхо-цикла и размышлений модели, детект новой игры в чате,
// СТАРТ ИГРЫ ОТ ИГРОКА ([SYS] в обычном сообщении пользователя).
// ГЛАВНЫЙ ИНВАРИАНТ v30+: расширение НИКОГДА не отправляет сообщения само —
// только вставляет текст в поле ввода, Enter жмет игрок (нет циклов и
// риска блокировки за частоту сообщений).
// v31: stateful-предметы ([iu:]/[ir:]), таймеры ([timer:]), запросы
// состояния ([query:]) и заметки ([msg:]); «Вставить в чат» панели
// приклеивает накопленные логи в поле ввода (SEND_LOGS_TO_INPUT).
// v32: гибкие счетчики (Тип: bar/text/time/enemy, Группа), статусы
// ([status:]), фэнтезийные даты, группированный [query: all].
// v33: календари мира ([cal: Скайрим] + умная конвертация даты и вращение
// дней недели/месяцев в [td:]) и таблицы разбивок счетчиков
// ([c: Опыт, 450, Разбивка: Уровень:100+50] — уровни требуют всё больше опыта).
// v34: АДАПТЕР САЙТОВ — работает и на DeepSeek (chat.deepseek.com),
// и на Алисе (alice.yandex.ru). Весь конвейер site-agnostic, от сайта
// зависят только контейнер ответа ИИ (.ds-markdown / .FuturisMarkdown)
// и regex ID чата (ключ профиля состояния).

console.log("[DeepSeek RPG] Content Script загружен (v34 - DeepSeek + Алиса; без автоотправки: всё вставляется в поле, отправляет игрок).");

let debugLogs = [];
function log(msg) {
    console.log(`[DeepSeek RPG] ${msg}`);
    debugLogs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (debugLogs.length > 100) debugLogs.shift();
}

function safeSend(message) {
    try { chrome.runtime.sendMessage(message); } catch (e) { /* ignore */ }
}

const style = document.createElement('style');
style.textContent = `
    .sys-hidden-block { display: none !important; }
    .sys-spoiler { background: #2d2d2d; border: 1px solid #444; border-radius: 4px; margin: 10px 0; padding: 5px; font-family: monospace; font-size: 12px; color: #888; }
    .sys-spoiler summary { cursor: pointer; color: #4CAF50; font-weight: bold; }
    .sys-spoiler pre { white-space: pre-wrap; margin: 4px 0 0 0; max-height: 220px; overflow: auto; }
`;
document.head.appendChild(style);

// --- Определение ID чата (ключ профиля состояния) ---
// ============================================================
// v4.2/v34: АДАПТЕР САЙТОВ. Работает на DeepSeek (chat.deepseek.com)
// и Алисе (alice.yandex.ru). Весь конвейер site-agnostic — от сайта
// зависят только 3 вещи:
//   aiBlock      — контейнер markdown-ответа ИИ:
//                  DeepSeek ".ds-markdown", Алиса ".FuturisMarkdown"
//                  (проверено в живом DOM: .Message > .MessageBubble >
//                  .AliceTextBubble > .MarkdownText > .FuturisMarkdown);
//   aiBlockClass — то же имя без точки (для classList.contains);
//   chatIdRe     — как из URL достать ID чата. Алиса: /chat/<uuid>/.
// Поле ввода (у Алисы — обычный textarea AliceInput-Textarea), перехват
// отправки, спойлеры, отпечатки эха, классификация ходов — универсальны.
// На хосте не из списка расширение полностью инертно (ничего не находит).
// ============================================================
const SITES = {
    deepseek: {
        host: 'chat.deepseek.com',
        aiBlock: '.ds-markdown',
        aiBlockClass: 'ds-markdown',
        chatIdRe: /chat\/(?:a\/chat\/)?s\/([a-zA-Z0-9-]+)/
    },
    alice: {
        host: 'alice.yandex.ru',
        aiBlock: '.FuturisMarkdown',
        aiBlockClass: 'FuturisMarkdown',
        chatIdRe: /chat\/([a-zA-Z0-9-]+)/
    }
};
function detectSite() {
    const h = location.hostname;
    return Object.keys(SITES).find(k => h === SITES[k].host || h.endsWith('.' + SITES[k].host)) || null;
}
const SITE = detectSite();
// На неизвестном хосте селекторы никогда не совпадут — расширение инертно.
const CFG = SITE ? SITES[SITE] : { aiBlock: '.rpg-nosite', aiBlockClass: 'rpg-nosite', chatIdRe: /$^/ };
const AI_BLOCK_SEL = CFG.aiBlock;
const CHAT_ID_RE = CFG.chatIdRe;
function getChatId() {
    const m = location.pathname.match(CHAT_ID_RE);
    return m ? m[1] : 'default';
}

// ============================================================
// ПОИСК ПОЛЯ ВВОДА (textarea ИЛИ contenteditable — не зависим от верстки)
// ============================================================
function getInput() {
    const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"]')];
    // Предпочитаем textarea; иначе последнее contenteditable (обычно внизу страницы)
    return candidates.find(el => el.tagName === 'TEXTAREA') || candidates[candidates.length - 1] || null;
}

function inputHasText(input) {
    if (!input) return false;
    return input.tagName === 'TEXTAREA' ? !!input.value.trim() : !!input.textContent.trim();
}

// ============================================================
// ПОИСК И ЗАМЕНА [SYS]..[/SYS] (v24, не менялось — работает)
// Тег должен быть автономным (своей строкой/блоком), <code>/<pre> игнорируются.
// ============================================================
let lastProcessedTurn = 0;
let lastTurnBlock = null; // DOM-узел последнего отправленного блока (признак "блок ниже" = новая игра)
let debounceTimer;

// Отпечатки приклеенных нами [SYS]-блоков: когда игрок отправляет сообщение,
// логи уезжают в чат, а затем возвращаются в DOM в тексте сообщения игрока.
// Без этой защиты такой блок парсится как "новый ход" (эхо-цикл баг №1).
// Храним ВНУТРЕННИЙ текст блока (без обёрток) — ровно то, что вернет
// extractSysText при повторной встрече блока в DOM.
// Кап 30 — хватит с запасом, память не течет.
function fpKey(text) {
    // Нормализация пробелов: извлечение из DOM может отличаться переносами
    return String(text).replace(/\s+/g, ' ').trim();
}
const gluedFingerprints = new Set();
function rememberFingerprint(text) {
    gluedFingerprints.add(fpKey(text));
    if (gluedFingerprints.size > 30) {
        gluedFingerprints.delete(gluedFingerprints.values().next().value);
    }
}

const OPS_RE = /\[(?:t|tm|td|c|cd|tab|i|iu|r|rm|ir|timer|query|msg|status|cal):/;

function isStandalone(t, index, tagLen) {
    const before = t.slice(0, index);
    const after = t.slice(index + tagLen);
    const beforeOk = /(^|[\n\r])\s*$/.test(before);
    const afterOk = /^\s*($|[\n\r])/.test(after);
    return beforeOk && afterOk;
}

function makeWalker(block) {
    return document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            let el = n.parentElement;
            while (el && el !== block) {
                if (el.tagName === 'CODE' || el.tagName === 'PRE') return NodeFilter.FILTER_REJECT;
                el = el.parentElement;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });
}

// Все автономные пары [SYS]..[/SYS] в порядке появления (v28).
// Модели с рассуждениями ("Думал N секунд") упоминают [SYS] в блоке размышлений
// ДО настоящего игрового блока — поэтому ищем ВСЕ пары, а не первую.
// Незакрытый [SYS] (пример в размышлениях) не ломает поиск: следующий
// [SYS] перезаписывает незакрытое начало.
function findSysRanges(block) {
    const pairs = [];
    const walker = makeWalker(block);
    let startNode = null, startOffset = -1;
    let node;
    while ((node = walker.nextNode())) {
        const t = node.nodeValue || '';
        let i = t.indexOf('[SYS]');
        while (i !== -1) {
            if (isStandalone(t, i, 5)) { startNode = node; startOffset = i; }
            i = t.indexOf('[SYS]', i + 1);
        }
        if (!startNode) continue;
        const from = node === startNode ? startOffset + 5 : 0;
        let j = t.indexOf('[/SYS]', from);
        while (j !== -1) {
            if (isStandalone(t, j, 6)) {
                pairs.push({ startNode, startOffset, endNode: node, endOffset: j });
                startNode = null;
                break;
            }
            j = t.indexOf('[/SYS]', j + 1);
        }
    }
    return pairs;
}

function extractSysText(block, r) {
    const walker = makeWalker(block);
    let node, parts = [], active = false;
    while ((node = walker.nextNode())) {
        const t = node.nodeValue || '';
        if (node === r.startNode) {
            active = true;
            if (node === r.endNode) { parts.push(t.slice(r.startOffset + 5, r.endOffset)); break; }
            parts.push(t.slice(r.startOffset + 5));
            continue;
        }
        if (active && node === r.endNode) { parts.push(t.slice(0, r.endOffset)); break; }
        if (active) parts.push(t);
    }
    return parts.map(s => s.trim()).filter(Boolean).join('\n');
}

function buildSpoiler(rawText) {
    const details = document.createElement('details');
    details.className = 'sys-spoiler';
    const summary = document.createElement('summary');
    summary.textContent = '[Системные данные]';
    const pre = document.createElement('pre');
    pre.textContent = rawText;
    details.append(summary, pre);
    return details;
}

function spoilerize(block, r, rawText) {
    const range = document.createRange();
    range.setStart(r.startNode, r.startOffset);
    range.setEnd(r.endNode, r.endOffset + 6);
    range.deleteContents();
    range.insertNode(buildSpoiler(rawText));
    block.querySelectorAll('p, div').forEach(el => {
        if (!el.textContent.trim() && !el.querySelector('details, img, ul, table, code, pre')) el.remove();
    });
}

function processAndSend() {
    const blocks = [...document.querySelectorAll(AI_BLOCK_SEL)];
    blocks.forEach((block, idx) => {
      try {
        const text = block.innerText;

        // ФИКС (v27): наши спойлеры переживают F5. Раньше блок после спойлеризации
        // навсегда выпадал из конвейера: после F5 панель пустовала до следующего
        // хода ИИ, а ход 1 новой игры, проигнорированный панелью (профиль хранил
        // ходы прошлой игры), терялся навсегда. Теперь текст достаем из спойлера
        // и прогоняем через конвейер заново.
        const spoilerPre = block.querySelector('details.sys-spoiler pre');
        if (!text.includes('[SYS]') && !spoilerPre) return;

        const sig = text.slice(0, 2000);
        if (block.dataset.sysProcessed === 'true' && block.dataset.sysSig === sig) return;
        block.dataset.sysProcessed = 'true';
        block.dataset.sysSig = sig;

        // v28: СПОЙЛЕР — ПЕРВЫМ ДЕЛОМ. Блок размышлений модели ("Думал N секунд")
        // может содержать [SYS] — сырной поиск там опасен. Спойлер — канонический
        // текст уже обработанного блока (переживает F5).
        // Сырой путь: берем ПОСЛЕДНЮЮ пару с игровыми тегами (настоящий блок
        // стоит в конце сообщения); пара из размышлений без тегов отсеется.
        let r = null, rawText = null;
        if (spoilerPre) {
            rawText = spoilerPre.textContent || '';
            // если ПОСЛЕ спойлера есть еще сырое [SYS] (второй блок в сообщении) — берем его
            if (text.includes('[SYS]')) {
                const pairs = findSysRanges(block);
                for (let k = pairs.length - 1; k >= 0; k--) {
                    if (spoilerPre.compareDocumentPosition(pairs[k].startNode) & Node.DOCUMENT_POSITION_FOLLOWING) {
                        const cand = extractSysText(block, pairs[k]);
                        if (OPS_RE.test(cand)) { r = pairs[k]; rawText = cand; break; }
                    }
                }
            }
        } else if (text.includes('[SYS]')) {
            const pairs = findSysRanges(block);
            for (let k = pairs.length - 1; k >= 0; k--) {
                const cand = extractSysText(block, pairs[k]);
                if (OPS_RE.test(cand)) { r = pairs[k]; rawText = cand; break; }
            }
        }
        if (rawText === null) {
            log('SYS-теги найдены, но автономного блока нет (инлайн/код) — не трогаю.');
            return;
        }

        // ФИКС эхо-цикла: приклеенный нами [SYS] (логи игрока) возвращается в DOM
        // в сообщении игрока. Такой блок узнается по отпечатку — спойлер, без отправки.
        if (gluedFingerprints.has(fpKey(rawText))) {
            if (r) spoilerize(block, r, rawText);
            log('Это приклеенный нами [SYS] (эхо) — спойлер без отправки.');
            return;
        }

        if (!OPS_RE.test(rawText)) {
            log('SYS-блок без игровых тегов — пропущен.');
            return;
        }

        const turnMatch = rawText.match(/\[t:\s*(\d+)\]/);
        const isLive = block === blocks[blocks.length - 1];

        // ФИКС эхо-цикла: блоки БЕЗ [t:] не получают синтезированный ход
        if (!turnMatch) {
            if (r) spoilerize(block, r, rawText);
            log('SYS без [t:] — спойлер поставлен, в панель НЕ отправлен (защита от эха).');
            return;
        }
        const turn = parseInt(turnMatch[1]);

        if (r) spoilerize(block, r, rawText);

        // Классификация хода (v27). Профиль чата хранит ходы ПРОШЛОЙ игры:
        // новый [t: 1] после ходов 2..17 панель считает "устаревшим". Единственный
        // надежный признак новой игры — блок НИЖЕ последнего отправленного
        // (реплеи истории после F5 и блоки, догруженные скроллом, всегда ВЫШЕ).
        let newGame = false;
        if (turn < lastProcessedTurn) {
            const after = lastTurnBlock && lastTurnBlock.isConnected
                ? !!(lastTurnBlock.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING)
                : isLive;
            if (!after) {
                log(`Ход ${turn} старше ${lastProcessedTurn} и выше последнего — реплей/скролл, не отправляю.`);
                return;
            }
            newGame = true;
        } else if (turn === lastProcessedTurn && !isLive) {
            log(`Ход ${turn} равен текущему и не живой — реплей, не отправляю.`);
            return;
        }

        lastProcessedTurn = turn;
        lastTurnBlock = block;
        log(`Отправка SYS в панель. Ход: ${turn}${newGame ? ' (НОВАЯ ИГРА)' : ''}${isLive ? ' [live]' : ''}`);
        safeSend({ type: "NEW_SYS_BLOCK", turn: turn, text: rawText, chatId: getChatId(), live: isLive, newGame: newGame });
      }
      catch (e) {
        // ФИКС (v29): ошибка на ОДНОМ блоке не должна прерывать весь скан —
        // раньше падение на первом же кривом сообщении оставляло все
        // последующие (включая ход новой игры) необработанными навсегда.
        log(`Ошибка обработки блока #${idx}: ${e.message}`);
        console.error('[DeepSeek RPG] Ошибка обработки блока:', e);
      }
    });
    // v29: отдельно сканируем СООБЩЕНИЯ ПОЛЬЗОВАТЕЛЯ (старт игры, отправленный
    // игроком по просьбе ИИ) — они не имеют класса AI_BLOCK_SEL (.ds-markdown / .FuturisMarkdown)
    processUserSys();
}

// ============================================================
// СТАРТ ИГРЫ ОТ ИГРОКА (v29). ИИ-мастер просит игрока скопировать
// стартовый текст ([SYS] [t: 1] ...) и отправить его как ОБЫЧНОЕ СООБЩЕНИЕ.
// Такие блоки не имеют класса AI_BLOCK_SEL и раньше полностью выпадали из
// конвейера: ход 1 не применялся, панель застревала на прошлой игре.
// Правила безопасности:
//   - блоки ИИ (AI_BLOCK_SEL) исключены — обрабатываются отдельно;
//   - код (<pre>/<code>), наш HUD (#rpg-*), поле ввода и скрипты — исключены;
//   - без [t:] блок НЕ отправляется в панель (приклеенные нами логи-эхо
//     не содержат [t:] — защита от эхо-цикла работает и здесь);
//   - DOM пользователя НЕ изменяем (его текст остается видимым) — только
//     dataset-пометка против повторной отправки.
// ============================================================
let lastUserSysFound = 0;

// Ближайший общий предок двух узлов (для сборки текста пары, расползающейся
// по соседним <p> сообщения)
function commonAncestor(a, b) {
    if (a === b) return a.parentElement;
    const seen = new Set();
    for (let n = a; n; n = n.parentElement) seen.add(n);
    for (let n = b; n; n = n.parentElement) if (seen.has(n)) return n;
    return null;
}

function findUserSysPairs(rootEl) {
    const stop = rootEl || document.body;
    const walker = document.createTreeWalker(stop, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            let el = n.parentElement;
            while (el && el !== stop) {
                const tag = el.tagName;
                if (tag === 'CODE' || tag === 'PRE' || tag === 'TEXTAREA' || tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
                if (el.id && String(el.id).indexOf('rpg-') === 0) return NodeFilter.FILTER_REJECT;
                if (el.classList && (el.classList.contains(CFG.aiBlockClass) || el.classList.contains('sys-spoiler'))) return NodeFilter.FILTER_REJECT;
                if (el.getAttribute && el.getAttribute('contenteditable') === 'true') return NodeFilter.FILTER_REJECT;
                el = el.parentElement;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    const pairs = [];
    let start = null, startOffset = -1;
    let node;
    while ((node = walker.nextNode())) {
        const t = node.nodeValue || '';
        let i = t.indexOf('[SYS]');
        while (i !== -1) {
            if (isStandalone(t, i, 5)) { start = node; startOffset = i; }
            i = t.indexOf('[SYS]', i + 1);
        }
        if (!start) continue;
        const from = node === start ? startOffset + 5 : 0;
        let j = t.indexOf('[/SYS]', from);
        while (j !== -1) {
            if (isStandalone(t, j, 6)) {
                pairs.push({ startNode: start, startOffset, endNode: node, endOffset: j });
                start = null;
                break;
            }
            j = t.indexOf('[/SYS]', j + 1);
        }
    }
    return pairs;
}

function processUserSys() {
    let pairs;
    try { pairs = findUserSysPairs(document.body); }
    catch (e) { log('Ошибка findUserSysPairs: ' + e.message); return; }
    lastUserSysFound = pairs.length;

    for (const p of pairs) {
        try {
            const anchor = p.startNode.parentElement;
            if (!anchor || !anchor.isConnected) continue;

            // Пометка против повторной отправки (по адресату [SYS]);
            // '[u-skip]' — пара сразу отсечена вратами ниже
            const sig = '[u]' + p.startOffset + ':' + p.endOffset;
            if (anchor.dataset.sysProcessed === 'true' &&
                (anchor.dataset.sysSig === sig || anchor.dataset.sysSig === '[u-skip]')) continue;

            // v30, врата от «фантомных» пар (двойная НОВАЯ ИГРА / пинг-понг):
            // 1) якорь не должен лежать внутри верстки сообщения ИИ — цитаты
            //    нашего текста внутри ответа ИИ не проходят по предку,
            //    у которого в поддереве есть AI_BLOCK_SEL;
            // 2) паста игрока имеет смысл, только пока ИИ ЕЩЕ НЕ ОТВЕТИЛ
            //    (нет блока ИИ ниже). Иначе повторная встреча пасты сбрасывала
            //    lastProcessedTurn назад и вызывала двойные применения.
            let inAiRender = false;
            for (let el = anchor; el && el !== document.body; el = el.parentElement) {
                if (el.querySelector(AI_BLOCK_SEL)) { inAiRender = true; break; }
            }
            const aiBelow = [...document.querySelectorAll(AI_BLOCK_SEL)]
                .some(b => anchor.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
            if (inAiRender || aiBelow) {
                anchor.dataset.sysProcessed = 'true';
                anchor.dataset.sysSig = '[u-skip]';
                log('Пользовательский [SYS] — история (ИИ уже ответил или это цитата) — скип.');
                continue;
            }

            anchor.dataset.sysProcessed = 'true';
            anchor.dataset.sysSig = sig;

            // Текст пары: общий предок нужен, т.к. [SYS] и [/SYS] могут быть
            // в разных <p> одного сообщения
            const root = commonAncestor(p.startNode, p.endNode) || document.body;
            const rawText = extractSysText(root, p);
            const turnMatch = rawText.match(/\[t:\s*(\d+)\]/);
            if (!turnMatch) {
                log('Пользовательский [SYS] без [t:] — пропущен (защита от эха).');
                continue;
            }
            const turn = parseInt(turnMatch[1]);

            // live: блок — последний в чате (после него нет ни одного блока ИИ
            // и он — последняя пользовательская пара)
            let isLive = ![...document.querySelectorAll(AI_BLOCK_SEL)]
                .some(b => anchor.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
            if (isLive) {
                const later = pairs.some(q =>
                    q !== p && q.startNode.parentElement &&
                    (anchor.compareDocumentPosition(q.startNode.parentElement) & Node.DOCUMENT_POSITION_FOLLOWING));
                if (later) isLive = false;
            }

            // Та же классификация, что у блоков ИИ (реплеи/новая игра)
            let newGame = false;
            if (turn < lastProcessedTurn) {
                const after = lastTurnBlock && lastTurnBlock.isConnected
                    ? !!(lastTurnBlock.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING)
                    : isLive;
                if (!after) {
                    log(`Пользовательский ход ${turn} старше ${lastProcessedTurn} и выше последнего — реплей, скип.`);
                    continue;
                }
                newGame = true;
            } else if (turn === lastProcessedTurn && !isLive) {
                log(`Пользовательский ход ${turn} равен текущему и не живой — скип.`);
                continue;
            }

            lastProcessedTurn = turn;
            lastTurnBlock = anchor;
            log(`Пользовательский SYS → панель. Ход: ${turn}${newGame ? ' (НОВАЯ ИГРА)' : ''}${isLive ? ' [live]' : ''}`);
            safeSend({ type: "NEW_SYS_BLOCK", turn: turn, text: rawText, chatId: getChatId(), live: isLive, newGame: newGame });
        }
        catch (e) {
            log('Ошибка обработки пользовательского [SYS]: ' + e.message);
            console.error('[DeepSeek RPG] Ошибка пользовательского [SYS]:', e);
        }
    }
}

const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processAndSend, 1000);
});
observer.observe(document.body, { childList: true, subtree: true, characterData: true });
processAndSend();

// ============================================================
// HUD НА СТРАНИЦЕ: очередь логов над полем ввода + кнопки
// (Баг 2: логи и промпт переехали из панели прямо в чат)
// ============================================================

// Промпт — ЕДИНСТВЕННАЯ копия живет здесь (дубль в sidepanel/main.js удален,
// кнопка переехала в HUD). При изменении править только этот блок.
const PROMPT_TEXT = `Ты — движок текстовой RPG. Веди игру, используя строгий формат.

## ФОРМАТ
В конце КАЖДОГО своего сообщения добавляй системный блок, обернутый в [SYS] и [/SYS]. Все теги — только внутри блока, каждый тег с НОВОЙ строки. Текст вне блока — обычный нарратив для игрока. Имена счетчиков/предметов/целей пиши одинаково каждый раз (панель терпима к регистру и ё/е, но одинаковые имена дают чистые отчеты).

## ХОДЫ
[t: N] - Номер хода, ОБЯЗАТЕЛЕН в каждом блоке: первый ход [t: 1], дальше +1 за каждый свой ответ. Блок без [t:] расширение игнорирует.
- Игрок просит перегенерировать ответ → оставь N ПРЕЖНИМ: расширение само откатит эффекты прошлого ответа этого хода.
- Игрок начинает заново → снова [t: 1]: расширение распознает новую игру и сбросит состояние.

## ОТЧЕТЫ "# RPG:"
Строки "# RPG: ..." в сообщении игрока — отчеты расширения об УЖЕ ПРИМЕНЁННЫХ изменениях (или ответ на твой [query:]). НЕ повторяй эти дельты своими тегами — повтор = двойное применение. Читай их как факт: "применено: 50 → 40" значит здоровье уже 40; "КЛАМП: применено -40 (40 → 0)" значит дельта урезана границей. Увидел "# RPG: ⚠ не распознано: ..." → исправь ошибочный тег в следующем блоке.

## ВРЕМЯ И КАЛЕНДАРЬ
[tm: 14:00, 15.11.2026, Сб] - Установить время (ЧЧ:ММ, Дата, День недели). Дата — ЛЮБАЯ строка: реальная "15.11.2026" (пересчитывается автоматически) или фэнтезийная "Мороз 4, 4Э 201" / "3-й день Эры Тьмы" (сохраняется как есть). Фэнтезийная дата может содержать запятые: [tm: 21:00, Мороз 30, 4Э 201, Сондас]. Арифметика минут (ЧЧ:ММ) работает всегда.
[td: 2h] - Прибавить время: 30m, 2h, 1h30m, 2d. Пересчитываются время, дата и день недели: реальная дата — календарной арифметикой; фэнтезийная — увеличивается число дня ("Мороз 4" → "Мороз 6"), день недели берется из списка календаря, а переход через полночь сдвигает и фэнтезийный день ("3-й день" → "4-й").
[cal: Скайрим] - Задать КАЛЕНДАРЬ МИРА. Достаточно одного раза — календарь сохраняется и переживает [tm:]. Варианты:
  - пресет: [cal: Скайрим] (7 дней недели: Морндас...Сондас + 12 месяцев по 30 дней);
  - свой: дни через запятую, после | — ТАБЛИЦА МЕСЯЦЕВ: [cal: Дож, Плаж | Урожая:31, месяца закона/28, Месяц любви - 14]. Формат месяца: "Имя:Дни", "Имя/Дни" или "Имя - Дни"; голое число — безымянный месяц по порядку ("31, 28" → "1-й месяц", "2-й месяц"); голое имя — месяц по умолчанию 30 дней.
  Если дата сейчас реальная (ДД.ММ.ГГГГ), она АВТОМАТИЧЕСКИ переводится в формат мира ("16.11.2026" → "Закат Солнца 20, 2026"), день недели — по списку. Дальше [td: Nd] вращает месяцы по ИХ ДЛИНАМ. [cal: сброс] — вернуть реальный формат.

## СЧЕТЧИКИ
[c: Мана, 50, 100] - Создать/перезаписать счетчик (Имя, Текущее[, Макс]). ВНИМАНИЕ: повторный [c:] для существующего имени СБРОСИТ значение на указанное — для ИЗМЕНЕНИЯ используй [cd:]. Стартовые счетчики (Здоровье, Мана, Золото...) создавай один раз в начале игры.
[cd: Мана, -10] - Изменить счетчик (Имя, Дельта +/-). Изменения клампятся по 0 и Максу; отчет придет в "# RPG: ... применено: 50 → 40".
Необязательные параметры (через запятую после значения или Макс):
  - "Тип: bar" — полоска (по умолчанию); "Тип: text" — число без полоски; "Тип: time" — строка времени ("14:30"; менять только повторным [c:]); "Тип: enemy" — враг, красная полоска.
  - "Группа: Имя" — счетчики одной Группы встают в один компактный ряд.
  Примеры: [c: Главарь патруля, 40, 40, Тип: enemy] [c: HP, 50, 100, Тип: bar, Группа: Тело]
[c: Опыт, 450, Разбивка: Уровень:100+50] - ТАБЛИЦА РАЗБИВОК: значение хранится в базовых единицах, панель и отчеты показывают в мировых. "Уровень:100" — порог всегда 100; "Уровень:100+50" — каждый следующий уровень дороже на 50 (100, 150, 200...); "Уровень:100×2" — каждый следующий в 2 раза дороже (100, 200, 400...) — так делается растущая цена уровней. Цепочка юнитов через |: [c: Время, 855, Разбивка: Час:60|Сутки:24] → "14 Час 15". Отчеты дублируют итог в мировых единицах: "применено: 450 → 510 (5 Уровень 10)". НЕ создавай отдельный счетчик "Уровень" — он вычисляется из опыта сам.
[c: Дата, 44, Календарь: Урожая:31|Закона:28|Любви:14] - СЧЕТЧИК-ДАТА: значение — сколько дней прошло с начала годового цикла; панель показывает месяц и день ("44" → "Закона 14"), после последнего месяца цикл начинается заново ("Год 1, Урожая 1"). Голые числа — месяцы по порядку ("1-й месяц"). [cd: Дата, +1] = +1 день: продвинул сюжет на сутки → и [td: 1d], и [cd: Дата, +1].
[r: Стамина, <=0, Здоровье, -10] - Правило между счетчиками (Источник, Условие, Цель, Дельта): как только условие над источником выполнено, к цели применяется дельта. Условия: <=0, >=5, <, >, ==. Правила накапливаются и тегом не удаляются (точные копии дедуплицируются) — закладывай их один раз.

## ПРЕДМЕТЫ И ВКЛАДКИ
[tab: Заклинания, Сотворить, Мана:10] - Вкладка (Имя, Ключ-действие, Стоимость). Повторный [tab:] с тем же именем перезаписывает вкладку.
[i: Револьвер, Tab: Оружие, Урон: 10, Патроны: 6/6] - Предмет (свойства "Свойство: значение" через запятую; "N/M" — значение/максимум). Для СУЩЕСТВУЮЩЕГО имени свойства ДОПОЛНЯЮТСЯ/обновляются — удобно для апгрейдов и изменения инвентаря.
  - Кошелек: [i: Кошелек, Tab: Инвентарь, Золото: 50] — деньги как свойство; траты: [iu: Кошелек, Золото, -10].
  - Индивидуальная цена: действие вкладки тратит цену вкладки, НО если у предмета есть СВОЕ плоское числовое свойство с тем же именем ([i: Спрятаться, Tab: Действия, Энергия: 4]) — тратится оно вместо базовой цены.
[iu: Револьвер, Патроны, -1] - Изменить ЧИСЛОВОЕ свойство предмета (Имя, Свойство, Дельта). Кламп по 0/max; после изменения срабатывают автоправила предмета.
[ir: Стальной меч, Прочность, <=0, break] - Автоправило предмета (Имя, Свойство, Условие, Действие). Действие: break (предмет удаляется) или spawn: Имя (предмет заменяется другим): [ir: Яйцо дракона, Вылупление, <=0, spawn: Дракончик].

## СТАТУСЫ
[status: Агент Алой Кнешин 1, Горит, 3 хода] - Статус/состояние цели (Цель, Эффект, Значение) — панель покажет чипом. Повтор по паре Цель+Эффект ОБНОВЛЯЕТ значение. Снять: [status: Агент Алой Кнешин 1, Горит, снят] (или значение "0"). Значение — любой текст ("3 хода", "до утра").

## СОБЫТИЯ
[timer: Письмо, +2d, [msg: Пришло письмо!] /// [i: Письмо, Tab: Инвентарь]] - Отложенное событие (ID, Время, Команды). Команды пишутся ВСЕ В ОДНУ СТРОКУ через " /// ". Время: +2d, +5h, +30m, +1h30m или точное "25.11.2026 14:00". Повторный тег с тем же ID перезаписывает таймер (правка планов). Расширение САМО исполнит команды, когда игровое время дойдет до точки, — тебе не нужно помнить дедлайны, но периодически [query: all], чтобы видеть, что запланировано.

## СЛУЖЕБНОЕ
[query: all] - Запросить состояние: all, counters или inventory. Отчет "# RPG: INFO: ..." придет к следующему сообщению игрока (инвентарь группируется по вкладкам: "[Инвентарь: Меч] [Оружие: Револьвер (Патроны: 6/6)]"). НЕ чаще одного раза за ход.
[msg: Утром в дверь постучали] - Заметка игроку (придет как "# RPG: 📣 ...").
[rm: Ржавый меч] - Удалить счетчик, вкладку или предмет по имени (имя строго внутри скобок, комментарии пиши после тега). Правила и таймеры тегом не удаляются.
[ROLL: d20, Result: 15] - Бросок, который СДЕЛАЛ ИГРОК: результат бери из его сообщения, не выдумывай.
[ROLL: 2d6] - Бросок БЕЗ Result: ты хочешь, чтобы игрок бросил сам. Расширение вставит результат в поле ввода, игрок отправит его сам. ЖДИ результат и не запрашивай новый бросок, пока не получил предыдущий.

## ПРИМЕР ОТВЕТА
Гоблин выбегает из кустов и бьет вас дубиной. Вы теряете 12 здоровья.
[SYS]
[t: 1]
[tm: 21:00, 15.11.2026, Сб]
[c: Здоровье, 88, 100]
[c: Мана, 30, 30, Группа: Тело]
[c: Золото, 25]
[cd: Здоровье, -12]
[i: Дубина гоблина, Tab: Инвентарь, Урон: 12]
[/SYS]

Начни игру. Опиши стартовую локацию, создай стартовые счетчики (Здоровье, Мана, Золото) и выдай игроку инвентарь. t=1.`;

const HUD_BTN = 'background:#2b3240; color:#cdd3de; border:1px solid #3a4150; border-radius:6px; padding:3px 8px; cursor:pointer; font-size:12px;';

let hud = null;
let currentLogs = [];

// Обобщенный бросок NdM: d20, d6, 2d6, 3d8... (лимиты: макс 10 кубиков,
// макс 1000 граней — защита от "999d999" из сломанного тега)
function rollDice(spec) {
    const m = String(spec || '').trim().match(/^(\d*)d(\d+)$/i);
    if (!m) return null;
    const count = Math.min(parseInt(m[1] || '1', 10), 10);
    const sides = parseInt(m[2], 10);
    if (!sides || sides < 1 || sides > 1000) return null;
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
    const sum = rolls.reduce((a, b) => a + b, 0);
    const breakdown = count > 1 ? ` (${rolls.join('+')})` : '';
    return `[ROLL: ${spec}, Result: ${sum}${breakdown}]`;
}

// Вставка тега броска. v30: НИКОГДА не отправляем сами. Бросок попадает
// в поле ввода, а сообщение отправляет ИГРОК своим Enter — заодно перехват
// приклеит накопленные логи. Автосообщение по запросу ИИ превращало игру
// в цикл (ИИ просит бросок → автоотправка → ИИ отвечает и просит снова)
// и грозило блокировкой за частые сообщения.
function insertRollText(text) {
    if (!insertOnlyText(text)) return;
    log('Результат вставлен в поле ввода — отправишь сам (Enter).');
}

// Вставка текста БЕЗ отправки (учитывает и contenteditable)
function insertOnlyText(text) {
    const input = getInput();
    if (!input) return false;
    if (input.tagName === 'TEXTAREA') {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        const cur = input.value.trim();
        nativeSetter.call(input, cur ? cur + '\n\n' + text : text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
        input.focus();
        const sep = input.textContent.trim() ? '\n\n' : '';
        if (!document.execCommand('insertText', false, sep + text)) {
            input.textContent += sep + text; // фолбэк
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
    input.focus();
    return true;
}

// Приклейка [SYS]-логов к тексту поля (без очистки текста игрока)
function appendSysToInput(input) {
    if (!input) return;
    const sysBlock = `\n\n[SYS]\n${currentLogs.join('\n')}\n[/SYS]`;
    if (input.tagName === 'TEXTAREA') {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeSetter.call(input, input.value + sysBlock);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
        input.focus();
        if (!document.execCommand('insertText', false, sysBlock)) {
            input.textContent += sysBlock;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
    log(`Приклеено логов: ${currentLogs.length}`);
    // Запоминаем отпечаток ВНУТРЕННЕГО текста (extractSysText вернет именно его,
    // когда блок-эхо появится в DOM) — ФИКС двойного применения дельт
    rememberFingerprint(currentLogs.join('\n'));
    currentLogs = [];
    renderHud();
    safeSend({ type: "CLEAR_LOGS" });
}

function buildHud() {
    const el = document.createElement('div');
    el.id = 'rpg-hud';
    el.style.cssText = 'background:#1b1f27; border:1px solid #3a4150; border-radius:8px; margin:6px auto; padding:8px 10px; font-family:monospace; font-size:12px; color:#cdd3de;';
    el.innerHTML = `
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
            <details id="rpg-hud-details" style="flex:1; min-width:180px;">
                <summary id="rpg-hud-logs" style="cursor:pointer; color:#7cb342;">📦 Логи: 0</summary>
                <div id="rpg-hud-loglist" style="white-space:pre-wrap; color:#9aa4b0; margin-top:4px; max-height:120px; overflow:auto;"></div>
            </details>
            <button data-rpg="prompt" style="${HUD_BTN}" title="Вставить стартовый промпт">📋 Промпт</button>
            <button data-rpg="d20" style="${HUD_BTN}" title="Бросок d20">🎲 d20</button>
            <button data-rpg="d6" style="${HUD_BTN}" title="Бросок d6">🎲 d6</button>
            <button data-rpg="2d6" style="${HUD_BTN}" title="Бросок 2d6">🎲 2d6</button>
            <button data-rpg="clear" style="${HUD_BTN}" title="Очистить очередь логов">✕</button>
        </div>`;
    el.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const act = btn.dataset.rpg;
        if (act === 'prompt') {
            insertOnlyText(PROMPT_TEXT);
            log('Промпт вставлен в поле ввода.');
        } else if (act === 'd20' || act === 'd6' || act === '2d6') {
            insertRollText(rollDice(act));
        } else if (act === 'clear') {
            currentLogs = [];
            renderHud();
            safeSend({ type: "CLEAR_LOGS" });
        }
    });
    return el;
}

function renderHud() {
    if (!hud) return;
    const det = hud.querySelector('#rpg-hud-details');
    const sum = hud.querySelector('#rpg-hud-logs');
    const list = hud.querySelector('#rpg-hud-loglist');
    if (!det) return;
    sum.textContent = `📦 Логи: ${currentLogs.length}`;
    // Компактный режим: details закрыт по умолчанию (никогда не раскрываем
    // сами) — HUD не разрастается, почитать можно кликом по summary
    list.textContent = currentLogs.join('\n') || '(пусто)';
}

function ensureHud() {
    const input = getInput();
    if (!input) {
        if (hud && hud.isConnected) { hud.remove(); log('HUD снят: поле ввода пропало.'); }
        return;
    }
    if (hud && hud.isConnected) { renderHud(); return; }
    if (!hud) hud = buildHud();
    // Контейнер поля ввода: поднимаемся до узла, в котором есть кнопки (ряд отправки)
    let c = input.parentElement;
    for (let i = 0; i < 5 && c && c !== document.body; i++) {
        if (c !== input && c.querySelector('button, [role="button"]')) break;
        c = c.parentElement;
    }
    const anchor = (c && c !== document.body) ? c : input;
    if (anchor.parentNode) {
        anchor.parentNode.insertBefore(hud, anchor);
        renderHud();
        log('HUD установлен над полем ввода.');
    }
}
setInterval(ensureHud, 1500);
ensureHud();

// ============================================================
// ПЕРЕХВАТ ОТПРАВКИ (Баг 1)
// v24 ловил только e.target.tagName === 'TEXTAREA' — если DeepSeek
// рендерит contenteditable, перехват молча не срабатывал.
// Теперь поле ищется через closest() по трем признакам.
// ============================================================
window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const input = e.target.closest && e.target.closest('textarea, [contenteditable="true"], [role="textbox"]');
    if (!input || input.closest('#rpg-hud')) return;
    if (currentLogs.length === 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    appendSysToInput(input);
    // Свежий Enter для обработчиков сайта (наш preventDefault их остановил)
    setTimeout(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }, 50);
}, true);

// Клик по кнопке отправки: кнопка должна лежать рядом с полем ввода
// (до 6 уровней контейнера), наши HUD-кнопки исключены.
document.addEventListener('click', (e) => {
    if (currentLogs.length === 0) return;
    const btn = e.target.closest && e.target.closest('button, [role="button"]');
    if (!btn || btn.closest('#rpg-hud')) return;
    const input = getInput();
    if (!input || !inputHasText(input)) return;
    let el = btn.parentElement, near = false;
    for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
        if (el.contains(input)) { near = true; break; }
    }
    if (!near) return;
    log('Перехвачен клик по кнопке отправки — приклеиваю логи.');
    appendSysToInput(input);
}, true);

// ============================================================
// ДИАГНОСТИКА (ручные ручки для консоли DeepSeek:
//   __rpg.rescan() — пересканировать SYS
//   __rpg.diagnostics() — состояние
//   __rpg.setLogs(['[cd: HP, -10]']) — вручную наполнить очередь (тест перехвата)
//   __rpg.peekLogs() — что в очереди сейчас
// )
// ============================================================
function getDiagnostics() {
    const blocks = [...document.querySelectorAll(AI_BLOCK_SEL)];
    const input = getInput();
    return {
        site: SITE,
        chatId: getChatId(),
        lastProcessedTurn: lastProcessedTurn,
        lastTurnBlockConnected: !!(lastTurnBlock && lastTurnBlock.isConnected),
        spoilersInDom: document.querySelectorAll(`${AI_BLOCK_SEL} details.sys-spoiler`).length,
        pendingLogs: currentLogs.length,
        blocksTotal: blocks.length,
        sysProcessed: blocks.filter(b => b.dataset.sysProcessed === 'true').length,
        userSysFound: lastUserSysFound,
        inputFound: !!input,
        inputTag: input ? input.tagName : 'НЕ НАЙДЕНО',
        hudInstalled: !!(hud && hud.isConnected),
        logs: debugLogs.slice(-40)
    };
}

window.__rpg = {
    rescan: processAndSend,
    diagnostics: getDiagnostics,
    setLogs: (arr) => { currentLogs = arr.slice(); renderHud(); log('Очередь логов установлена вручную: ' + currentLogs.length); },
    peekLogs: () => [...currentLogs]
};

// --- Сообщения от панели ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "LOG_UPDATE") {
        currentLogs = message.logs;
        renderHud();
    }
    if (message.type === "CLEAR_LOGS") {
        currentLogs = [];
        renderHud();
    }

    if (message.type === "DIAGNOSTICS") {
        sendResponse(getDiagnostics());
        return;
    }

    if (message.type === "SEND_DEBUG_TO_CHAT") {
        const input = getInput();
        if (input) {
            const debugText = `[SYS]\n[DEBUG_LOG]\n${debugLogs.length > 0 ? debugLogs.join('\n') : "Ошибок не найдено."}\n[/DEBUG_LOG]\n[/SYS]`;
            // v30: только вставка — Enter жмет игрок (без автоотправки)
            insertOnlyText(debugText);
            debugLogs = [];
            log("Логи вставлены в поле ввода — отправь сообщение сам (Enter).");
        } else {
            alert("Не найдено поле ввода на странице! Загляни в 🐞 Логи панели: там будет inputTag.");
        }
    }

    // Полная пересылка истории: чистим пометки обработки и отпечатки эха,
    // сканируем заново. Панель сама отсортирует устаревшие ходы, а блок
    // новой игры (ниже последнего) сбросит состояние.
    if (message.type === "RESYNC") {
        // [data-sys-processed] — и блоки ИИ, и пользовательские (v29)
        document.querySelectorAll('[data-sys-processed]').forEach(b => {
            delete b.dataset.sysProcessed;
            delete b.dataset.sysSig;
        });
        gluedFingerprints.clear();
        lastProcessedTurn = 0;
        lastTurnBlock = null;
        log('RESYNC: все блоки будут пересканированы.');
        processAndSend();
    }

    if (message.type === "INSERT_TEXT") {
        // ВСТАВКА С ДОБАВЛЕНИЕМ (не затирает старый текст)
        insertOnlyText(message.text);
    }

    // v31, кнопка «Вставить в чат» панели: приклеить накопленные логи к полю
    // ввода через appendSysToInput — тот же путь, что и при перехвате отправки:
    // отпечаток против эхо-повтора, очистка очереди, CLEAR_LOGS панели.
    // Сообщение отправляет ИГРОК своим Enter — инвариант без автоотправки.
    if (message.type === "SEND_LOGS_TO_INPUT") {
        const input = getInput();
        if (input && currentLogs.length > 0) {
            appendSysToInput(input);
            log(`Логи панели вставлены в поле ввода (${currentLogs.length === 0 ? 'очередь очищена' : 'ждут'}).`);
        }
    }

    // Баг 2: ИИ запросил бросок ([ROLL: d20] без Result в его SYS-блоке).
    // Панель разрулила live-флаг, сюда приходит уже одобренный бросок —
    // бросаем сами и отправляем результат в чат.
    if (message.type === "AI_ROLL") {
        const text = rollDice(message.spec);
        if (text) {
            log(`ИИ запросил бросок ${message.spec} → ${text}`);
            insertRollText(text);
        }
    }
});
