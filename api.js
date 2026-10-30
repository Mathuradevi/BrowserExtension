const CustomProductApi = (() => {
  const apiBaseUrl = "http://89.117.20.71/WebAPI/Product";
  const pageFetchMaxRetries = 3;
  const asinOperationMaxRetries = 1;

  async function fetchProductsWithoutMpn(pageNo, pageSize, countryCode) {
    const url = `${apiBaseUrl}/NoMPN?PageNo=${encodeURIComponent(pageNo)}&PageSize=${encodeURIComponent(pageSize)}&countryCode=${encodeURIComponent(countryCode)}`;
    const response = await request(url, {
      method: "GET"
    }, pageFetchMaxRetries);

    if (!Array.isArray(response.data)) {
      throw new Error("NoMPN API returned an unexpected response.");
    }

    return response;
  }

  async function saveProduct(payload) {
    return request(`${apiBaseUrl}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }, asinOperationMaxRetries);
  }

  async function request(url, options, maxRetries) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      try {
        await SyncLogger.log({ type: "api-request", url, method: options.method, attempt });
        const response = await fetch(url, { ...options, signal: controller.signal });
        await SyncLogger.log({ type: "api-response", url, method: options.method, attempt, httpStatus: response.status, elapsedMs: Date.now() - startedAt });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        return {
          data: await parseResponseBody(response),
          attempt
        };
      } catch (error) {
        if (controller.signal.aborted) error = new Error("Request timed out after 25 seconds.");
        await SyncLogger.log({ type: "api-error", url, method: options.method, attempt, elapsedMs: Date.now() - startedAt, failureReason: error.message });
        lastError = error;
        if (attempt === maxRetries) {
          throw new Error(buildFailureMessage("Request failed.", maxRetries, error));
        }
        await delay(500 * attempt);
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError || new Error("Request failed.");
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function buildFailureMessage(prefix, maxRetries, error) {
    const suffix = error?.message || "Unknown error.";
    if (maxRetries <= 1) {
      return `${prefix} ${suffix}`;
    }

    return `${prefix} Retries: ${maxRetries}. ${suffix}`;
  }

  async function parseResponseBody(response) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return response.json();
    }

    const text = await response.text();
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (_) {
      return text;
    }
  }

  return {
    fetchProductsWithoutMpn,
    saveProduct,
    maxRetries: pageFetchMaxRetries,
    asinOperationMaxRetries
  };
})();
