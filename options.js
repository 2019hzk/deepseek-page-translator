const form = document.getElementById("settings-form");
const apiKeyInput = document.getElementById("api-key");
const modelInput = document.getElementById("model");
const targetLangSelect = document.getElementById("target-lang");
const toggleKeyButton = document.getElementById("toggle-key");
const testButton = document.getElementById("test");
const statusText = document.getElementById("status");

initOptions();

async function initOptions() {
  const settings = await loadTranslatorSettings();
  for (const language of TARGET_LANGUAGES) targetLangSelect.add(new Option(language, language));
  apiKeyInput.value = settings.apiKey;
  modelInput.value = settings.model;
  targetLangSelect.value = settings.targetLang;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveSettings();
    showStatus("已保存。", "success");
  });
  testButton.addEventListener("click", testConnection);
  toggleKeyButton.addEventListener("click", () => {
    const hidden = apiKeyInput.type === "password";
    apiKeyInput.type = hidden ? "text" : "password";
    toggleKeyButton.textContent = hidden ? "隐藏" : "显示";
  });
}

function saveSettings() {
  return chrome.storage.local.set({
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim() || TRANSLATOR_DEFAULTS.model,
    targetLang: targetLangSelect.value,
  });
}

async function testConnection() {
  testButton.disabled = true;
  showStatus("正在测试连接…");
  await saveSettings();
  const response = await chrome.runtime.sendMessage({ type: "test-connection" });
  testButton.disabled = false;

  if (response.ok) showStatus(`连接成功，测试译文：${response.sample}`, "success");
  else showStatus(`连接失败：${response.error}`, "error");
}

function showStatus(message, kind = "") {
  statusText.textContent = message;
  statusText.className = `status ${kind}`;
}
