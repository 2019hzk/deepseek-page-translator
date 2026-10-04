const TRANSLATOR_DEFAULTS = Object.freeze({
  apiKey: "",
  model: "deepseek-chat",
  targetLang: "简体中文",
});

const TARGET_LANGUAGES = Object.freeze([
  "简体中文",
  "繁體中文",
  "English",
  "日本語",
  "한국어",
  "Français",
  "Deutsch",
  "Español",
  "Русский",
]);

function loadTranslatorSettings() {
  return chrome.storage.local.get({ ...TRANSLATOR_DEFAULTS });
}
