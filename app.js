const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const WHISPER_MODEL = "whisper-large-v3";
const CHAT_MODEL = "openai/gpt-oss-120b";
const STORAGE_KEY = "twinmind-live-suggestions-settings-v1";

const DEFAULT_SETTINGS = {
  apiKey: "",
  suggestionContextWindow: 6,
  answerContextWindow: 12,
  refreshIntervalSeconds: 30,
  chunkSeconds: 30,
  suggestionPrompt: `You are TwinMind, an always-on meeting copilot.

Your task is to produce exactly 3 live suggestions based on the most recent meeting transcript.
The suggestions must be useful immediately, even before they are clicked.

Balance the mix based on context. The 3 suggestions can include:
- a question the user should ask next
- a talking point or negotiation angle
- a direct answer to a question that was asked
- a fact-check or risk flag
- a clarification, definition, or summary

Rules:
- Return JSON only.
- Return exactly 3 suggestions.
- Every suggestion must include: kind, title, preview, rationale.
- "kind" must be one of: question, talking_point, answer, fact_check, clarification.
- "title" should be short and actionable.
- "preview" should be 1-3 sentences and already valuable on its own.
- "rationale" should explain why this suggestion is timely right now.
- Avoid generic advice. Use the transcript's real context.
- Make the 3 suggestions meaningfully different from each other.`,
  answerPrompt: `You are TwinMind generating a detailed answer after the user clicked a live suggestion.

Use the full transcript context provided. Be specific, practical, and trustworthy.

Rules:
- Directly answer the clicked suggestion.
- Include crisp structure with short paragraphs.
- If relevant, include assumptions, risks, objections, or next-step phrasing the user can say aloud.
- If there is uncertainty, say so clearly instead of hallucinating.`,
  chatPrompt: `You are TwinMind, an in-meeting AI copilot.

Answer user questions using the transcript context first, then careful general knowledge if needed.
Keep answers useful during a live conversation.

Rules:
- Be concise but complete.
- Prefer practical phrasing the user can repeat in the meeting.
- Call out uncertainty when the transcript is incomplete.
- If the user asks for a fact check, separate confirmed facts from assumptions.`,
};

const state = {
  settings: loadSettings(),
  transcriptEntries: [],
  suggestionBatches: [],
  chatMessages: [],
  mediaRecorder: null,
  mediaStream: null,
  isRecording: false,
  isBusy: false,
  pendingManualRefresh: false,
  currentChunkStartedAt: null,
  lastStatusMessage: "Ready to start",
  flushDeadlineMs: null,
  countdownIntervalId: null,
  metrics: {
    lastSuggestionsLatencyMs: null,
    lastChatLatencyMs: null,
    lastTranscriptionLatencyMs: null,
  },
};

