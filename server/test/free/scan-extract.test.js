import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
const realFetch = globalThis.fetch;

const mockLookup = vi.fn();
vi.mock("node:dns", () => ({
  default: { promises: { lookup: (...args) => mockLookup(...args) } },
  promises: { lookup: (...args) => mockLookup(...args) },
}));

// Public, well-known IPs used across cases below - not exercised for real
// network access since globalThis.fetch is mocked.
const PUBLIC_IP  = "93.184.216.34";
const PRIVATE_IP = "10.0.0.5";

function htmlWithArticle(title, body) {
  return `<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${body}</p></article></body></html>`;
}

function fakeResponse({ status = 200, headers = {}, text }) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headerMap.get(k.toLowerCase()) ?? null },
    text: async () => text,
    body: null, // forces the readBodyWithLimit() fallback path (res.text())
  };
}

beforeEach(() => {
  vi.resetModules();
  mockFetch.mockReset();
  mockLookup.mockReset();
  globalThis.fetch = mockFetch;
  // Default: any hostname resolves to a public address, individual tests
  // override this to exercise the SSRF-blocking paths.
  mockLookup.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("extractArticleTextPublic - input validation", () => {
  it("rejects a malformed URL", async () => {
    const { extractArticleTextPublic, ArticleFetchError } = await import("../../providers/articleFetch.js");
    await expect(extractArticleTextPublic("not a url")).rejects.toThrow(ArticleFetchError);
    await expect(extractArticleTextPublic("not a url")).rejects.toMatchObject({ code: "ERR-INVALID-URL" });
  });

  it("rejects a non-http(s) scheme", async () => {
    const { extractArticleTextPublic } = await import("../../providers/articleFetch.js");
    await expect(extractArticleTextPublic("file:///etc/passwd")).rejects.toMatchObject({ code: "ERR-INVALID-URL" });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("extractArticleTextPublic - SSRF guard", () => {
  it("rejects a literal private IP in the URL, without ever calling fetch", async () => {
    const { extractArticleTextPublic } = await import("../../providers/articleFetch.js");
    await expect(extractArticleTextPublic(`http://${PRIVATE_IP}/`)).rejects.toMatchObject({ code: "ERR-BLOCKED" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects a literal loopback/link-local IP (cloud metadata address)", async () => {
    const { extractArticleTextPublic } = await import("../../providers/articleFetch.js");
    await expect(extractArticleTextPublic("http://169.254.169.254/latest/meta-data")).rejects.toMatchObject({ code: "ERR-BLOCKED" });
  });

  it("rejects a hostname that resolves to a private address", async () => {
    mockLookup.mockResolvedValue([{ address: PRIVATE_IP, family: 4 }]);
    const { extractArticleTextPublic } = await import("../../providers/articleFetch.js");
    await expect(extractArticleTextPublic("http://internal.example.com/")).rejects.toMatchObject({ code: "ERR-BLOCKED" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects when a redirect points at a private address, even if the original host was public", async () => {
    // First hop: public host, returns a redirect to a private address.
    mockLookup.mockResolvedValueOnce([{ address: PUBLIC_IP, family: 4 }]);
    mockFetch.mockResolvedValueOnce(fakeResponse({
      status: 302,
      headers: { location: "http://10.0.0.5/internal" },
      text: "",
    }));
    // Second hop's DNS check would resolve the private literal IP directly
    // (no lookup needed for a literal IP), so no second mockLookup entry
    // is required - assertHostIsPublic short-circuits on net.isIP().
    const { extractArticleTextPublic } = await import("../../providers/articleFetch.js");
    await expect(extractArticleTextPublic("http://public.example.com/")).rejects.toMatchObject({ code: "ERR-BLOCKED" });
    expect(mockFetch).toHaveBeenCalledTimes(1); // never followed the bad redirect
  });

  it("stops following redirects past the cap", async () => {
    mockFetch.mockResolvedValue(fakeResponse({
      status: 302,
      headers: { location: "http://public.example.com/next" },
      text: "",
    }));
    const { extractArticleTextPublic } = await import("../../providers/articleFetch.js");
    await expect(extractArticleTextPublic("http://public.example.com/start")).rejects.toMatchObject({ code: "ERR-NET" });
    // MAX_REDIRECTS = 3, so the guard fetches the original + 3 hops = 4 calls before giving up.
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe("extractArticleTextPublic - size and content limits", () => {
  it("rejects a response whose Content-Length exceeds the cap", async () => {
    mockFetch.mockResolvedValue(fakeResponse({
      headers: { "content-length": String(3 * 1024 * 1024) }, // 3MB > 2MB cap
      text: "irrelevant",
    }));
    const { extractArticleTextPublic } = await import("../../providers/articleFetch.js");
    await expect(extractArticleTextPublic("http://public.example.com/big")).rejects.toMatchObject({ code: "ERR-TOO-LARGE" });
  });

  it("rejects a page with no extractable article content", async () => {
    mockFetch.mockResolvedValue(fakeResponse({ text: "<html><body></body></html>" }));
    const { extractArticleTextPublic } = await import("../../providers/articleFetch.js");
    await expect(extractArticleTextPublic("http://public.example.com/empty")).rejects.toMatchObject({ code: "ERR-NO-CONTENT" });
  });

  it("never echoes raw HTML - only structured {title, text} comes back", async () => {
    const html = htmlWithArticle("Senator Does a Thing", "The senator voted yes on the bill. ".repeat(20));
    mockFetch.mockResolvedValue(fakeResponse({ text: html }));
    const { extractArticleTextPublic } = await import("../../providers/articleFetch.js");
    const result = await extractArticleTextPublic("http://public.example.com/article");

    expect(Object.keys(result).sort()).toEqual(["text", "title"]);
    expect(result.title).toBe("Senator Does a Thing");
    expect(result.text).not.toContain("<p>");
    expect(result.text).not.toContain("<article>");
    expect(result.text).toContain("The senator voted yes");
  });
});
