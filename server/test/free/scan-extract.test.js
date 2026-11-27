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
      headers: { "content-length": String(9 * 1024 * 1024) }, // 9MB > 8MB download cap
      text: "irrelevant",
    }));
    const { extractArticleTextPublic } = await import("../../providers/articleFetch.js");
    await expect(extractArticleTextPublic("http://public.example.com/big")).rejects.toMatchObject({ code: "ERR-TOO-LARGE" });
  });

  it("scans a page over the parse cap when most of it is script and CSS (the CNN case)", async () => {
    // ~4.5MB raw, like a real CNN article page: the article is a sliver,
    // the rest is inline script and style that stripNonContent removes.
    const bulk = "x".repeat(1024 * 1024);
    const html = htmlWithArticle("Single Payer Gets a Second Wind", "The senator voted yes on the bill. ".repeat(20))
      .replace("<head>", `<head><script>${bulk}${bulk}</script><style>${bulk}</style>`)
      .replace("</body>", `<script>${bulk}</script><svg>${"<path/>".repeat(50000)}</svg></body>`);
    expect(html.length).toBeGreaterThan(4 * 1024 * 1024);
    mockFetch.mockResolvedValue(fakeResponse({ headers: { "content-length": String(html.length) }, text: html }));
    const { extractArticleTextPublic } = await import("../../providers/articleFetch.js");
    const result = await extractArticleTextPublic("http://public.example.com/cnn");
    expect(result.title).toBe("Single Payer Gets a Second Wind");
    expect(result.text).toContain("The senator voted yes");
  });

  it("rejects a page that is still over the parse cap after stripping", async () => {
    const html = htmlWithArticle("Huge", "word ".repeat(600 * 1024)); // ~3MB of real text
    mockFetch.mockResolvedValue(fakeResponse({ text: html }));
    const { extractArticleTextPublic } = await import("../../providers/articleFetch.js");
    await expect(extractArticleTextPublic("http://public.example.com/huge")).rejects.toMatchObject({ code: "ERR-TOO-LARGE" });
  });

  it("enforces the download cap when the response has no Content-Length or stream", async () => {
    mockFetch.mockResolvedValue(fakeResponse({ text: "a".repeat(9 * 1024 * 1024) }));
    const { extractArticleTextPublic } = await import("../../providers/articleFetch.js");
    await expect(extractArticleTextPublic("http://public.example.com/nolength")).rejects.toMatchObject({ code: "ERR-TOO-LARGE" });
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

describe("stripNonContent", () => {
  it("removes script, style, svg, and comments, case-insensitively, keeping the content", async () => {
    const { stripNonContent } = await import("../../providers/articleFetch.js");
    const html = `<p>a</p><SCRIPT src="x.js">var s = "<p>no</p>";</Script ><p>b</p><style media="all">p{}</STYLE>`
      + `<svg viewBox="0 0 1 1"><path d="M0"/></svg><!-- note <p>no</p> --><p>c</p>`;
    expect(stripNonContent(html)).toBe("<p>a</p><p>b</p><p>c</p>");
  });

  it("keeps JSON-LD scripts, which Readability reads metadata from", async () => {
    const { stripNonContent } = await import("../../providers/articleFetch.js");
    const ld = `<script type="application/ld+json">{"headline":"H"}</script>`;
    expect(stripNonContent(`${ld}<script>x()</script><p>a</p>`)).toBe(`${ld}<p>a</p>`);
  });

  it("drops the rest of the document after an unclosed element, like a browser", async () => {
    const { stripNonContent } = await import("../../providers/articleFetch.js");
    expect(stripNonContent("<p>a</p><script>never closed <p>b</p>")).toBe("<p>a</p>");
    expect(stripNonContent("<p>a</p><!-- never closed <p>b</p>")).toBe("<p>a</p>");
  });

  it("stays linear on hostile input (many unclosed openers, no '>')", async () => {
    const { stripNonContent } = await import("../../providers/articleFetch.js");
    const hostile = "<script".repeat(1_000_000); // 7MB, under the download cap
    const t0 = Date.now();
    stripNonContent(hostile);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