const els = {
  recordButton: document.querySelector("#recordButton"),
  micStatusLabel: document.querySelector("#micStatusLabel"),
  transcriptList: document.querySelector("#transcriptList"),
  refreshButton: document.querySelector("#refreshButton"),
  refreshMeta: document.querySelector("#refreshMeta"),
  refreshCountdown: document.querySelector("#refreshCountdown"),
  batchCountLabel: document.querySelector("#batchCountLabel"),
  suggestionBatches: document.querySelector("#suggestionBatches"),
  chatList: document.querySelector("#chatList"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  sendButton: document.querySelector("#sendButton"),
  exportButton: document.querySelector("#exportButton"),
  settingsButton: document.querySelector("#settingsButton"),
  closeSettingsButton: document.querySelector("#closeSettingsButton"),
  settingsModal: document.querySelector("#settingsModal"),
  settingsForm: document.querySelector("#settingsForm"),
  resetSettingsButton: document.querySelector("#resetSettingsButton"),
  apiKeyInput: document.querySelector("#apiKeyInput"),
  suggestionContextWindowInput: document.querySelector("#suggestionContextWindowInput"),
  answerContextWindowInput: document.querySelector("#answerContextWindowInput"),
  refreshIntervalInput: document.querySelector("#refreshIntervalInput"),
  chunkSecondsInput: document.querySelector("#chunkSecondsInput"),
  suggestionPromptInput: document.querySelector("#suggestionPromptInput"),
  answerPromptInput: document.querySelector("#answerPromptInput"),
  chatPromptInput: document.querySelector("#chatPromptInput"),
  transcriptItemTemplate: document.querySelector("#transcriptItemTemplate"),
  suggestionBatchTemplate: document.querySelector("#suggestionBatchTemplate"),
  suggestionCardTemplate: document.querySelector("#suggestionCardTemplate"),
  chatItemTemplate: document.querySelector("#chatItemTemplate"),
  connectionDot: document.querySelector("#connectionDot"),
  connectionLabel: document.querySelector("#connectionLabel"),
  chunkCadenceLabel: document.querySelector("#chunkCadenceLabel"),
  nextFlushLabel: document.querySelector("#nextFlushLabel"),
  suggestionsLatencyLabel: document.querySelector("#suggestionsLatencyLabel"),
  chatLatencyLabel: document.querySelector("#chatLatencyLabel"),
};

initialize();

function initialize() {
  hydrateSettingsForm();
  bindEvents();
  startCountdownTicker();
  renderAll();
}

function bindEvents() {
  els.recordButton.addEventListener("click", toggleRecording);
  els.refreshButton.addEventListener("click", handleManualRefresh);
  els.exportButton.addEventListener("click", exportSession);
  els.chatForm.addEventListener("submit", handleChatSubmit);
  els.settingsButton.addEventListener("click", () => setModalVisibility(true));
  els.closeSettingsButton.addEventListener("click", () => setModalVisibility(false));
  els.resetSettingsButton.addEventListener("click", resetSettings);
  els.settingsForm.addEventListener("submit", saveSettings);
  els.settingsModal.addEventListener("click", (event) => {
    if (event.target instanceof HTMLElement && event.target.dataset.closeModal === "true") {
      setModalVisibility(false);
    }
  });
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return structuredClone(DEFAULT_SETTINGS);
    }

    const parsed = JSON.parse(raw);
    return sanitizeSettings(parsed);
  } catch (error) {
    console.error("Failed to load settings", error);
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function sanitizeSettings(value) {
  return {
    apiKey: typeof value.apiKey === "string" ? value.apiKey.trim() : DEFAULT_SETTINGS.apiKey,
    suggestionContextWindow: clampNumber(value.suggestionContextWindow, 1, 30, DEFAULT_SETTINGS.suggestionContextWindow),
    answerContextWindow: clampNumber(value.answerContextWindow, 1, 50, DEFAULT_SETTINGS.answerContextWindow),
    refreshIntervalSeconds: clampNumber(value.refreshIntervalSeconds, 10, 120, DEFAULT_SETTINGS.refreshIntervalSeconds),
    chunkSeconds: clampNumber(value.chunkSeconds, 10, 60, DEFAULT_SETTINGS.chunkSeconds),
    suggestionPrompt: typeof value.suggestionPrompt === "string" && value.suggestionPrompt.trim()
      ? value.suggestionPrompt.trim()
      : DEFAULT_SETTINGS.suggestionPrompt,
    answerPrompt: typeof value.answerPrompt === "string" && value.answerPrompt.trim()
      ? value.answerPrompt.trim()
      : DEFAULT_SETTINGS.answerPrompt,
    chatPrompt: typeof value.chatPrompt === "string" && value.chatPrompt.trim()
      ? value.chatPrompt.trim()
      : DEFAULT_SETTINGS.chatPrompt,
  };
}

function persistSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
}

function hydrateSettingsForm() {
  els.apiKeyInput.value = state.settings.apiKey;
  els.suggestionContextWindowInput.value = String(state.settings.suggestionContextWindow);
  els.answerContextWindowInput.value = String(state.settings.answerContextWindow);
  els.refreshIntervalInput.value = String(state.settings.refreshIntervalSeconds);
  els.chunkSecondsInput.value = String(state.settings.chunkSeconds);
  els.suggestionPromptInput.value = state.settings.suggestionPrompt;
  els.answerPromptInput.value = state.settings.answerPrompt;
  els.chatPromptInput.value = state.settings.chatPrompt;
}

