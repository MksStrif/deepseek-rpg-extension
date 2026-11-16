// background.js — маршрутизатор сообщений панель <-> контент-скрипт
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Таб, который последним присылал NEW_SYS_BLOCK — это и есть игровой чат.
// Фокус окна может быть где угодно (панель, второе окно), поэтому маршрутизируем туда.
let gameTabId = null;

function routeToChat(message, onResponse) {
    const send = (tabId) => chrome.tabs.sendMessage(tabId, message, (res) => {
        void chrome.runtime.lastError;
        if (onResponse) onResponse(res);
    });
    const sendActive = () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) send(tabs[0].id);
            else if (onResponse) onResponse({ error: "Активный таб не найден" });
        });
    };
    if (gameTabId != null) {
        chrome.tabs.get(gameTabId, (tab) => {
            if (!chrome.runtime.lastError && tab) send(gameTabId);
            else sendActive(); // игровой таб закрыт — fallback на активный
        });
    } else {
        sendActive();
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Запоминаем игровой таб по факту его же события
    if (message.type === "NEW_SYS_BLOCK" && sender?.tab?.id) gameTabId = sender.tab.id;

    // 1. Команды из ПАНЕЛИ в ЧАТ (AI_ROLL — бросок по запросу ИИ, RESYNC — пересканирование)
    if (["INSERT_TEXT", "SEND_DEBUG_TO_CHAT", "CLEAR_LOGS", "LOG_UPDATE", "AI_ROLL", "RESYNC"].includes(message.type)) {
        routeToChat(message);
    }
    // 2. Диагностика: запрос-ответ через игровой таб (async relay)
    else if (message.type === "DIAGNOSTICS") {
        routeToChat(message, (res) => {
            sendResponse(res || { error: "Контент-скрипт не отвечает — обнови страницу чата (F5)" });
        });
        return true; // асинхронный sendResponse
    }
    // 3. События из ЧАТА в ПАНЕЛЬ
    else if (["NEW_SYS_BLOCK", "DEBUG_LOGS_RESULT"].includes(message.type)) {
        chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    }
});
