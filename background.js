importScripts("storage.js", "logger.js", "api.js");

const CONFIG = {
  maxPages: 1000,
  pageSize: 100,
  maxProductsPerRun: 50000,
  amazonDelayMs: 500,
  defaultUserId: 1,
  defaultAccountId: 1,
  defaultSellerCentralDomain: "sellercentral.amazon.com"
};

const DEFAULT_STATE = {
  status: "idle",
  processing: false,
  currentPage: 1,
  currentAsin: null,
  currentProductId: null,
  activity: "Idle.",
  completed: 0,
  total: 0,
  successful: 0,
  failed: 0,
  tabId: null,
  sellerCentralDomain: CONFIG.defaultSellerCentralDomain,
  lastError: null,
  stoppedReason: null,
  updatedAt: null
};

chrome.runtime.onInstalled.addListener(async () => {
  const state = await ExtensionStorage.getState();
  if (!state) {
    await ExtensionStorage.setState(withTimestamp({ ...DEFAULT_STATE }));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "GET_STATUS":
      return getStatus();
    case "START_SCAN":
      return startScan(message?.sellerCentralDomain);
    case "SET_MARKETPLACE":
      return setMarketplace(message?.sellerCentralDomain);
    case "STOP_SCAN":
      return stopScan("Stopped by user.");
    case "RESET_SCAN":
      return resetScan();
    case "FLOW_LOG":
      await logFlow(message.payload || {});
      return { logged: true };
    default:
      throw new Error(`Unsupported message type: ${message?.type || "unknown"}`);
  }
}

async function getStatus() {
  const state = (await ExtensionStorage.getState()) || { ...DEFAULT_STATE };
  return state;
}

async function startScan(inputDomain) {
  const state = (await ExtensionStorage.getState()) || { ...DEFAULT_STATE };
  if (state.processing) {
    return getStatus();
  }

  // Each V10 export should describe one run and not be mixed with stale data.
  await ExtensionStorage.clearLogs();

  const sellerCentralDomain = normalizeSellerCentralDomain(inputDomain) || state.sellerCentralDomain || CONFIG.defaultSellerCentralDomain;

  await logFlow({
    stage: "start-scan",
    sellerCentralDomain,
    message: `Start Sync clicked for ${sellerCentralDomain}.`
  });

  const tab = await ensureSellerCentralTab(state.tabId, sellerCentralDomain);
  const nextState = withTimestamp({
    ...DEFAULT_STATE,
    status: "running",
    processing: true,
    tabId: tab.id,
    sellerCentralDomain
  });

  await ExtensionStorage.setState(nextState);
  await SyncLogger.log({
    type: "run-start",
    status: "running"
  });

  runSync().catch(async (error) => {
    const currentState = (await ExtensionStorage.getState()) || { ...DEFAULT_STATE };
    await ExtensionStorage.setState(withTimestamp({
      ...currentState,
      processing: false,
      status: "error",
      activity: "Sync stopped with an error.",
      lastError: error.message || "Unexpected sync failure."
    }));
    await SyncLogger.log({
      type: "run-error",
      status: "error",
      failureReason: error.message || "Unexpected sync failure."
    });
  });

  return getStatus();
}

async function stopScan(reason) {
  const state = (await ExtensionStorage.getState()) || { ...DEFAULT_STATE };
  await ExtensionStorage.setState(withTimestamp({
    ...state,
    processing: false,
    status: "stopped",
    activity: "Sync stopped.",
    stoppedReason: reason || null
  }));
  await SyncLogger.log({
    type: "run-stopped",
    status: "stopped",
    failureReason: reason || null
  });
  return getStatus();
}

async function setMarketplace(inputDomain) {
  const sellerCentralDomain = normalizeSellerCentralDomain(inputDomain);
  if (!sellerCentralDomain) {
    throw new Error("Unsupported Seller Central marketplace.");
  }

  const state = (await ExtensionStorage.getState()) || { ...DEFAULT_STATE };
  await ExtensionStorage.setState(withTimestamp({
    ...state,
    sellerCentralDomain
  }));
  return getStatus();
}

async function resetScan() {
  await ExtensionStorage.resetAll();
  await ExtensionStorage.setState(withTimestamp({
    ...DEFAULT_STATE
  }));
  return getStatus();
}

async function runSync() {
  const attemptedProductIds = new Set();
  const skippedPages = new Map();

  for (let pageNo = 1; pageNo <= CONFIG.maxPages; pageNo += 1) {
    const running = await isProcessing();
    if (!running) {
      return getStatus();
    }

    await ExtensionStorage.patchState(withTimestamp({
      currentPage: pageNo,
      activity: `Fetching the next ASIN batch (page ${pageNo})...`
    }));
    const currentState = (await ExtensionStorage.getState()) || { ...DEFAULT_STATE };
    const sellerCentralDomain = currentState.sellerCentralDomain || CONFIG.defaultSellerCentralDomain;
    const countryCode = mapSellerCentralDomainToCountryCode(sellerCentralDomain);
    await logFlow({
      stage: "page-fetch-start",
      pageNo,
      sellerCentralDomain,
      countryCode,
      message: `Fetching NoMPN page ${pageNo} for ${countryCode}.`
    });

    let products;
    let pageFetchAttempt = 0;
    try {
      const response = await CustomProductApi.fetchProductsWithoutMpn(pageNo, CONFIG.pageSize, countryCode);
      products = response.data;
      pageFetchAttempt = response.attempt;
      await logFlow({
        stage: "page-fetch-success",
        pageNo,
        retryCount: Math.max(0, pageFetchAttempt - 1),
        message: `Fetched ${Array.isArray(products) ? products.length : 0} records for page ${pageNo}.`
      });
    } catch (error) {
      await SyncLogger.log({
        type: "page-fetch-failed",
        pageNo,
        status: "failed",
        failureReason: error.message,
        retryCount: CustomProductApi.maxRetries - 1
      });
      throw new Error(`Could not fetch NoMPN page ${pageNo}: ${error.message}`);
    }

    if (!Array.isArray(products) || products.length === 0) {
      await logFlow({
        stage: "page-empty",
        pageNo,
        message: `No records returned for page ${pageNo}. Stopping run.`
      });
      await SyncLogger.log({
        type: "page-empty",
        pageNo,
        status: "completed",
        retryCount: Math.max(0, pageFetchAttempt - 1)
      });
      return finalizeRun("completed", `No records returned on page ${pageNo}.`);
    }

    const receivedCount = products.length;
    const keys = products.map(productKey);
    const batchKeys = new Set();
    const missingIdCount = products.filter((product) => productIdOf(product) === null).length;
    const mpnCounts = { na: 0, null: 0, missing: 0, other: 0 };
    for (const product of products) {
      const mpn = product?.mpn ?? product?.MPN;
      if (product?.mpn === null || product?.MPN === null) mpnCounts.null += 1;
      else if (mpn === undefined) mpnCounts.missing += 1;
      else if (String(mpn).trim().toUpperCase() === "NA") mpnCounts.na += 1;
      else mpnCounts.other += 1;
    }
    await logFlow({
      stage: "page-response-details", pageNo, countryCode, receivedCount, missingIdCount, mpnCounts,
      sampleFields: Object.keys(products[0] || {}).slice(0, 25),
      sampleKeys: keys.slice(0, 5),
      message: `Page ${pageNo}: ${receivedCount} records; ${missingIdCount} without a usable ID.`
    });
    if (keys.some((key) => !key)) {
      throw new Error(`Page ${pageNo} contains a record with neither a usable ID nor ASIN. See page-response-details logs.`);
    }
    // Include ASIN in the identity so reused IDs cannot hide different SKUs.
    products = products.filter((product) => {
      const key = productKey(product);
      if (attemptedProductIds.has(key) || batchKeys.has(key)) return false;
      batchKeys.add(key);
      return true;
    });
    await logFlow({
      stage: "page-filter", pageNo, receivedCount, eligibleCount: products.length,
      skippedCount: receivedCount - products.length,
      message: `Page ${pageNo}: ${products.length} new records; ${receivedCount - products.length} duplicates skipped.`
    });
    if (products.length === 0) {
      const signature = JSON.stringify([...new Set(keys)].sort());
      const previousPage = skippedPages.get(signature);
      if (previousPage !== undefined && previousPage !== pageNo) {
        throw new Error(`Pagination stalled: pages ${previousPage} and ${pageNo} returned the same already-attempted records. Check whether NoMPN honors PageNo and returns unique IDs/ASINs.`);
      }
      skippedPages.set(signature, pageNo);
      continue;
    }
    skippedPages.clear();

    const state = (await ExtensionStorage.getState()) || { ...DEFAULT_STATE };
    await ExtensionStorage.setState(withTimestamp({
      ...state,
      total: Math.min(CONFIG.maxProductsPerRun, (state.total || 0) + products.length)
    }));

    for (const product of products) {
      const currentState = (await ExtensionStorage.getState()) || { ...DEFAULT_STATE };
      if (!currentState.processing) {
        return getStatus();
      }

      if (currentState.completed >= CONFIG.maxProductsPerRun) {
        return finalizeRun("completed", `Reached the ${CONFIG.maxProductsPerRun} product limit.`);
      }

      attemptedProductIds.add(productKey(product));
      await processProduct(product, pageNo, currentState.tabId);
      await delay(CONFIG.amazonDelayMs);
    }

    // Updates can shift pending records to earlier pages; next iteration is page 1.
    await logFlow({ stage: "page-restart", pageNo, message: `Batch finished on page ${pageNo}; rechecking page 1 because updates can shift pending records.` });
    pageNo = 0;
  }

  return finalizeRun("stopped", `Reached page limit ${CONFIG.maxPages}; more records may remain.`);
}

function productIdOf(product) {
  for (const value of [product?.id, product?.Id, product?.productId, product?.ProductId]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function productAsinOf(product) {
  return normalizeAsin(product?.asin) || normalizeAsin(product?.ASIN) || normalizeAsin(product?.Asin);
}

function productKey(product) {
  const id = productIdOf(product);
  const asin = productAsinOf(product).toUpperCase();
  return id === null && !asin ? null : JSON.stringify([id === null ? null : String(id), asin]);
}

async function processProduct(product, pageNo, tabId) {
  const asin = productAsinOf(product);
  const productId = productIdOf(product);
  const state = (await ExtensionStorage.getState()) || { ...DEFAULT_STATE };
  const sellerCentralDomain = state.sellerCentralDomain || CONFIG.defaultSellerCentralDomain;

  if (!asin) {
    await markFailed({
      asin: "",
      pageNo,
      productId,
      failureReason: "Missing ASIN in source API response.",
      amazonRetryCount: 0,
      customApiRetryCount: 0
    });
    return;
  }

  await ExtensionStorage.patchState(withTimestamp({
    currentAsin: asin,
    currentProductId: productId,
    activity: `Processing ASIN ${asin}...`,
    lastError: null,
    stoppedReason: null
  }));
  await logFlow({
    stage: "asin-start",
    asin,
    pageNo,
    productId,
    message: `Processing ASIN ${asin} from page ${pageNo}.`
  });

  try {
    await ensureContentReceiver(tabId);
    await logFlow({
      stage: "content-ready",
      asin,
      pageNo,
      message: `Content script ready for ASIN ${asin}.`
    });

    const amazonResult = await sendMessageToTab(tabId, {
      type: "FETCH_AMAZON_PRODUCT_DETAILS",
      payload: {
        asin,
        sellerCentralDomain
      }
    });

    if (!amazonResult?.ok || !amazonResult?.result) {
      throw new Error(amazonResult?.error || "Amazon data could not be fetched.");
    }

    const parsed = amazonResult.result.product || {};
    await logFlow({
      stage: "amazon-response",
      asin,
      pageNo,
      retryCount: amazonResult.result.retryCount || 0,
      message: `Amazon response received for ${asin}.`
    });

    const savePayload = buildProductPayload({
      asin,
      title: parsed.title,
      brand: parsed.brand,
      mpn: parsed.mpn
    });
    await logFlow({
      stage: "custom-api-save-start",
      asin,
      pageNo,
      message: `Posting parsed details for ${asin} to custom API.`
    });

    let saveResponse;
    try {
      saveResponse = await CustomProductApi.saveProduct(savePayload);
    } catch (error) {
      await markFailed({
        asin,
        pageNo,
        productId,
        failureReason: error.message || "Custom API save failed.",
        amazonRetryCount: amazonResult.result.retryCount || 0,
        customApiRetryCount: extractRetryCount(error)
      });
      return;
    }

    await logFlow({
      stage: "custom-api-save-success",
      asin,
      pageNo,
      retryCount: Math.max(0, (saveResponse?.attempt || 1) - 1),
      message: `Custom API save succeeded for ${asin}.`
    });
    await markSuccess({
      asin,
      pageNo,
      productId,
      parsed,
      amazonRetryCount: amazonResult.result.retryCount || 0,
      customApiRetryCount: Math.max(0, (saveResponse?.attempt || 1) - 1)
    });
  } catch (error) {
    await markFailed({
      asin,
      pageNo,
      productId,
      failureReason: error.message || "Unknown processing error.",
      amazonRetryCount: extractRetryCount(error),
      customApiRetryCount: extractRetryCount(error)
    });
  }
}

async function markSuccess({ asin, pageNo, productId, parsed, amazonRetryCount, customApiRetryCount }) {
  const state = (await ExtensionStorage.getState()) || { ...DEFAULT_STATE };
  await ExtensionStorage.setState(withTimestamp({
    ...state,
    completed: (state.completed || 0) + 1,
    successful: (state.successful || 0) + 1,
    currentAsin: asin,
    currentProductId: productId,
    activity: `Processed ASIN ${asin} successfully.`
  }));

  await SyncLogger.log({
    type: "asin-processed",
    asin,
    pageNo,
    productId,
    status: "success",
    retryCount: Math.max(amazonRetryCount || 0, customApiRetryCount || 0),
    amazonRetryCount: amazonRetryCount || 0,
    customApiRetryCount: customApiRetryCount || 0,
    title: parsed?.title || "",
    brand: parsed?.brand || "",
    mpn: parsed?.mpn || "",
    mpnSource: parsed?.mpnSource || "",
    imageUrl: parsed?.imageUrl || ""
  });
  await logFlow({
    stage: "asin-success",
    asin,
    pageNo,
    productId,
    message: `Finished ASIN ${asin}.`
  });
}

async function markFailed({ asin, pageNo, productId, failureReason, amazonRetryCount, customApiRetryCount }) {
  const fallbackResult = await markAsinAsSkipped({ asin, productId });
  const effectiveFailureReason = buildFailureReasonWithFallback({
    failureReason,
    fallbackResult
  });
  const state = (await ExtensionStorage.getState()) || { ...DEFAULT_STATE };
  await ExtensionStorage.setState(withTimestamp({
    ...state,
    completed: (state.completed || 0) + 1,
    failed: (state.failed || 0) + 1,
    currentAsin: asin || (productId !== null && productId !== undefined ? `(missing; product ID ${productId})` : "(missing)"),
    currentProductId: productId ?? state.currentProductId ?? null,
    activity: asin ? `ASIN ${asin} failed; moving to the next record.` : `Record ${productId ?? "(unknown)"} has no ASIN; moving to the next record.`,
    lastError: effectiveFailureReason || null
  }));

  await SyncLogger.log({
    type: "asin-failed",
    asin,
    pageNo,
    productId,
    status: "failed",
    failureReason: effectiveFailureReason || "Unknown error.",
    retryCount: Math.max(amazonRetryCount || 0, customApiRetryCount || 0),
    amazonRetryCount: amazonRetryCount || 0,
    customApiRetryCount: customApiRetryCount || 0
  });
  await logFlow({
    stage: "asin-failed",
    asin,
    pageNo,
    productId,
    failureReason: effectiveFailureReason || "Unknown error.",
    message: `Failed ASIN ${asin || "(missing)"}: ${effectiveFailureReason || "Unknown error."}`
  });
}

async function markAsinAsSkipped({ asin, productId }) {
  if (!asin) {
    return {
      attempted: false,
      reason: "ASIN missing; could not update MPN to NA."
    };
  }

  try {
    await CustomProductApi.saveProduct(buildFailedProductPayload({ asin, productId }));
    return { attempted: true, success: true };
  } catch (error) {
    return {
      attempted: true,
      success: false,
      reason: error.message || "Fallback NA update failed."
    };
  }
}

function buildFailedProductPayload({ asin, productId }) {
  const payload = buildProductPayload({
    asin,
    title: "NA",
    brand: "NA",
    mpn: "NA"
  });

  if (productId !== null && productId !== undefined) {
    payload.id = productId;
  }

  return payload;
}

function buildProductPayload({ asin, title, brand, mpn }) {
  return {
    asin,
    title: normalizeProductField(title),
    userId: CONFIG.defaultUserId,
    accountId: CONFIG.defaultAccountId,
    brand: normalizeProductField(brand),
    mpn: normalizeProductField(mpn)
  };
}

function buildFailureReasonWithFallback({ failureReason, fallbackResult }) {
  const baseReason = failureReason || "Unknown error.";
  if (!fallbackResult?.attempted) {
    return `${baseReason} ${fallbackResult?.reason || ""}`.trim();
  }

  if (fallbackResult.success) {
    return `${baseReason} MPN updated to NA for skip-on-next-run.`;
  }

  return `${baseReason} Failed to update MPN to NA: ${fallbackResult.reason || "Unknown error."}`;
}

async function finalizeRun(status, reason = null) {
  const state = (await ExtensionStorage.getState()) || { ...DEFAULT_STATE };
  await ExtensionStorage.setState(withTimestamp({
    ...state,
    processing: false,
    status,
    activity: status === "completed" ? "Sync completed." : "Sync stopped.",
    stoppedReason: reason,
    currentAsin: state.currentAsin,
    currentProductId: state.currentProductId
  }));
  await SyncLogger.log({
    type: "run-complete",
    status,
    message: reason,
    processed: state.completed || 0,
    successful: state.successful || 0,
    failed: state.failed || 0
  });
  return getStatus();
}

async function ensureSellerCentralTab(existingTabId, sellerCentralDomain) {
  const targetUrl = buildSellerCentralUrl(sellerCentralDomain);
  if (existingTabId) {
    try {
      const tab = await chrome.tabs.get(existingTabId);
      if (tab?.id) {
        await logFlow({
          stage: "tab-reuse",
          tabId: tab.id,
          message: `Reusing Seller Central tab ${tab.id}.`
        });
        const updatedTab = await chrome.tabs.update(tab.id, { active: true, url: targetUrl });
        await waitForTabComplete(tab.id);
        return updatedTab;
      }
    } catch (_) {
    }
  }

  const tab = await chrome.tabs.create({
    url: targetUrl,
    active: true
  });
  await logFlow({
    stage: "tab-create",
    tabId: tab.id,
    message: `Created Seller Central tab ${tab.id}.`
  });

  await waitForTabComplete(tab.id);
  return tab;
}

async function ensureContentReceiver(tabId) {
  if (!tabId) {
    throw new Error("Seller Central tab is not available.");
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (response?.ok) {
      await logFlow({
        stage: "content-ping-ok",
        tabId,
        message: `Content script already active on tab ${tabId}.`
      });
      return;
    }
  } catch (_) {
    await logFlow({
      stage: "content-ping-miss",
      tabId,
      message: `No content script response on tab ${tabId}. Injecting script.`
    });
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["parser.js", "amazon.js", "content.js"]
  });
  await logFlow({
    stage: "content-injected",
    tabId,
    message: `Injected content script into tab ${tabId}.`
  });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await delay(300);
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "PING" });
      if (response?.ok) {
        await logFlow({
          stage: "content-ready",
          tabId,
          message: `Content script responded on tab ${tabId}.`
        });
        return;
      }
    } catch (_) {
    }
  }

  throw new Error("Could not establish connection to the Seller Central page.");
}