function saveSettings(event) {
  event.preventDefault();

  state.settings = sanitizeSettings({
    apiKey: els.apiKeyInput.value,
    suggestionContextWindow: els.suggestionContextWindowInput.value,
    answerContextWindow: els.answerContextWindowInput.value,
    refreshIntervalSeconds: els.refreshIntervalInput.value,
    chunkSeconds: els.chunkSecondsInput.value,
    suggestionPrompt: els.suggestionPromptInput.value,
    answerPrompt: els.answerPromptInput.value,
    chatPrompt: els.chatPromptInput.value,
  });

  hydrateSettingsForm();
  persistSettings();
  updateFlushDeadline();
  setStatus("Settings saved locally.");
  setModalVisibility(false);
  renderAll();
}

function resetSettings() {
  state.settings = structuredClone(DEFAULT_SETTINGS);
  hydrateSettingsForm();
  persistSettings();
  updateFlushDeadline();
  setStatus("Defaults restored.");
  renderAll();
}

function setModalVisibility(isVisible) {
  els.settingsModal.classList.toggle("hidden", !isVisible);
  els.settingsModal.setAttribute("aria-hidden", String(!isVisible));
}

async function toggleRecording() {
  if (state.isRecording) {
    await stopRecording();
    return;
  }

  if (!state.settings.apiKey) {
    setStatus("Add your Groq API key in Settings first.");
    setModalVisibility(true);
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream, getRecorderOptions());

    recorder.addEventListener("dataavailable", handleRecorderData);
    recorder.addEventListener("stop", handleRecorderStop);

    state.mediaStream = stream;
    state.mediaRecorder = recorder;
    state.isRecording = true;
    state.currentChunkStartedAt = new Date().toISOString();

    recorder.start(state.settings.chunkSeconds * 1000);
    updateFlushDeadline();
    setStatus("Recording started.");
    renderAll();
  } catch (error) {
    console.error(error);
    setStatus("Microphone access failed. Check browser permissions.");
  }
}

async function stopRecording() {
  if (!state.mediaRecorder || state.mediaRecorder.state === "inactive") {
    return;
  }

  state.pendingManualRefresh = false;
  state.mediaRecorder.stop();
  state.flushDeadlineMs = null;
  setStatus("Stopping recording...");
  renderAll();
}

function handleRecorderStop() {
  state.mediaStream?.getTracks().forEach((track) => track.stop());
  state.mediaRecorder = null;
  state.mediaStream = null;
  state.isRecording = false;
  state.currentChunkStartedAt = null;
  state.flushDeadlineMs = null;
  setStatus("Recording stopped.");
  renderAll();
}

async function handleRecorderData(event) {
  if (!event.data || event.data.size === 0) {
    if (state.pendingManualRefresh) {
      state.pendingManualRefresh = false;
      await generateSuggestions("manual-empty-refresh");
    }
    updateFlushDeadline();
    return;
  }

  const transcribeStartedAt = performance.now();

  try {
    state.isBusy = true;
    renderAll();

    const transcriptText = await transcribeAudioChunk(event.data);
    state.metrics.lastTranscriptionLatencyMs = Math.round(performance.now() - transcribeStartedAt);

    if (transcriptText) {
      appendTranscript(transcriptText);
      await generateSuggestions(state.pendingManualRefresh ? "manual-refresh" : "auto-refresh");
    } else if (state.pendingManualRefresh) {
      await generateSuggestions("manual-empty-refresh");
    }
  } catch (error) {
    console.error(error);
    setStatus(getErrorMessage(error));
  } finally {
    state.pendingManualRefresh = false;
    state.currentChunkStartedAt = new Date().toISOString();
    state.isBusy = false;
    updateFlushDeadline();
    renderAll();
  }
}

async function handleManualRefresh() {
  if (!state.settings.apiKey) {
    setStatus("Add your Groq API key in Settings first.");
    setModalVisibility(true);
    return;
  }

  if (state.isBusy) {
    setStatus("A request is already in progress.");
    return;
  }

  if (state.isRecording && state.mediaRecorder?.state === "recording") {
    state.pendingManualRefresh = true;
    state.mediaRecorder.requestData();
    state.flushDeadlineMs = Date.now() + 1000;
    setStatus("Refreshing transcript then suggestions...");
    renderAll();
    return;
  }

  await generateSuggestions("manual-refresh");
}

