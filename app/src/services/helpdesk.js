export class HelpdeskApiError extends Error {
  constructor(status, pathname, retryAfter = null) {
    super(`Helpdesk API request failed with status ${status}`);
    this.name = "HelpdeskApiError";
    this.status = status;
    this.pathname = pathname;
    this.retryAfter = retryAfter;
  }
}

export class HelpdeskClient {
  constructor({
    baseUrl = process.env.HELPDESK_URL || "http://localhost:4010",
    token = process.env.HELPDESK_TOKEN || "",
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  // GET a path (e.g. "/some/endpoint") with optional query params; returns parsed JSON.
  async get(pathname, params = {}) {
    const url = new URL(this.baseUrl + pathname);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
        },
      });
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 5) {
        const retryHeader = res.headers.get("retry-after");
        const retryAfter = retryHeader === null ? Number.NaN : Number(retryHeader);
        const delay = res.status === 429 && Number.isFinite(retryAfter) && retryAfter >= 0
          ? retryAfter * 1000
          : Math.min(1000 * (2 ** attempt), 30_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (!res.ok) {
        throw new HelpdeskApiError(res.status, pathname, res.headers.get("retry-after"));
      }
      return res.json();
    }
  }
}
