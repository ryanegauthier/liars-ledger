import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

async function startAppServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

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
});

afterEach(() => {
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

    const { server, baseUrl } = await startAppServer();
    try {
      const res = await realFetch(`${baseUrl}/api/support/debug-log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId: "token-123", version: "0.17.6", logs: ["log1", "log2"] }),
      });

      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.delivery.email.success).toBe(false);
      expect(body.delivery.webhook.success).toBe(true);
      expect(body.delivery.email.error).toContain("Invalid login");
    } finally {
      server.close();
    }
  });

  it("returns 502 when both email and webhook delivery fail", async () => {
    mockSendMail.mockRejectedValue(new Error("Invalid login"));
    mockFetch.mockResolvedValue({ ok: false, status: 535 });

    const { server, baseUrl } = await startAppServer();
    try {
      const res = await realFetch(`${baseUrl}/api/support/debug-log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId: "token-123", version: "0.17.6", logs: ["log1"] }),
      });

      const body = await res.json();
      expect(res.status).toBe(502);
      expect(body.ok).toBe(false);
      expect(body.delivery.email.success).toBe(false);
      expect(body.delivery.webhook.success).toBe(false);
      expect(body.delivery.email.error).toContain("Invalid login");
      expect(body.delivery.webhook.error).toContain("webhook responded 535");
    } finally {
      server.close();
    }
  });
});