async function transcribeAudioChunk(blob) {
  const extension = blob.type.includes("mp4") ? "m4a" : "webm";
  const file = new File([blob], `chunk-${Date.now()}.${extension}`, { type: blob.type || "audio/webm" });
  const formData = new FormData();
  formData.append("file", file);
  formData.append("model", WHISPER_MODEL);
  formData.append("response_format", "verbose_json");
  formData.append("language", "en");

  const response = await fetch(`${GROQ_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${state.settings.apiKey}`,
    },
    body: formData,
  });

  const data = await parseJsonResponse(response);
  return (data.text || "").trim();
}

function appendTranscript(text) {
  state.transcriptEntries.push({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    startedAt: state.currentChunkStartedAt,
    text,
  });
}

async function generateSuggestions(trigger = "manual-refresh") {
  if (!state.transcriptEntries.length) {
    setStatus("No transcript available yet.");
    renderAll();
    return;
  }

  const startedAt = performance.now();
  state.isBusy = true;
  renderAll();

  try {
    const transcriptContext = getTranscriptWindow(state.settings.suggestionContextWindow);
    const resultText = await createChatCompletion({
      systemPrompt: state.settings.suggestionPrompt,
      userPrompt: `Recent transcript context:\n${transcriptContext}\n\nReturn JSON in this shape only:\n{"suggestions":[{"kind":"question","title":"...","preview":"...","rationale":"..."}]}\n\nThe suggestions array must contain exactly 3 items.`,
      temperature: 0.45,
      responseFormat: { type: "json_object" },
    });

    const parsed = JSON.parse(resultText);
    const rawSuggestions = Array.isArray(parsed) ? parsed : parsed.suggestions;
    if (!Array.isArray(rawSuggestions) || rawSuggestions.length < 3) {
      throw new Error("Suggestions response did not contain exactly 3 items.");
    }

    const createdAt = new Date().toISOString();
    const suggestions = rawSuggestions.slice(0, 3).map((item) => ({
      id: crypto.randomUUID(),
      kind: normalizeKind(item.kind),
      title: sanitizeText(item.title, "Untitled suggestion"),
      preview: sanitizeText(item.preview, ""),
      rationale: sanitizeText(item.rationale, ""),
      createdAt,
    }));

    state.metrics.lastSuggestionsLatencyMs = Math.round(performance.now() - startedAt);
    state.suggestionBatches.unshift({
      id: crypto.randomUUID(),
      createdAt,
      trigger,
      transcriptContext,
      latencyMs: state.metrics.lastSuggestionsLatencyMs,
      suggestions,
    });

    setStatus("Suggestions updated.");
  } catch (error) {
    console.error(error);
    setStatus(getErrorMessage(error));
  } finally {
    state.isBusy = false;
    renderAll();
  }
}

async function handleChatSubmit(event) {
  event.preventDefault();
  const question = els.chatInput.value.trim();

  if (!question) {
    return;
  }

  els.chatInput.value = "";
  await sendChatQuestion(question, { kind: "user_question" });
}

async function sendChatQuestion(question, metadata = {}) {
  if (!state.settings.apiKey) {
    setStatus("Add your Groq API key in Settings first.");
    setModalVisibility(true);
    return;
  }

  state.chatMessages.push({
    id: crypto.randomUUID(),
    role: "user",
    text: question,
    timestamp: new Date().toISOString(),
    metadata,
  });

  const placeholderId = crypto.randomUUID();
  state.chatMessages.push({
    id: placeholderId,
    role: "assistant",
    text: "Thinking...",
    timestamp: new Date().toISOString(),
    metadata: { loading: true },
  });
  renderChat();

  const startedAt = performance.now();

  try {
    const transcriptContext = getTranscriptWindow(state.settings.answerContextWindow);
    const answer = await createChatCompletion({
      systemPrompt: metadata.kind === "suggestion_click" ? state.settings.answerPrompt : state.settings.chatPrompt,
      userPrompt: `Transcript context:\n${transcriptContext || "(No transcript yet)"}\n\nUser request:\n${question}`,
      temperature: 0.35,
    });

    state.metrics.lastChatLatencyMs = Math.round(performance.now() - startedAt);
    replaceChatPlaceholder(placeholderId, answer);
    setStatus("Answer ready.");
  } catch (error) {
    console.error(error);
    replaceChatPlaceholder(placeholderId, getErrorMessage(error), true);
    setStatus(getErrorMessage(error));
  } finally {
    renderChat();
    renderMetrics();
  }
}

