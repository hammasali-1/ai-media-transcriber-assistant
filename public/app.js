const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const answerEl = document.getElementById("answer");
const themeToggleBtn = document.getElementById("themeToggle");
const copyTranscriptBtn = document.getElementById("copyTranscriptBtn");
const downloadTranscriptBtn = document.getElementById("downloadTranscriptBtn");
const downloadAnswerBtn = document.getElementById("downloadAnswerBtn");
const formatSelect = document.getElementById("formatSelect");
const loaderEl = document.getElementById("loader");

const tabButtons = Array.from(document.querySelectorAll('.tab-button'));
const tabContents = {
  youtube: document.getElementById('tab-youtube'),
  upload: document.getElementById('tab-upload'),
  workspace: document.getElementById('tab-workspace')
};

function openTab(name) {
  tabButtons.forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === name));
  Object.entries(tabContents).forEach(([key, el]) => el.classList.toggle('active', key === name));
}

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => openTab(btn.getAttribute('data-tab')));
});

function showLoader(text) {
  if (loaderEl) {
    loaderEl.classList.remove('hidden');
    const t = loaderEl.querySelector('.loader-text');
    if (t) t.textContent = text || 'Processing...';
  }
}

function hideLoader() {
  if (loaderEl) loaderEl.classList.add('hidden');
}

function markdownToHtml(md) {
  let html = md;
  html = html.replace(/^###\s?(.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s?(.*)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s?(.*)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\n-\s(.*)/g, '<ul><li>$1</li></ul>');
  html = html.replace(/\n\d+\.\s(.*)/g, '<ol><li>$1</li></ol>');
  html = html.replace(/\n{2,}/g, '<br/>');
  return html;
}

function setTheme(mode) {
  if (mode === 'light') document.body.classList.add('light');
  else document.body.classList.remove('light');
  localStorage.setItem('theme', mode);
}

const savedTheme = localStorage.getItem('theme') || 'dark';
setTheme(savedTheme);
if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', () => {
    const next = document.body.classList.contains('light') ? 'dark' : 'light';
    setTheme(next);
  });
}

if (copyTranscriptBtn) {
  copyTranscriptBtn.addEventListener('click', async () => {
    const text = transcriptEl.value.trim();
    if (!text) return;
    await navigator.clipboard.writeText(text);
    statusEl.textContent = 'Transcript copied to clipboard.';
  });
}

if (downloadTranscriptBtn) {
  downloadTranscriptBtn.addEventListener('click', async () => {
    const text = transcriptEl.value.trim();
    if (!text) return;
    const type = formatSelect ? formatSelect.value : 'txt';
    const resp = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, content: text, filename: 'transcript' })
    });
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript.${type}`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

if (downloadAnswerBtn) {
  downloadAnswerBtn.addEventListener('click', async () => {
    const text = answerEl.textContent ? answerEl.textContent : answerEl.innerText;
    const clean = text.trim();
    if (!clean) return;
    const type = formatSelect ? formatSelect.value : 'txt';
    const resp = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, content: clean, filename: 'answer' })
    });
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `answer.${type}`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

document.getElementById("transcribeYoutubeBtn").addEventListener("click", async () => {
  const youtubeUrl = document.getElementById("youtubeUrl").value.trim();
  if (!youtubeUrl) {
    alert("Please paste a YouTube URL.");
    return;
  }
  statusEl.textContent = "Downloading video and transcribing...";
  answerEl.textContent = "";
  transcriptEl.value = "";
  transcriptEl.classList.add('skeleton');
  showLoader('Transcribing YouTube');
  try {
    const resp = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ youtubeUrl })
    });
    const data = await resp.json();
    if (!resp.ok) {
      const details = data.details ? `: ${data.details}` : "";
      const hint = data.hint ? ` — ${data.hint}` : "";
      throw new Error((data.error || "Transcription failed") + details + hint);
    }
    transcriptEl.value = data.text || "";
    statusEl.textContent = "Transcription complete.";
    openTab('workspace');
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
  } finally {
    transcriptEl.classList.remove('skeleton');
    hideLoader();
  }
});

document.getElementById("uploadTranscribeBtn").addEventListener("click", async () => {
  const fileInput = document.getElementById("audioFile");
  const file = fileInput.files[0];
  if (!file) {
    alert("Please choose an audio or video file.");
    return;
  }
  statusEl.textContent = "Uploading file and transcribing...";
  answerEl.textContent = "";
  transcriptEl.value = "";
  transcriptEl.classList.add('skeleton');
  showLoader('Transcribing Upload');
  const formData = new FormData();
  formData.append("audio", file);
  try {
    const resp = await fetch("/api/transcribe", {
      method: "POST",
      body: formData
    });
    const data = await resp.json();
    if (!resp.ok) {
      const details = data.details ? `: ${data.details}` : "";
      const hint = data.hint ? ` — ${data.hint}` : "";
      throw new Error((data.error || "Transcription failed") + details + hint);
    }
    transcriptEl.value = data.text || "";
    statusEl.textContent = "Transcription complete.";
    openTab('workspace');
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
  } finally {
    transcriptEl.classList.remove('skeleton');
    hideLoader();
  }
});

document.getElementById("askBtn").addEventListener("click", async () => {
  const transcript = transcriptEl.value.trim();
  const question = document.getElementById("question").value.trim();
  if (!transcript) {
    alert("No transcript available. Transcribe first.");
    return;
  }
  if (!question) {
    alert("Please enter a question.");
    return;
  }
  answerEl.textContent = "Thinking...";
  showLoader('Answering');
  try {
    const resp = await fetch("/api/qa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, transcript })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "QA failed");
    answerEl.innerHTML = markdownToHtml(data.answer || "(No answer)");
    openTab('workspace');
  } catch (err) {
    answerEl.textContent = "Error: " + err.message;
  } finally { hideLoader(); }
});