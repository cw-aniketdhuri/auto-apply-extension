// sidepanel.js

const resumeTextarea = document.getElementById('master-resume');
const statusBox = document.getElementById('status-box');
const runBtn = document.getElementById('vision-apply-btn');
const stopBtn = document.getElementById('stop-btn');

chrome.storage.local.get(['masterResume'], (result) => {
  if (result.masterResume) resumeTextarea.value = result.masterResume;
});

resumeTextarea.addEventListener('input', () => {
  chrome.storage.local.set({ masterResume: resumeTextarea.value });
});

runBtn.addEventListener('click', runAutofillWorkflow);

async function runAutofillWorkflow() {
  const masterResume = resumeTextarea.value.trim();
  if (!masterResume) {
    showStatus("Please paste your resume first!", "red");
    return;
  }

  setExecutionState(true);
  showStatus("🔌 Initiating debugger session & scanning DOM...", "#7c3aed");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    showStatus("Error: No active tab context found.", "red");
    setExecutionState(false);
    return;
  }

  // 1. Send ONE signal to start the entire session (Discovery + Generation + Execution)
  chrome.runtime.sendMessage({
    action: "START_FULL_AUTOFILL_SESSION",
    tabId: tab.id,
    resumeText: masterResume
  }, (response) => {
    setExecutionState(false);

    if (chrome.runtime.lastError) {
      showStatus(`Execution Error: ${chrome.runtime.lastError.message}`, "red");
      return;
    }

    if (response?.status === "SUCCESS") {
      showStatus("🎉 Verification completed! Form fields have been filled perfectly.", "#166534");
    } else if (response?.status === "INTERRUPTED") {
      showStatus("🛑 Process stopped by user.", "#b45309");
    } else {
      showStatus(`CDP Error: ${response?.error || "Unknown Error"}`, "red");
    }
  });
}

stopBtn.addEventListener('click', stopAutomation);
window.addEventListener('keydown', (e) => {
  if (e.key === "Escape" && stopBtn.style.display === "flex") {
    stopAutomation();
  }
});

function stopAutomation() {
  showStatus("Stopping...", "#ef4444");
  chrome.runtime.sendMessage({ action: "STOP_VISION_ACTIONS" });
}

function setExecutionState(isRunning) {
  if (isRunning) {
    runBtn.disabled = true;
    runBtn.style.opacity = "0.5";
    stopBtn.style.display = "flex";
  } else {
    runBtn.disabled = false;
    runBtn.style.opacity = "1";
    stopBtn.style.display = "none";
  }
}

function showStatus(text, color) {
  statusBox.style.display = "block";
  statusBox.style.color = color === "red" ? "#991b1b" : (color === "#166534" ? "#166534" : "#4c1d95");
  statusBox.style.backgroundColor = color === "red" ? "#fef2f2" : (color === "#166534" ? "#f0fdf4" : "#f5f3ff");
  statusBox.innerText = text;
}