function replaceChatPlaceholder(id, text, isError = false) {
  const message = state.chatMessages.find((entry) => entry.id === id);
  if (!message) {
    return;
  }

  message.text = text;
  message.metadata = { ...message.metadata, loading: false, isError };
  message.timestamp = new Date().toISOString();
}

async function createChatCompletion({ systemPrompt, userPrompt, temperature, responseFormat }) {
  const body = {
    model: CHAT_MODEL,
    temperature,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };

  if (responseFormat) {
    body.response_format = responseFormat;
  }

  const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.settings.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await parseJsonResponse(response);
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Model returned an empty response.");
  }

  return typeof content === "string" ? content.trim() : JSON.stringify(content);
}

async function parseJsonResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `Request failed with status ${response.status}.`;
    throw new Error(message);
  }
  return data;
}

function getTranscriptWindow(count) {
  return state.transcriptEntries
    .slice(-count)
    .map(
      (entry, index) =>
        `[${index + 1}] ${formatTimestamp(entry.timestamp)}\n${entry.text}`
    )
    .join("\n\n");
}

function exportSession() {
  const payload = {
    exportedAt: new Date().toISOString(),
    models: {
      transcription: WHISPER_MODEL,
      generation: CHAT_MODEL,
    },
    settings: {
      suggestionContextWindow: state.settings.suggestionContextWindow,
      answerContextWindow: state.settings.answerContextWindow,
      refreshIntervalSeconds: state.settings.refreshIntervalSeconds,
      chunkSeconds: state.settings.chunkSeconds,
      suggestionPrompt: state.settings.suggestionPrompt,
      answerPrompt: state.settings.answerPrompt,
      chatPrompt: state.settings.chatPrompt,
    },
    metrics: state.metrics,
    transcriptEntries: state.transcriptEntries,
    suggestionBatches: state.suggestionBatches,
    chatMessages: state.chatMessages,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `twinmind-session-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
  setStatus("Session exported.");
}

function renderAll() {
  renderMicState();
  renderConnectionState();
  renderTranscript();
  renderSuggestions();
  renderChat();
  renderMetrics();
  renderCountdown();
  renderStatusMeta();
}

function renderMicState() {
  els.recordButton.classList.toggle("recording", state.isRecording);
  els.micStatusLabel.textContent = state.isRecording ? "Recording" : "Idle";
  els.micStatusLabel.classList.toggle("recording", state.isRecording);
  els.micStatusLabel.classList.toggle("idle", !state.isRecording);
  els.recordButton.setAttribute("aria-label", state.isRecording ? "Stop recording" : "Start recording");
  els.refreshButton.disabled = state.isBusy;
  els.sendButton.disabled = state.isBusy;
  els.chunkCadenceLabel.textContent = `${state.settings.chunkSeconds}s`;
}

function renderConnectionState() {
  const hasKey = Boolean(state.settings.apiKey);
  els.connectionDot.classList.toggle("connected", hasKey);
  els.connectionLabel.textContent = hasKey ? "Groq key saved in this browser" : "Groq key not saved";
}

function renderTranscript() {
  els.transcriptList.innerHTML = "";

  if (!state.transcriptEntries.length) {
    els.transcriptList.className = "transcript-list empty-state";
    els.transcriptList.textContent = "No transcript yet - start the mic.";
    return;
  }

  els.transcriptList.className = "transcript-list";

  for (const entry of state.transcriptEntries) {
    const node = els.transcriptItemTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".transcript-meta").textContent = formatTimestamp(entry.timestamp);
    node.querySelector(".transcript-text").textContent = entry.text;
    els.transcriptList.appendChild(node);
  }

  els.transcriptList.scrollTop = els.transcriptList.scrollHeight;
}

function renderSuggestions() {
  els.suggestionBatches.innerHTML = "";
  els.batchCountLabel.textContent = `${state.suggestionBatches.length} batches`;

  if (!state.suggestionBatches.length) {
    els.suggestionBatches.className = "suggestion-batches empty-state";
    els.suggestionBatches.textContent = "Suggestions appear here once recording starts.";
    return;
  }

  els.suggestionBatches.className = "suggestion-batches";

  for (const [index, batch] of state.suggestionBatches.entries()) {
    const batchNode = els.suggestionBatchTemplate.content.firstElementChild.cloneNode(true);
    batchNode.querySelector(".suggestion-batch-title").textContent = index === 0 ? "Latest batch" : `Previous batch ${index}`;
    batchNode.querySelector(".suggestion-batch-meta").textContent = `${formatTimestamp(batch.createdAt)} • ${batch.trigger}`;
    const grid = batchNode.querySelector(".suggestion-grid");

    for (const suggestion of batch.suggestions) {
      const card = els.suggestionCardTemplate.content.firstElementChild.cloneNode(true);
      card.querySelector(".suggestion-kind").textContent = suggestion.kind.replace("_", " ");
      card.querySelector(".suggestion-time").textContent = formatTimestamp(suggestion.createdAt);
      card.querySelector(".suggestion-title").textContent = suggestion.title;
      card.querySelector(".suggestion-preview").textContent = suggestion.preview;
      card.addEventListener("click", () => {
        sendChatQuestion(
          `Suggestion selected: ${suggestion.title}\n\nKind: ${suggestion.kind}\nPreview: ${suggestion.preview}\nRationale: ${suggestion.rationale}`,
          { kind: "suggestion_click", suggestionId: suggestion.id, batchId: batch.id }
        );
      });
      grid.appendChild(card);
    }

    els.suggestionBatches.appendChild(batchNode);
  }
}

function renderChat() {
  els.chatList.innerHTML = "";

  if (!state.chatMessages.length) {
    els.chatList.className = "chat-list empty-state";
    els.chatList.textContent = "Click a suggestion or type a question below.";
    return;
  }

  els.chatList.className = "chat-list";

  for (const message of state.chatMessages) {
    const node = els.chatItemTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add(message.role);
    node.querySelector(".chat-meta").textContent = `${message.role} • ${formatTimestamp(message.timestamp)}`;
    node.querySelector(".chat-text").textContent = message.text;
    els.chatList.appendChild(node);
  }

  els.chatList.scrollTop = els.chatList.scrollHeight;
}

function renderMetrics() {
  els.suggestionsLatencyLabel.textContent = formatLatency(state.metrics.lastSuggestionsLatencyMs);
  els.chatLatencyLabel.textContent = formatLatency(state.metrics.lastChatLatencyMs);
}

function renderStatusMeta() {
  els.refreshMeta.textContent = state.lastStatusMessage;
}

function renderCountdown() {
  if (state.isRecording && state.flushDeadlineMs) {
    const remaining = Math.max(0, Math.ceil((state.flushDeadlineMs - Date.now()) / 1000));
    const label = state.isBusy ? "processing..." : `auto-refresh in ${remaining}s`;
    els.refreshCountdown.textContent = label;
    els.nextFlushLabel.textContent = state.isBusy ? "Processing" : `${remaining}s`;
    return;
  }

  if (state.isBusy) {
    els.refreshCountdown.textContent = "processing...";
    els.nextFlushLabel.textContent = "Processing";
    return;
  }

  els.refreshCountdown.textContent = `auto-refresh every ${state.settings.refreshIntervalSeconds}s`;
  els.nextFlushLabel.textContent = "Waiting";
}

function startCountdownTicker() {
  if (state.countdownIntervalId) {
    clearInterval(state.countdownIntervalId);
  }

  state.countdownIntervalId = window.setInterval(() => {
    renderCountdown();
  }, 500);
}

function updateFlushDeadline() {
  if (!state.isRecording) {
    state.flushDeadlineMs = null;
    return;
  }

  state.flushDeadlineMs = Date.now() + state.settings.chunkSeconds * 1000;
}

function setStatus(message) {
  state.lastStatusMessage = message;
}

function getRecorderOptions() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/mp4",
    "audio/webm",
  ];

  const mimeType = candidates.find((item) => MediaRecorder.isTypeSupported(item));
  return mimeType ? { mimeType } : undefined;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function formatTimestamp(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatLatency(value) {
  return typeof value === "number" ? `${value} ms` : "-";
}

function sanitizeText(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeKind(value) {
  const validKinds = new Set(["question", "talking_point", "answer", "fact_check", "clarification"]);
  return validKinds.has(value) ? value : "clarification";
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : "Something went wrong.";
}
