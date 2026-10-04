const toggleButton = document.getElementById("toggle");
const statusText = document.getElementById("status");
const targetLangSelect = document.getElementById("target-lang");

const BUTTON_LABELS = {
  idle: "翻译当前页面",
  translated: "显示原文",
  original: "显示译文",
};

initPopup();

async function initPopup() {
  const settings = await loadTranslatorSettings();
  for (const language of TARGET_LANGUAGES) targetLangSelect.add(new Option(language, language));
  targetLangSelect.value = settings.targetLang;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  renderMode(await readPageMode(tab.id));
  if (!settings.apiKey) showStatus("尚未设置 API Key，请先点击右上角「设置」。", true);

  toggleButton.addEventListener("click", () => togglePage(tab.id));
  targetLangSelect.addEventListener("change", () => {
    chrome.storage.local.set({ targetLang: targetLangSelect.value });
    showStatus("目标语言已切换，刷新页面后重新翻译生效。");
  });
  document.getElementById("open-options").addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

async function readPageMode(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "get-state" });
    return response.mode;
  } catch {
    return "idle";
  }
}

async function togglePage(tabId) {
  toggleButton.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: "toggle-page", tabId });
  toggleButton.disabled = false;

  if (!response.ok) {
    const unsupported = /cannot access|cannot be scripted|chrome:\/\/|edge:\/\//i.test(response.error);
    showStatus(unsupported ? "浏览器内置页面和应用商店页面无法翻译。" : response.error, true);
    return;
  }
  renderMode(response.mode);
  showStatus(response.mode === "translated" ? "正在翻译，进度显示在页面右下角。" : "");
}

function renderMode(mode) {
  toggleButton.textContent = BUTTON_LABELS[mode];
}

function showStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.classList.toggle("error", isError);
}
