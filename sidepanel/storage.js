// storage.js — профили состояния по ID чата
function defaultState() {
    return {
        gameState: {
            counters: {}, tabs: {}, items: [], rules: [],
            // v3.9: отложенные события и правила предметов
            timers: [], itemRules: [],
            // v4.0: статусы (условия) [{target, effect, value}]
            statuses: [],
            time: { time: '12:00', date: '01.01.2026', day: 'Понедельник' }
        },
        history: { currentTurn: 0, lastTurnSnapshot: null }
    };
}

let gameState = defaultState().gameState;
let history = defaultState().history;
let favorites = new Set();
let currentProfileId = 'default';
let logQueue = [];

// Загружаем данные конкретного чата в память панели
function loadProfile(chatId) {
    currentProfileId = chatId || 'default';
    return new Promise((resolve) => {
        chrome.storage.local.get([currentProfileId], (res) => {
            const data = res[currentProfileId];
            if (data) {
                // Санитизация профиля (v3.7): старые/поврежденные данные не тех
                // типов (items не массив, counters с мусором) роняли updateUI
                // и делали ВСЕ кнопки панели мертвыми
                const g = (data.gameState && typeof data.gameState === 'object') ? data.gameState : {};
                const time0 = defaultState().gameState.time;
                gameState = {
                    counters: (g.counters && typeof g.counters === 'object' && !Array.isArray(g.counters)) ? g.counters : {},
                    tabs: (g.tabs && typeof g.tabs === 'object' && !Array.isArray(g.tabs)) ? g.tabs : {},
                    items: Array.isArray(g.items) ? g.items : [],
                    rules: Array.isArray(g.rules) ? g.rules : [],
                    // v3.9: таймеры и правила предметов — тоже массивы
                    // (кривой профиль не должен ронять checkTimers/runItemRules)
                    timers: Array.isArray(g.timers) ? g.timers : [],
                    itemRules: Array.isArray(g.itemRules) ? g.itemRules : [],
                    // v4.0: статусы — только объекты {target, effect, value}
                    statuses: Array.isArray(g.statuses) ? g.statuses.filter(s => s && typeof s === 'object') : [],
                    time: (g.time && typeof g.time === 'object') ? { ...time0, ...g.time } : { ...time0 }
                };
                history = (data.history && typeof data.history === 'object') ? data.history : defaultState().history;
                if (typeof history.currentTurn !== 'number' || isNaN(history.currentTurn)) history.currentTurn = 0;
                favorites = new Set(Array.isArray(data.favorites) ? data.favorites : []);
            } else {
                // Новый чат — чистое состояние
                const fresh = defaultState();
                gameState = fresh.gameState;
                history = fresh.history;
                favorites = new Set();
            }
            // Сброс зависших выделений UI при смене чата
            selectedItem = null;
            selectedCounter = null;
            window.currentTabAction = null;
            logQueue = [];
            if (typeof updateUI === 'function') updateUI();
            if (typeof renderLogs === 'function') renderLogs();
            resolve();
        });
    });
}

// Первичная загрузка: угадываем профиль по активному табу.
// Точный chatId приходит позже с каждым NEW_SYS_BLOCK (content.js знает location).
async function initProfile() {
    return new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            let chatId = 'default';
            if (tabs[0]?.url) {
                const m = tabs[0].url.match(/chat\/(?:a\/chat\/)?s\/([a-zA-Z0-9-]+)/);
                if (m) chatId = m[1];
            }
            loadProfile(chatId).then(resolve);
        });
    });
}

function saveState() {
    chrome.storage.local.set({
        [currentProfileId]: {
            gameState: gameState,
            history: history,
            favorites: Array.from(favorites)
        }
    });
}

function resetState() {
    const fresh = defaultState();
    gameState = fresh.gameState;
    history = fresh.history;
    favorites.clear();
    logQueue = [];
    saveState();
    if (typeof updateUI === 'function') updateUI();
}
