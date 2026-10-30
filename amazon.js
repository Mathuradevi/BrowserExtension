const AmazonSellerCentralApi = (() => {
  const maxRetries = 1;

  async function fetchProductDetails(asin, sellerCentralDomain) {
    const origin = buildSellerCentralOrigin(sellerCentralDomain);
    const url = `${origin}/abis/ajax/reconciledDetailsV3?asin=${encodeURIComponent(asin)}&conditionType=new`;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          method: "GET",
          credentials: "include",
          headers: {
            "Accept": "application/json, text/plain, */*"
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const raw = await response.json();
        return {
          asin,
          retryCount: attempt - 1,
          raw,
          product: AmazonProductParser.parse(raw)
        };
      } catch (error) {
        if (controller.signal.aborted) error = new Error("Amazon request timed out after 25 seconds.");
        lastError = error;
        if (attempt === maxRetries) {
          throw new Error(buildFailureMessage("Amazon request failed.", maxRetries, error));
        }
        await delay(500 * attempt);
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError || new Error("Amazon request failed.");
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function buildSellerCentralOrigin(sellerCentralDomain) {
    if (sellerCentralDomain === "sellercentral.amazon.in" || sellerCentralDomain === "sellercentral.amazon.com") {
      return `https://${sellerCentralDomain}`;
    }

    return window.location.origin;
  }

  function buildFailureMessage(prefix, maxRetries, error) {
    const suffix = error?.message || "Unknown error.";
    if (maxRetries <= 1) {
      return `${prefix} ${suffix}`;
    }

    return `${prefix} Retries: ${maxRetries}. ${suffix}`;
  }

  return {
    fetchProductDetails,
    maxRetries
  };
})();
