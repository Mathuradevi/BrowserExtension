const elements = {
  scanButton: document.getElementById("scanButton"),
  stopButton: document.getElementById("stopButton"),
  resetButton: document.getElementById("resetButton"),
  exportButton: document.getElementById("exportButton"),
  marketplaceSelect: document.getElementById("marketplaceSelect"),
  statusBadge: document.getElementById("statusBadge"),
  progressText: document.getElementById("progressText"),
  activityText: document.getElementById("activityText"),
  currentAsin: document.getElementById("currentAsin"),
  successfulCount: document.getElementById("successfulCount"),
  failedCount: document.getElementById("failedCount"),
  lastError: document.getElementById("lastError"),
  pauseReason: document.getElementById("pauseReason")
};

elements.scanButton.addEventListener("click", () => sendAction("START_SCAN", {
  sellerCentralDomain: elements.marketplaceSelect.value
}));
elements.stopButton.addEventListener("click", () => sendAction("STOP_SCAN"));
elements.resetButton.addEventListener("click", () => sendAction("RESET_SCAN"));
elements.exportButton.addEventListener("click", exportLogs);
elements.marketplaceSelect.addEventListener("change", () => sendAction("SET_MARKETPLACE", {
  sellerCentralDomain: elements.marketplaceSelect.value
}));

document.addEventListener("DOMContentLoaded", async () => {
  await refreshStatus();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.approvalState?.newValue) {
    renderStatus(changes.approvalState.newValue);
  }
});

async function sendAction(type, extra = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type, ...extra });
    if (!response?.ok) {
      throw new Error(response?.error || "Action failed.");
    }
    await refreshStatus();
  } catch (error) {
    console.error(error);
    elements.lastError.textContent = error.message || "Action failed.";
  }
}

async function refreshStatus() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (!response?.ok) {
    elements.lastError.textContent = response?.error || "Could not read extension status.";
    return;
  }

  renderStatus(response.result);
}

function renderStatus(state) {
  const status = state.status || "idle";
  const sellerCentralDomain = state.sellerCentralDomain || "sellercentral.amazon.com";
  elements.statusBadge.textContent = capitalize(status);
  elements.statusBadge.className = `badge ${status}`;
  elements.marketplaceSelect.value = sellerCentralDomain;
  elements.progressText.textContent = `${state.completed || 0} / ${state.total || 0}`;
  elements.activityText.textContent = state.activity || "-";
  elements.currentAsin.textContent = state.currentAsin || "-";
  elements.successfulCount.textContent = state.successful || 0;
  elements.failedCount.textContent = state.failed || 0;
  elements.lastError.textContent = state.lastError || "-";
  elements.pauseReason.textContent = state.stoppedReason || "-";
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function exportLogs() {
  try {
    const logs = await ExtensionStorage.getLogs();
    if (logs.length === 0) {
      elements.lastError.textContent = "No diagnostic logs are available yet.";
      return;
    }

    const jsonl = `${logs.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    const url = URL.createObjectURL(new Blob([jsonl], { type: "application/x-ndjson" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `product-sync-v10-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error(error);
    elements.lastError.textContent = error.message || "Could not export diagnostic logs.";
  }
}

