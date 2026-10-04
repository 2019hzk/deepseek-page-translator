(() => {
  const HOST_ID = "deepseek-translator-host";
  const EXCLUDED_SELECTOR = [
    "script", "style", "noscript", "template", "textarea", "input", "select", "option",
    "code", "pre", "kbd", "samp", "var", "svg", "math", "canvas", "iframe",
    "[contenteditable='']", "[contenteditable='true']", "[translate='no']", ".notranslate",
    `#${HOST_ID}`,
  ].join(",");
  const BATCH_MAX_SEGMENTS = 40;
  const BATCH_MAX_CHARS = 2500;
  const MAX_CONCURRENT_BATCHES = 3;
  const FLUSH_DELAY_MS = 150;
  const VIEWPORT_MARGIN = "800px 0px";
  const MUTATION_OPTIONS = { childList: true, subtree: true, characterData: true };

  const originalTexts = new Map();
  const translatedTexts = new Map();
  const writtenValues = new WeakMap();
  const translationCache = new Map();
  const inflightNodes = new Map();
  const waitingNodesByElement = new Map();
  const batchQueue = [];
  let pendingNodes = [];
  let flushTimer = 0;
  let activeBatches = 0;
  let sessionId = 0;
  let mode = "idle";
  let targetLang = TRANSLATOR_DEFAULTS.targetLang;
  let progress = { total: 0, done: 0, failed: 0 };
  let lastError = "";
  let badge = null;
  let badgeDismissed = false;

  const intersectionObserver = new IntersectionObserver(handleIntersections, { rootMargin: VIEWPORT_MARGIN });
  const mutationObserver = new MutationObserver(handleMutations);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "toggle-translation") {
      toggleTranslation().then(() => sendResponse({ mode }));
      return true;
    }
    if (message?.type === "get-state") sendResponse({ mode });
    return false;
  });

  async function toggleTranslation() {
    badgeDismissed = false;
    if (mode === "idle") await startTranslation();
    else if (mode === "translated") showOriginal();
    else showTranslation();
  }

  async function startTranslation() {
    const settings = await loadTranslatorSettings();
    if (settings.targetLang !== targetLang) translationCache.clear();
    targetLang = settings.targetLang;
    lastError = "";
    mode = "translated";
    registerTextNodes(document.body);
    mutationObserver.observe(document.body, MUTATION_OPTIONS);
    renderBadge();
  }

  function showOriginal() {
    mode = "original";
    mutationObserver.disconnect();
    for (const [node, value] of originalTexts) writeText(node, value);
    renderBadge();
  }

  function showTranslation() {
    mode = "translated";
    for (const [node, value] of translatedTexts) writeText(node, value);
    registerTextNodes(document.body);
    mutationObserver.observe(document.body, MUTATION_OPTIONS);
    renderBadge();
  }

  function stopTranslation() {
    sessionId++;
    mutationObserver.disconnect();
    intersectionObserver.disconnect();
    clearTimeout(flushTimer);
    flushTimer = 0;
    for (const [node, value] of originalTexts) writeText(node, value);
    originalTexts.clear();
    translatedTexts.clear();
    waitingNodesByElement.clear();
    inflightNodes.clear();
    batchQueue.length = 0;
    pendingNodes = [];
    activeBatches = 0;
    progress = { total: 0, done: 0, failed: 0 };
    mode = "idle";
  }

  function registerTextNodes(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      registerTextNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE || root.closest(EXCLUDED_SELECTOR)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) registerTextNode(node);
  }

  function registerTextNode(node) {
    const current = node.nodeValue;
    if (originalTexts.get(node) === current) {
      const translated = translatedTexts.get(node);
      if (translated !== undefined && mode === "translated") writeText(node, translated);
      return;
    }
    if (originalTexts.has(node) && writtenValues.get(node) === current) return;
    if (!isTranslatable(node)) {
      forgetNode(node);
      return;
    }
    originalTexts.set(node, current);
    translatedTexts.delete(node);
    queueWhenVisible(node);
  }

  function isTranslatable(node) {
    const text = node.nodeValue.trim();
    if (!/\p{L}/u.test(text)) return false;
    const parent = node.parentElement;
    if (!parent || parent.closest(EXCLUDED_SELECTOR)) return false;
    return !isAlreadyInTargetLanguage(text);
  }

  function isAlreadyInTargetLanguage(text) {
    if (!targetLang.includes("中文")) return false;
    const letters = text.match(/\p{L}/gu).length;
    const hanCharacters = text.match(/\p{Script=Han}/gu)?.length ?? 0;
    return hanCharacters / letters >= 0.5;
  }

  function forgetNode(node) {
    originalTexts.delete(node);
    translatedTexts.delete(node);
  }

  function queueWhenVisible(node) {
    const element = node.parentElement;
    let nodes = waitingNodesByElement.get(element);
    if (!nodes) {
      nodes = new Set();
      waitingNodesByElement.set(element, nodes);
    }
    nodes.add(node);
    intersectionObserver.observe(element);
  }

  function handleIntersections(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const element = entry.target;
      intersectionObserver.unobserve(element);
      const nodes = waitingNodesByElement.get(element);
      waitingNodesByElement.delete(element);
      nodes?.forEach(queueNode);
    }
  }

  function handleMutations(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") registerTextNode(mutation.target);
      else mutation.addedNodes.forEach(registerTextNodes);
    }
  }

  function queueNode(node) {
    const source = originalTexts.get(node)?.trim();
    if (!source || !node.isConnected) return;
    const cached = translationCache.get(source);
    if (cached !== undefined) {
      applyTranslation(node, source, cached);
      return;
    }
    progress.total++;
    pendingNodes.push(node);
    flushTimer ||= setTimeout(flushPendingNodes, FLUSH_DELAY_MS);
    renderBadge();
  }

  function flushPendingNodes() {
    flushTimer = 0;
    let batch = [];
    let batchChars = 0;

    for (const node of pendingNodes) {
      const source = originalTexts.get(node)?.trim();
      if (!source) {
        progress.done++;
        continue;
      }
      const cached = translationCache.get(source);
      if (cached !== undefined) {
        applyTranslation(node, source, cached);
        progress.done++;
        continue;
      }
      const inflight = inflightNodes.get(source);
      if (inflight) {
        inflight.push(node);
        continue;
      }
      inflightNodes.set(source, [node]);

      if (batch.length >= BATCH_MAX_SEGMENTS || (batch.length && batchChars + source.length > BATCH_MAX_CHARS)) {
        batchQueue.push(batch);
        batch = [];
        batchChars = 0;
      }
      batch.push(source);
      batchChars += source.length;
    }

    pendingNodes = [];
    if (batch.length) batchQueue.push(batch);
    pumpBatches();
  }

  function pumpBatches() {
    while (activeBatches < MAX_CONCURRENT_BATCHES && batchQueue.length) {
      const sources = batchQueue.shift();
      const session = sessionId;
      activeBatches++;
      requestTranslations(sources)
        .then((translations) => {
          if (session === sessionId) sources.forEach((source, index) => settleSource(source, translations[index]));
        })
        .catch((error) => {
          if (session === sessionId) handleBatchError(sources, error);
        })
        .finally(() => {
          if (session !== sessionId) return;
          activeBatches--;
          pumpBatches();
        });
    }
    renderBadge();
  }

  async function requestTranslations(sources) {
    const response = await chrome.runtime.sendMessage({
      type: "translate-batch",
      texts: sources,
      pageTitle: document.title,
    });
    if (!response?.ok) {
      throw Object.assign(new Error(response?.error ?? "翻译失败"), { fatal: Boolean(response?.fatal) });
    }
    return response.translations;
  }

  function settleSource(source, translation) {
    translationCache.set(source, translation);
    const nodes = inflightNodes.get(source) ?? [];
    inflightNodes.delete(source);
    for (const node of nodes) applyTranslation(node, source, translation);
    progress.done += nodes.length;
  }

  function handleBatchError(sources, error) {
    lastError = error.message;
    for (const source of sources) {
      const failedCount = inflightNodes.get(source)?.length ?? 0;
      inflightNodes.delete(source);
      progress.failed += failedCount;
      progress.done += failedCount;
    }
    if (error.fatal) stopTranslation();
    renderBadge();
  }

  function applyTranslation(node, source, translation) {
    const original = originalTexts.get(node);
    if (original === undefined || original.trim() !== source) return;
    const leading = original.match(/^\s*/)[0];
    const trailing = original.match(/\s*$/)[0];
    const value = leading + translation.trim() + trailing;
    translatedTexts.set(node, value);
    if (mode === "translated") writeText(node, value);
  }

  function writeText(node, value) {
    if (!node.isConnected) {
      forgetNode(node);
      return;
    }
    writtenValues.set(node, value);
    if (node.nodeValue !== value) node.nodeValue = value;
  }

  function isWorking() {
    return activeBatches > 0 || batchQueue.length > 0 || pendingNodes.length > 0;
  }

  function renderBadge() {
    if (badgeDismissed) return;
    badge ??= createBadge();

    let status;
    let action;
    if (mode === "idle") {
      status = lastError ? `翻译已停止：${lastError}` : "未翻译";
      action = "重新翻译";
    } else if (mode === "original") {
      status = "正在显示原文";
      action = "显示译文";
    } else if (isWorking()) {
      status = `翻译中 ${progress.done}/${progress.total}`;
      action = "显示原文";
    } else {
      status = progress.failed ? `已翻译，${progress.failed} 段失败：${lastError}` : "已翻译";
      action = "显示原文";
    }

    badge.status.textContent = status;
    badge.status.title = status;
    badge.action.textContent = action;
    badge.root.classList.toggle("error", mode === "idle" && Boolean(lastError));
  }

  function createBadge() {
    const host = document.createElement("div");
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .badge {
          position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
          display: flex; align-items: center; gap: 8px; max-width: 420px;
          padding: 8px 10px 8px 14px; border-radius: 10px;
          background: #1e293b; color: #f8fafc; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
          font: 13px/1.4 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        }
        .badge.error { background: #7f1d1d; }
        .status { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        button {
          flex: none; border: none; border-radius: 6px; cursor: pointer; font: inherit;
        }
        .action { padding: 4px 10px; background: #4d6bfe; color: #fff; }
        .action:hover { background: #3b5bfd; }
        .close { padding: 2px 6px; background: transparent; color: #94a3b8; font-size: 16px; }
        .close:hover { color: #fff; }
      </style>
      <div class="badge">
        <span class="status"></span>
        <button class="action" type="button"></button>
        <button class="close" type="button" title="隐藏">×</button>
      </div>`;

    const root = shadow.querySelector(".badge");
    const action = shadow.querySelector(".action");
    shadow.querySelector(".close").addEventListener("click", () => {
      badgeDismissed = true;
      host.remove();
      badge = null;
    });
    action.addEventListener("click", () => toggleTranslation());
    document.documentElement.append(host);

    return { root, status: shadow.querySelector(".status"), action };
  }
})();
