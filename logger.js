const SyncLogger = (() => {
  // V10 diagnostic build: persist logs so API/pagination mismatches can be
  // exported from the popup after a run.
  const enabled = true;

  function isEnabled() {
    return enabled;
  }

  async function log(entry) {
    if (!enabled) {
      return {
        timestamp: new Date().toISOString(),
        ...entry
      };
    }

    const normalized = {
      timestamp: new Date().toISOString(),
      ...entry
    };
    try {
      await ExtensionStorage.appendLog(normalized);
    } catch (error) {
      console.error("[ProductSync] Could not persist diagnostic log", error);
    }
    return normalized;
  }

  return {
    isEnabled,
    log
  };
})();
