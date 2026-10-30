(function interceptNetwork() {
  if (window.__amazonApprovalInterceptorInstalled) {
    return;
  }

  window.__amazonApprovalInterceptorInstalled = true;

  const post = (payload) => {
    window.postMessage({
      source: "amazon-approval-interceptor",
      payload: {
        ...payload,
        timestamp: Date.now()
      }
    }, "*");
  };

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const method = init?.method || (typeof input !== "string" ? input?.method : "GET") || "GET";
    const requestBody = init?.body || null;

    try {
      const response = await originalFetch.apply(this, arguments);
      const clone = response.clone();
      const responseText = await clone.text().catch(() => "");

      post({
        transport: "fetch",
        url,
        method,
        requestBody,
        status: response.status,
        responseBody: responseText
      });

      return response;
    } catch (error) {
      post({
        transport: "fetch",
        url,
        method,
        requestBody,
        error: error.message
      });
      throw error;
    }
  };

  const OriginalXhrOpen = XMLHttpRequest.prototype.open;
  const OriginalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__amazonApprovalMeta = {
      method,
      url
    };
    return OriginalXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    const meta = this.__amazonApprovalMeta || {};
    this.addEventListener("loadend", function onLoadEnd() {
      post({
        transport: "xhr",
        url: meta.url,
        method: meta.method,
        requestBody: body || null,
        status: this.status,
        responseBody: this.responseText
      });
    });

    return OriginalXhrSend.apply(this, arguments);
  };
})();
