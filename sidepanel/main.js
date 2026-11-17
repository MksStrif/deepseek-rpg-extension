// main.js — v3.7
// ФИКС «панель некликабельна»: раньше обработчики кнопок навешивались ПОСЛЕ
// async-инициализации. Любое исключение в initProfile/updateUI/renderLogs
// (например, счетчик с пробелом в имени ронял querySelector в ui.js) убивало
// ВСЕ кнопки панели навсегда — пользователь видел интерфейс, но клики не работали.
// Теперь:
//   1) журнал ошибок и ВСЕ обработчики навешиваются первыми, синхронно;
//   2) инициализация идет в try/catch — любая ошибка видна в «🐞 Логи»;
//   3) window.onerror / unhandledrejection тоже попадают в журнал (и раскрывают его);
//   4) «Сброс» подтверждается повторным кликом по самой кнопке — нативный
//      confirm() в side-панели может подавляться браузером (Yandex Browser).
document.addEventListener('DOMContentLoaded', () => {
    // --- База отладки: журнал событий + диагностика контент-скрипта ---
    const area = document.getElementById('debug-area');
    const debugJournal = [];
    let lastDiagnostics = null;
    // v3.8: последний ПРИМЕНЕННЫЙ ход + сигнатура операций. Один и тот же блок
    // доходит до панели ДВАЖДЫ (напрямую от контент-скрипта + реле от background),
    // а стриминг теряет dataset-пометки и контент-скрипт пересылает блок заново.
    // Без дедупа: двойные применения, ДВА кубика на один запрос ИИ и задвоенные
    // строки "# RPG:" в приклеиваемых логах.
    let lastApplied = null;

    function journal(text) {
        debugJournal.unshift(`[${new Date().toLocaleTimeString()}] ${text}`);
        if (debugJournal.length > 120) debugJournal.pop();
        renderDebugArea();
    }

    function renderDebugArea() {
        if (!area || area.hidden) return;
        let out = debugJournal.join('\n');
        if (lastDiagnostics) {
            const lines = Object.entries(lastDiagnostics)
                .map(([k, v]) => `  ${k}: ${Array.isArray(v) ? (v.length ? v.join(' | ') : '(пусто)') : v}`)
                .join('\n');
            out += `\n\n── Диагностика контент-скрипта ──\n${lines}`;
        } else {
            out += '\n\n(диагностика не запрошена — открой чат и нажми 🐞 Логи ещё раз)';
        }
        area.textContent = out;
    }

    // Любая ошибка панели должна быть ВИДНОЙ, а не «кнопки молча не работают»
    function showDebugError(where, err) {
        const msg = (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err);
        console.error('[RPG panel]', where, err);
        if (area && area.hidden) area.hidden = false;
        journal(`❌ ОШИБКА [${where}]: ${msg}`);
    }

    window.addEventListener('error', (e) =>
        showDebugError('window.onerror ' + (e.filename || '') + ':' + (e.lineno || ''), e.error || e.message));
    window.addEventListener('unhandledrejection', (e) => showDebugError('promise', e.reason));

    // --- ВСЕ обработчики кнопок — первыми, до любой async-инициализации ---

    // 🐞 Логи: раскрывает журнал + запрашивает диагностику контент-скрипта.
    // (Больше не льет логи в чат молча — для этого «📤 В чат».)
    document.getElementById('debug-btn').onclick = async () => {
        area.hidden = !area.hidden;
        if (!area.hidden) {
            journal('Клик: 🐞 Логи. Запрос диагностики...');
            try {
                lastDiagnostics = await chrome.runtime.sendMessage({ type: "DIAGNOSTICS" });
            } catch (e) {
                lastDiagnostics = { error: String(e) + ' — обнови страницу чата (F5)' };
            }
            renderDebugArea();
        }
    };

    // 📤 В чат: [SYS][DEBUG_LOG] ВСТАВЛЯЕТСЯ в поле ввода; отправляет игрок (v30)
    document.getElementById('debug-send-btn').onclick = () => {
        try {
            chrome.runtime.sendMessage({ type: "SEND_DEBUG_TO_CHAT" });
            journal('Логи вставлены в поле ввода — отправь сообщение сам (Enter).');
        } catch (e) { showDebugError('debug-send', e); }
    };

    // 🗑️ Сброс: ДВУХШАГОВОЕ подтверждение. Первый клик «взводит» кнопку,
    // второй (в течение 5 сек) выполняет сброс + пересканирование чата.
    let resetArmed = false;
    let resetTimer = null;
    const resetBtn = document.getElementById('reset-btn');
    resetBtn.onclick = () => {
        if (!resetArmed) {
            resetArmed = true;
            resetBtn.textContent = '❗ Точно?';
            resetBtn.classList.add('active');
            journal('Сброс взведен: нажми «Точно?» ещё раз в течение 5 сек.');
            resetTimer = setTimeout(() => {
                resetArmed = false;
                resetBtn.textContent = '🗑️ Сброс';
                resetBtn.classList.remove('active');
            }, 5000);
            return;
        }
        clearTimeout(resetTimer);
        resetArmed = false;
        resetBtn.textContent = '🗑️ Сброс';
        resetBtn.classList.remove('active');
        try {
            resetState();
            chrome.runtime.sendMessage({ type: "RESYNC" });
            journal('Сброс + пересканирование чата запущены.');
        } catch (e) { showDebugError('reset', e); }
    };

    // 🧽 Ластик
    document.getElementById('eraser-btn').onclick = () => {
        isEraserMode = !isEraserMode;
        document.getElementById('eraser-btn').classList.toggle('active', isEraserMode);
        document.body.classList.toggle('eraser-mode', isEraserMode);
        if (isEraserMode) { selectedItem = null; selectedCounter = null; updatePreview(); }
        journal('Ластик: ' + (isEraserMode ? 'ВКЛ (кликай по лишнему)' : 'выкл'));
    };

    // 🍪 Куки (v4.3): экспорт сессии Google в буфер обмена — перенос входа
    // в TextWorld Browser (там кнопка 📥 импортирует их в сессию persist:chat).
    // Google блокирует свой логин во встраиваемых браузерах, а готовые куки
    // проверок не проходят — сессия просто «уже есть».
    document.getElementById('cookie-export-btn').onclick = () => {
        if (!chrome.cookies || !chrome.cookies.getAll) {
            journal('🍪 Куки: API недоступен — расширение установлено без permission "cookies"?');
            return;
        }
        const domains = ['google.com', 'youtube.com'];
        const jobs = domains.map(d => new Promise(res => chrome.cookies.getAll({ domain: d }, cs => res(cs || []))));
        Promise.all(jobs).then(lists => {
            const seen = new Set();
            const cookies = [];
            lists.flat().forEach(c => {
                const key = c.domain + '|' + c.path + '|' + c.name;
                if (seen.has(key)) return;
                seen.add(key);
                cookies.push({
                    name: c.name, value: c.value, domain: c.domain, path: c.path,
                    expirationDate: c.expirationDate, secure: c.secure, httpOnly: c.httpOnly,
                    sameSite: c.sameSite || 'unspecified'
                });
            });
            const payload = JSON.stringify({ type: 'twb-google-cookies', cookies });
            navigator.clipboard.writeText(payload).then(() => {
                journal(`🍪 Скопировано ${cookies.length} кук Google — в прототипе жми 📥 в тулбаре.`);
            }).catch(() => {
                journal('🍪 Не смог записать в буфер — кликни кнопку ещё раз.');
            });
        });
    };

    // «Вставить в чат» (v3.9): отправляет НАКОПЛЕННЫЕ ЛОГИ в поле ввода.
    // Действия вставляются сразу по клику на предмет (ui.js) — кнопка им
    // больше не нужна. sendQueuedLogs возвращает false, если логов нет.
    document.getElementById('send-btn').onclick = () => {
        try {
            if (!sendQueuedLogs()) return;
            journal('Логи идут в поле ввода — отправь сообщение сам (Enter).');
        } catch (e) { showDebugError('send', e); }
    };

    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === "CLEAR_LOGS") {
            logQueue = [];
            renderLogs();
            updatePreview();
            journal('Логи приклеены к полю ввода — очередь очищена.');
        }

        if (message.type === "NEW_SYS_BLOCK") {
            // Ошибка обработки одного блока не должна ломать следующие
            try { handleSysBlock(message); }
            catch (e) { showDebugError('NEW_SYS_BLOCK (ход ' + (message && message.turn) + ')', e); }
        }
    });

    // Профиль чата: content.js присылает фактический chatId со своего location,
    // поэтому панель всегда работает с состоянием именно того чата, откуда событие.
    async function handleSysBlock(message) {
        if (message.chatId && message.chatId !== currentProfileId) {
            journal(`Профиль чата: ${currentProfileId} -> ${message.chatId}`);
            await loadProfile(message.chatId);
            lastApplied = null; // профиль сменился — старая сигнатура недействительна
        }

        const { ops, warnings } = parseSysBlock(message.text);
        const live = !!message.live;

        const turnOp = ops.find(o => o.type === 'turn');
        if (!turnOp) {
            journal(`SYS: тег [t] не найден (${ops.length} оп.) — блок пропущен`);
            return;
        }

        const incomingTurn = turnOp.id;
        console.log(`[Panel] Ход из чата: ${incomingTurn}, Текущий: ${history.currentTurn}, live: ${live}, newGame: ${!!message.newGame}`);

        // v3.8: дедуп повторной доставки — одинаковый ход с одинаковыми
        // операциями подряд пропускаем целиком (включая броски и warnings)
        const opsSig = JSON.stringify(ops);
        if (lastApplied && lastApplied.turn === incomingTurn && lastApplied.sig === opsSig) {
            journal(`SYS: ход ${incomingTurn} — дубликат доставки, пропущен`);
            return;
        }

        // Предупреждения парсера — агенту в отчет (только для живых ходов,
        // чтобы реплеи истории после F5 не спамили старыми опечатками)
        if (live && warnings.length) {
            warnings.forEach(w => addLog(`# RPG: ⚠ не распознано: ${w}`));
            journal(`SYS: ${warnings.length} поврежденных тегов — отчет отправлен ИИ`);
        }

        // НОВАЯ ИГРА в том же чате: профиль хранит ходы прошлой игры (например,
        // currentTurn 17), а ИИ снова начал с [t: 1]. Без сброса такой ход
        // навсегда считался бы "устаревшим" и игра не начиналась. Флаг newGame
        // присылает content.js (блок НИЖЕ последнего обработанного);
        // live-проверка — страховка на случай, если позицию определить не удалось.
        if (message.newGame || (live && incomingTurn < history.currentTurn)) {
            const prevTurn = history.currentTurn;
            const fresh = defaultState();
            gameState = fresh.gameState;
            history = fresh.history;
            favorites = new Set();
            logQueue = [];
            journal(`SYS: 🆕 НОВАЯ ИГРА (ход ${incomingTurn}, в профиле был ${prevTurn}) — состояние сброшено`);
            renderLogs();
        }

        if (incomingTurn > history.currentTurn) {
            // Новый ход: снимок текущего состояния для возможного отката
            history.lastTurnSnapshot = JSON.parse(JSON.stringify(gameState));
            history.currentTurn = incomingTurn;
            applyOps(ops, live);
            lastApplied = { turn: incomingTurn, sig: opsSig };
            saveState(); updateUI(); renderLogs();
            journal(`SYS: ход ${incomingTurn} — НОВЫЙ, применен (${ops.length} оп.)`);
        }
        else if (incomingTurn === history.currentTurn) {
            // Перегенерация: откат к снимку и повторное применение.
            // v4.3: каскадные таймеры (созданные ВНУТРИ исполнения прошлого
            // применения) в снапшот не попадают — возвращаем их после отката.
            if (history.lastTurnSnapshot) {
                const cascadeTimers = Array.isArray(gameState.timers) ? gameState.timers.slice() : [];
                gameState = JSON.parse(JSON.stringify(history.lastTurnSnapshot));
                mergeTimersAfterRollback(cascadeTimers);
            }
            applyOps(ops, live);
            lastApplied = { turn: incomingTurn, sig: opsSig };
            saveState(); updateUI(); renderLogs();
            journal(`SYS: ход ${incomingTurn} — ПЕРЕГЕНЕРАЦИЯ, откат + применение (${ops.length} оп.)`);
        }
        else {
            // incomingTurn < history.currentTurn — устаревший реплей: игнорируем
            journal(`SYS: ход ${incomingTurn} — устарел (текущий ${history.currentTurn}), игнор`);
        }

        // Броски по запросу ИИ ([ROLL: d20] без Result) — только для живых ходов
        if (live) {
            ops.filter(o => o.type === 'roll').forEach(o => {
                journal(`SYS: ИИ запросил бросок ${o.spec}`);
                chrome.runtime.sendMessage({ type: "AI_ROLL", spec: o.spec });
            });
        }
    }

    // --- Инициализация ПОСЛЕДНЕЙ, под защитой try/catch ---
    (async () => {
        try {
            await initProfile();
            updateUI();
            renderLogs();
            journal('Панель инициализирована. Профиль: ' + currentProfileId);
        } catch (e) {
            showDebugError('init', e);
        }
    })();
});
