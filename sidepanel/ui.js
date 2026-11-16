// ui.js
let isEraserMode = false;
let selectedItem = null;
let selectedCounter = null; // v4.0: выделенный счетчик-цель

// Экранирование имени для innerHTML: символы < > & " в имени счетчика
// или вкладки ломали верстку строки рендера
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// v4.0: чипы статусов из [status: Цель, Эффект, Значение].
// Клик — вставка цели [Цель] в поле ввода; ластик — снятие статуса.
function renderStatuses() {
    const bar = document.getElementById('status-bar');
    if (!bar) return;
    bar.innerHTML = '';
    const list = Array.isArray(gameState.statuses) ? gameState.statuses : [];
    if (list.length === 0) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    list.forEach(st => {
        const chip = document.createElement('span');
        chip.className = 'status-chip';
        chip.textContent = `✨ ${st.effect} · ${st.target}${st.value ? ' (' + st.value + ')' : ''}`;
        chip.title = `${st.effect}: ${st.target}${st.value ? ' — ' + st.value : ' — бессрочно'}`;
        chip.onclick = () => {
            if (isEraserMode) {
                gameState.statuses = (gameState.statuses || []).filter(s => s !== st);
                addLog(`[status: ${st.target}, ${st.effect}, снят]`);
                saveState(); updateUI();
                return;
            }
            try { chrome.runtime.sendMessage({ type: "INSERT_TEXT", text: `[${st.target}]` }); } catch (e) {}
        };
        bar.appendChild(chip);
    });
}

