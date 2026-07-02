import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppServer, supportDebugLog, exhaustGenericApi } from "../server-utils.js";

const mockSendMail = vi.fn();
const mockCreateTransport = vi.fn(() => ({ sendMail: mockSendMail }));
const mockFetch = vi.fn();
const realFetch = globalThis.fetch;

vi.mock("nodemailer", () => ({
  default: {
    createTransport: mockCreateTransport,
  },
}));

let app;
let server;
let baseUrl;

beforeEach(async () => {
  vi.resetModules();
  mockSendMail.mockReset();
  mockCreateTransport.mockReset();
  mockFetch.mockReset();

  process.env.NODE_ENV = "test";
  process.env.SMTP_HOST = "smtp.test";
  process.env.SMTP_USER = "user@test.com";
  process.env.SMTP_PASS = "password";
  process.env.SMTP_FROM = "support@test.com";
  process.env.SUPPORT_WEBHOOK_URL = "https://webhook.test/support";

  globalThis.fetch = mockFetch;
  ({ app } = await import("../../index.js"));
  app.get("/api/test-generic-limiter", (req, res) => res.json({ ok: true }));
  ({ server, baseUrl } = await startAppServer(app));
});

afterEach(() => {
  if (server) {
    server.close();
    server = null;
    baseUrl = null;
  }

  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMTP_FROM;
  delete process.env.SUPPORT_WEBHOOK_URL;
  globalThis.fetch = realFetch;
});

describe("Support debug log delivery", () => {
  it("returns ok when email fails but webhook succeeds", async () => {
    mockSendMail.mockRejectedValue(new Error("Invalid login"));
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const res = await supportDebugLog(baseUrl, realFetch, { logs: ["log1", "log2"] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.delivery.email.success).toBe(false);
    expect(body.delivery.webhook.success).toBe(true);
    expect(body.delivery.email.error).toContain("Invalid login");
  });

  it("returns 502 when both email and webhook delivery fail", async () => {
    mockSendMail.mockRejectedValue(new Error("Invalid login"));
    mockFetch.mockResolvedValue({ ok: false, status: 535 });

    const res = await supportDebugLog(baseUrl, realFetch, { logs: ["log1"] });
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.delivery.email.success).toBe(false);
    expect(body.delivery.webhook.success).toBe(false);
    expect(body.delivery.email.error).toContain("Invalid login");
    expect(body.delivery.webhook.error).toContain("webhook responded 535");
  });

  it("rate-limits support debug log uploads", async () => {
    mockSendMail.mockResolvedValue({});
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    let lastResponse;
    for (let i = 0; i < 11; i += 1) {
      lastResponse = await supportDebugLog(baseUrl, realFetch);
    }

    expect(lastResponse.status).toBe(429);
    const body = await lastResponse.json();
    expect(body.error).toMatch(/Too many support requests/);
  });

  it("still accepts support debug log when generic /api limiter is exhausted", async () => {
    mockSendMail.mockResolvedValue({});
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await exhaustGenericApi(baseUrl, realFetch);
    const res = await supportDebugLog(baseUrl, realFetch);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.delivery.webhook.success).toBe(true);
  });
});
