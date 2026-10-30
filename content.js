const PRODUCT_SYNC_LOGGING_ENABLED = false;

if (!window.__amazonProductSyncContentLoaded) {
  window.__amazonProductSyncContentLoaded = true;
  logFlow({
    stage: "content-loaded",
    message: "Content script loaded."
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleRuntimeMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
}

async function handleRuntimeMessage(message) {
  if (message?.type === "PING") {
    logFlow({
      stage: "ping",
      message: "Received background ping."
    });
    return { ok: true };
  }

  if (message?.type !== "FETCH_AMAZON_PRODUCT_DETAILS") {
    return { ok: false, ignored: true };
  }

  if (detectCaptcha()) {
    throw new Error("Captcha detected on Seller Central.");
  }

  if (isLoggedOut()) {
    throw new Error("Seller Central session is not authenticated.");
  }

  const asin = message?.payload?.asin;
  const sellerCentralDomain = message?.payload?.sellerCentralDomain;
  if (!asin) {
    throw new Error("ASIN is required.");
  }

  await logFlow({
    stage: "amazon-request-start",
    asin,
    sellerCentralDomain,
    message: `Calling reconciledDetailsV3 for ${asin}.`
  });
  const result = await AmazonSellerCentralApi.fetchProductDetails(asin, sellerCentralDomain);
  await logFlow({
    stage: "amazon-request-success",
    asin,
    retryCount: result?.retryCount || 0,
    title: result?.product?.title || "",
    brand: result?.product?.brand || "",
    mpn: result?.product?.mpn || "",
    mpnSource: result?.product?.mpnSource || "",
    message: `Amazon API returned data for ${asin}.`
  });
  return {
    ok: true,
    result
  };
}

function detectCaptcha() {
  const text = document.body?.innerText || "";
  return /captcha|enter the characters you see below|type the characters you see in this image/i.test(text);
}

function isLoggedOut() {
  const text = document.body?.innerText || "";
  return /sign in|login|enter your password/i.test(text) && /seller central/i.test(text);
}

async function logFlow(payload) {
  if (!PRODUCT_SYNC_LOGGING_ENABLED) {
    return payload;
  }

  const entry = {
    type: "FLOW_LOG",
    payload
  };
  console.log("[ProductSync][content]", payload);
  try {
    await chrome.runtime.sendMessage(entry);
  } catch (_) {
  }
}