function updateUI() {
    const t = gameState.time || {};
    document.getElementById('game-time').textContent = t.time || '--:--';
    document.getElementById('game-date').textContent = `${t.date || '--.--.----'} (${t.day || '---'})`;

    renderStatuses();

    const countersContainer = document.getElementById('dynamic-counters');
    countersContainer.innerHTML = '';

    // v4.0: группировка счетчиков с Группа: Имя в один компактный ряд
    const groupOrder = [];
    const groups = {};
    for (const [name, data] of Object.entries(gameState.counters || {})) {
        if (isGarbageName(name)) continue;
        const g = (data && data.group) ? String(data.group) : '';
        if (!groups[g]) { groups[g] = []; groupOrder.push(g); }
        groups[g].push([name, data]);
    }

    // Рендер одного счетчика: Тип bar (полоска), text (число), time (строка
    // времени, без кнопок), enemy (враг, красная полоска); без типа — старое
    // поведение (полоска при наличии Макс)
    const renderCounter = (name, data, compact, container) => {
      try {
        const div = document.createElement('div');
        div.className = 'counter-row' + (compact ? ' compact' : '');
        if (selectedCounter === name) div.classList.add('selected');

        const ctype = (data && data.ctype) || '';
        const numeric = data && typeof data.current === 'number' && !isNaN(data.current);
        const hasMax = numeric && data.max !== null && data.max !== undefined && !isNaN(data.max) && data.max > 0;
        const isTime = ctype === 'time';
        const showBar = numeric && hasMax && (ctype === 'bar' || ctype === 'enemy' || !ctype);
        const barColor = ctype === 'enemy' ? '#e53935' : (data.color || '#2196F3');
        const valText = numeric
            ? (data.months ? dateCounterText(data.current, data.months)
                : data.breakdown ? breakdownText(data.current, data.breakdown)
                : `${data.current}${hasMax ? ' / ' + data.max : ''}`)
            : String(data.current ?? '');

        div.innerHTML = `
            <div class="counter-header"><strong>${isTime ? '🕒 ' : ''}${escapeHtml(name)}:</strong> <span>${escapeHtml(valText)}</span></div>
            ${showBar ? `<div class="counter-bar"><div class="counter-fill" style="width: ${Math.max(0, Math.min(100, (data.current / data.max) * 100))}%; background: ${barColor}"></div></div>` : ''}
            <div class="counter-actions"></div>
        `;

        const actionsDiv = div.querySelector('.counter-actions');
        if (!isTime) {
            // ФИКС (v3.7, «панель некликабельна»): имя счетчика НЕ попадает в id и селектор.
            const btnMinus = document.createElement('button');
            btnMinus.className = 'mini-btn'; btnMinus.textContent = '-10';
            btnMinus.onclick = (e) => { e.stopPropagation(); if(!isEraserMode) changeCounter(name, -10); };

            const btnPlus = document.createElement('button');
            btnPlus.className = 'mini-btn'; btnPlus.textContent = '+10';
            btnPlus.onclick = (e) => { e.stopPropagation(); if(!isEraserMode) changeCounter(name, 10); };

            actionsDiv.appendChild(btnMinus); actionsDiv.appendChild(btnPlus);
        }

        div.onclick = (e) => {
            if (e.target.tagName === 'BUTTON') return;
            if (isEraserMode) {
                delete gameState.counters[name]; addLog(`[rm: ${name}]`); saveState(); updateUI();
                return;
            }
            // v4.0 ЦЕЛЬ: клик по счетчику = выделение + мгновенная вставка [Имя]
            // в поле ввода ("Атакую " + клик → "Атакую [Агент Алой Кнешин 1]")
            selectedCounter = name;
            try {
                chrome.runtime.sendMessage({ type: "INSERT_TEXT", text: `[${name}]` });
            } catch (err) { console.error('[RPG panel] Ошибка вставки цели:', err); }
            updateUI();
        };
        container.appendChild(div);
      } catch (e) {
        // Одна кривая строка состояния не должна хоронить весь рендер и кнопки
        console.error('[RPG panel] Ошибка рендера счетчика "' + name + '":', e);
      }
    };

    for (const g of groupOrder) {
        if (g) {
            const wrap = document.createElement('div');
            wrap.className = 'counter-group';
            groups[g].forEach(([name, data]) => renderCounter(name, data, true, wrap));
            countersContainer.appendChild(wrap);
        } else {
            groups[''].forEach(([name, data]) => renderCounter(name, data, false, countersContainer));
        }
    }

    const tabsHeader = document.getElementById('tabs-header');
    const tabsContent = document.getElementById('tabs-content');
    
    const activeTabBtn = document.querySelector('.tab-btn.active');
    const activeTabName = activeTabBtn ? activeTabBtn.textContent : null;

    tabsHeader.innerHTML = ''; tabsContent.innerHTML = '';

    for (const [tabName, tabData] of Object.entries(gameState.tabs || {})) {
        if (isGarbageName(tabName)) continue;

        const btn = document.createElement('button');
        btn.className = 'tab-btn'; 
        btn.textContent = tabName;
        
        // ФИКС: Удаление вкладки ластиком
        btn.onclick = (e) => {
            if (isEraserMode) {
                delete gameState.tabs[tabName];
                gameState.items = gameState.items.filter(i => !i.props || i.props['Tab'] !== tabName);
                if (window.currentTabAction && window.currentTabAction.key === tabData.key) selectedItem = null;
                addLog(`[rm: ${tabName}]`);
                saveState(); updateUI();
                return;
            }

            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const target = document.getElementById(`tab-${tabName}`);
            if(target) target.classList.add('active');
        };

        const contentDiv = document.createElement('div');
        contentDiv.className = 'tab-content'; contentDiv.id = `tab-${tabName}`;

        let tabItems = tabName === '⭐ Избранное' 
            ? (Array.isArray(gameState.items) ? gameState.items : []).filter(i => favorites.has(i.name))
            : (Array.isArray(gameState.items) ? gameState.items : []).filter(i => i.props && i.props['Tab'] === tabName);

        tabItems.forEach(ent => {
            const itemBtn = document.createElement('button');
            itemBtn.className = 'entity-btn';

            // v3.9: свойства предмета — в title-тултип (кроме Tab).
            // Панель не захламляется ("Урон: 10, Патроны: 6/6" видно при наведении)
            const propTip = Object.entries(ent.props || {})
                .filter(([k]) => normName(k) !== 'tab')
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n');
            if (propTip) itemBtn.title = propTip;

            const star = document.createElement('span');
            star.className = `fav-btn ${favorites.has(ent.name) ? 'active' : ''}`;
            star.textContent = '★';
            star.onclick = (e) => {
                e.stopPropagation();
                if (favorites.has(ent.name)) favorites.delete(ent.name);
                else favorites.add(ent.name);
                saveState(); updateUI();
            };

            itemBtn.appendChild(star);
            itemBtn.appendChild(document.createTextNode(ent.name));

            itemBtn.onclick = () => {
                if (isEraserMode) {
                    gameState.items = gameState.items.filter(i => i.name !== ent.name);
                    if(selectedItem === ent.name) selectedItem = null;
                    addLog(`[rm: ${ent.name}]`); saveState(); updateUI(); return;
                }
                // v3.9 АВТОВСТАВКА: клик по предмету = выделение + МГНОВЕННАЯ
                // вставка действия в поле ввода чата + списание стоимости.
                // Кнопка «Вставить в чат» больше не нужна для действий — она
                // осталась только для отправки накопленных логов (sendQueuedLogs).
                // v4.0 ФИКС СТОИМОСТИ: базовая цена берется из вкладки, но если у
                // предмета есть СВОЕ плоское числовое свойство с тем же именем
                // ([i: Спрятаться, Tab: Действия, Энергия: 4]) — оно заменяет цену.
                // Свойства формата N/M (Патроны: 6/6) — пул, а не цена, их не тратим.
                selectedItem = ent.name;
                const tabCost = (tabData && tabData.cost) || {};
                const cost = {};
                Object.keys(tabCost).forEach(k => {
                    let val = tabCost[k];
                    const propKey = Object.keys(ent.props || {}).find(pk => normName(pk) === normName(k));
                    if (propKey) {
                        const pv = parsePropVal(ent.props[propKey]);
                        if (pv.max === null && pv.raw === undefined) val = pv.cur;
                    }
                    cost[k] = val;
                });
                window.currentTabAction = { key: (tabData && tabData.key) || 'Использую', cost: cost };
                try {
                    for (const [counterName, c] of Object.entries(cost)) changeCounter(counterName, -c);
                    chrome.runtime.sendMessage({ type: "INSERT_TEXT", text: `${window.currentTabAction.key} [${ent.name}]` });
                } catch (e) {
                    console.error('[RPG panel] Ошибка вставки действия:', e);
                }
                updateUI(); // cost мог изменить счетчики
            };

            if (selectedItem === ent.name) itemBtn.classList.add('selected');
            contentDiv.appendChild(itemBtn);
        });

        if (tabItems.length === 0) contentDiv.innerHTML = '<span style="color:#666; font-size:12px;">Пусто</span>';
        tabsHeader.appendChild(btn);
        tabsContent.appendChild(contentDiv);
    }
    
    if (tabsHeader.children.length > 0) {
        const tabToActivate = Array.from(tabsHeader.children).find(b => b.textContent === activeTabName);
        if (tabToActivate) tabToActivate.click();
        else tabsHeader.children[0].click();
    }
    
    updatePreview();
}

