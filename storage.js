const ExtensionStorage = (() => {
  let logQueue = Promise.resolve();
  const maxLogEntries = 2000;
  async function get(keys) {
    return chrome.storage.local.get(keys);
  }

  async function set(values) {
    return chrome.storage.local.set(values);
  }

  async function remove(keys) {
    return chrome.storage.local.remove(keys);
  }

  async function getState() {
    const data = await get(["approvalState"]);
    return data.approvalState || null;
  }

  async function setState(state) {
    return set({ approvalState: state });
  }

  async function patchState(partial) {
    const current = (await getState()) || {};
    const next = { ...current, ...partial };
    await setState(next);
    return next;
  }

  async function getLogs() {
    const data = await get(["approvalLogs"]);
    return Array.isArray(data.approvalLogs) ? data.approvalLogs : [];
  }

  function appendLog(log) {
    const operation = logQueue.then(async () => {
      const logs = await getLogs();
      // Bound both individual text fields and history to avoid storage exhaustion.
      const bounded = JSON.parse(JSON.stringify(log, (key, value) =>
        typeof value === "string" ? value.slice(0, 1000) : value));
      logs.push(bounded);
      const retained = logs.slice(-maxLogEntries);
      await set({ approvalLogs: retained });
      return retained;
    });
    logQueue = operation.catch(() => {});
    return operation;
  }

  async function clearLogs() {
    await logQueue;
    await set({ approvalLogs: [] });
  }

  async function resetAll() {
    await logQueue;
    await remove(["approvalState", "approvalLogs"]);
  }

  return {
    get,
    set,
    remove,
    getState,
    setState,
    patchState,
    getLogs,
    appendLog,
    clearLogs,
    resetAll
  };
})();
