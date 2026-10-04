importScripts("settings.js");

const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const MAX_RETRIES = 2;

class TranslatorError extends Error {
  constructor(message, { fatal = false, retryable = false } = {}) {
    super(message);
    this.fatal = fatal;
    this.retryable = retryable;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.type) {
    case "translate-batch":
      respondWith(
        sendResponse,
        translateSegments(message.texts, message.pageTitle).then((translations) => ({ translations })),
      );
      return true;
    case "toggle-page":
      respondWith(sendResponse, togglePageTranslation(message.tabId));
      return true;
    case "test-connection":
      respondWith(
        sendResponse,
        translateSegments(["Hello, world! This is a connection test."], "").then(([sample]) => ({ sample })),
      );
      return true;
    default:
      return false;
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-translation" && tab?.id !== undefined) {
    togglePageTranslation(tab.id).catch((error) => console.warn("[DeepSeek 翻译]", error));
  }
});

function respondWith(sendResponse, promise) {
  promise
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((error) => sendResponse({ ok: false, error: error.message, fatal: Boolean(error.fatal) }));
}

async function togglePageTranslation(tabId) {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, { type: "toggle-translation" });
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "get-state" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["settings.js", "content.js"] });
  }
}

async function translateSegments(texts, pageTitle) {
  const settings = await loadTranslatorSettings();
  if (!settings.apiKey) {
    throw new TranslatorError("尚未设置 DeepSeek API Key，请先在插件设置页填写。", { fatal: true });
  }
  return translateWithSplit(texts, settings, pageTitle);
}

// The model occasionally merges or drops segments; halving the batch isolates the bad segment.
async function translateWithSplit(texts, settings, pageTitle) {
  const translations = await requestTranslations(texts, settings, pageTitle);
  if (translations) return translations;
  if (texts.length === 1) throw new TranslatorError("模型返回的译文格式不正确。");

  const middle = Math.ceil(texts.length / 2);
  const [head, tail] = await Promise.all([
    translateWithSplit(texts.slice(0, middle), settings, pageTitle),
    translateWithSplit(texts.slice(middle), settings, pageTitle),
  ]);
  return [...head, ...tail];
}

async function requestTranslations(texts, settings, pageTitle) {
  const data = await postChatCompletion(
    {
      model: settings.model,
      messages: buildMessages(texts, settings.targetLang, pageTitle),
      response_format: { type: "json_object" },
      temperature: 1.3,
      max_tokens: 8192,
      stream: false,
    },
    settings.apiKey,
  );

  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") return null;

  let parsed;
  try {
    parsed = JSON.parse(choice?.message?.content ?? "");
  } catch {
    return null;
  }

  const translations = parsed?.translations;
  if (!Array.isArray(translations) || translations.length !== texts.length) return null;
  return translations.map((item, index) => (typeof item === "string" ? item : texts[index]));
}

function buildMessages(texts, targetLang, pageTitle) {
  const system = [
    `You are a professional web page translator. Translate every string in the "segments" array into ${targetLang}.`,
    'Reply with a JSON object of the form {"translations": ["..."]}.',
    "The translations array must have exactly the same length and order as segments; each item is the translation of the segment at the same index.",
    "Segments are fragments of the same page and may be partial sentences; translate each one on its own without merging or splitting them.",
    "Keep URLs, code, numbers and brand names unchanged. If a segment is already in the target language, return it unchanged.",
    "Output only the JSON object.",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify({ page_title: pageTitle, segments: texts }) },
  ];
}

async function postChatCompletion(body, apiKey) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(DEEPSEEK_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new TranslatorError(`无法连接 DeepSeek 服务：${error.message}`);
    }

    if (response.ok) return response.json();

    const error = await toTranslatorError(response);
    if (error.retryable && attempt < MAX_RETRIES) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw error;
  }
}

async function toTranslatorError(response) {
  let detail = "";
  try {
    detail = (await response.json())?.error?.message ?? "";
  } catch {
    // Body is not JSON; the status code is enough to explain the failure.
  }
  const suffix = detail ? `（${detail}）` : "";

  switch (response.status) {
    case 401:
      return new TranslatorError(`API Key 无效，请检查设置${suffix}`, { fatal: true });
    case 402:
      return new TranslatorError(`DeepSeek 账户余额不足${suffix}`, { fatal: true });
    case 400:
    case 422:
      return new TranslatorError(`请求参数错误，请检查模型名称${suffix}`, { fatal: true });
    case 429:
      return new TranslatorError(`请求过于频繁，请稍后再试${suffix}`, { retryable: true });
    case 500:
    case 503:
      return new TranslatorError(`DeepSeek 服务繁忙，请稍后再试${suffix}`, { retryable: true });
    default:
      return new TranslatorError(`DeepSeek 接口返回错误 ${response.status}${suffix}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