function renderLogs() {
    const logContainer = document.getElementById('log-preview');
    if (logQueue.length === 0) {
        logContainer.innerHTML = '<span style="color: #888;">Нет активных логов</span>';
        return;
    }
    logContainer.innerHTML = `
        <details>
            <summary style="cursor:pointer; color:#4CAF50; font-weight:bold;">📦 Скрыто логов: ${logQueue.length} (нажмите чтобы раскрыть)</summary>
            <div style="margin-top:5px; font-size:11px; color:#aaa; word-break: break-all;">
                ${logQueue.join(' /// ')}
            </div>
        </details>
    `;
}

function updatePreview() {
    let text = '';
    if (selectedItem && window.currentTabAction) {
        text = `${window.currentTabAction.key} [${selectedItem}]`;
        if (Object.keys(window.currentTabAction.cost).length > 0) {
            let costStr = Object.entries(window.currentTabAction.cost).map(([k,v]) => `${k}: -${v}`).join(', ');
            text += ` (Цена: ${costStr})`;
        }
    } else if (selectedCounter) {
        // v4.0: выделенная цель (клик по счетчику) — в поле уже ушла [Имя]
        text = `Цель: [${selectedCounter}]`;
    }
    document.getElementById('preview-text').textContent = text || (isEraserMode ? 'Режим ластика' : 'Выберите предмет');
    // v3.9: кнопка теперь ТОЛЬКО для накопленных логов (действия вставляются
    // кликом по предмету) — блокируем, когда логов нет или включен ластик
    document.getElementById('send-btn').disabled = logQueue.length === 0 || isEraserMode;
}

// v3.9: «Вставить в чат» — отправка накопленных логов.
// Контент-скрипт приклеит их блоком [SYS]...[/SYS] к тексту поля ввода
// (с отпечатком против эхо-повтора) — сообщение отправляет ИГРОК своим Enter.
// Инвариант v3.8: расширение никогда не отправляет сообщения само.
function sendQueuedLogs() {
    if (isEraserMode || logQueue.length === 0) return false;
    try {
        chrome.runtime.sendMessage({ type: "SEND_LOGS_TO_INPUT" });
    } catch (e) {
        console.error('[RPG panel] sendQueuedLogs:', e);
        return false;
    }
    return true;
}