function sendMessageToTab(tabId, message) {
  if (!tabId) {
    throw new Error("Seller Central tab is not available.");
  }

  return chrome.tabs.sendMessage(tabId, message);
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Timed out waiting for Seller Central page to load."));
    }, timeoutMs);

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function isProcessing() {
  const state = (await ExtensionStorage.getState()) || { ...DEFAULT_STATE };
  return state.processing === true;
}

function withTimestamp(state) {
  return {
    ...state,
    updatedAt: new Date().toISOString()
  };
}

function normalizeAsin(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeProductField(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "NA";
}

function normalizeSellerCentralDomain(value) {
  const allowed = new Set([
    "sellercentral.amazon.com",
    "sellercentral.amazon.in"
  ]);
  return allowed.has(value) ? value : "";
}

function mapSellerCentralDomainToCountryCode(sellerCentralDomain) {
  switch (sellerCentralDomain) {
    case "sellercentral.amazon.in":
      return "IN";
    case "sellercentral.amazon.com":
    default:
      return "US";
  }
}

function buildSellerCentralUrl(sellerCentralDomain) {
  return `https://${sellerCentralDomain}/home`;
}

function extractRetryCount(error) {
  const raw = String(error?.message || "");
  const match = raw.match(/retries\s*[:=]?\s*(\d+)/i);
  return match ? Math.max(0, Number(match[1]) - 1) : 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logFlow(payload) {
  const entry = {
    type: "flow",
    status: "info",
    ...payload
  };
  if (!SyncLogger.isEnabled()) {
    return entry;
  }

  console.log("[ProductSync][background]", entry);
  await SyncLogger.log(entry);
  return entry;
}
