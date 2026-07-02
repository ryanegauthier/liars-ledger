import { afterEach, beforeEach, beforeAll, describe, expect, it, vi } from "vitest";

const {
  mockUpgradeTier,
  mockSetDowngradeReason,
  mockClearDowngradeReason,
  mockClearFailedCharges,
  mockLookupTokenBySquareSubscription,
  mockLookupTokenByOrderTemplate,
  mockStoreSquareSubscriptionMapping,
  mockStoreOrderTemplateMapping,
  mockStoreSquareCustomerMapping,
  mockRecordFailedCharge,
  mockVerifyWebhookSignature,
  mockRetrieveOrder,
  mockCreatePaymentLink,
  mockGetToken,
} = vi.hoisted(() => ({
  mockUpgradeTier: vi.fn(),
  mockSetDowngradeReason: vi.fn(),
  mockClearDowngradeReason: vi.fn(),
  mockClearFailedCharges: vi.fn(),
  mockLookupTokenBySquareSubscription: vi.fn(),
  mockLookupTokenByOrderTemplate: vi.fn(),
  mockStoreSquareSubscriptionMapping: vi.fn(),
  mockStoreOrderTemplateMapping: vi.fn(),
  mockStoreSquareCustomerMapping: vi.fn(),
  mockRecordFailedCharge: vi.fn(),
  mockVerifyWebhookSignature: vi.fn(),
  mockRetrieveOrder: vi.fn(),
  mockCreatePaymentLink: vi.fn(),
  mockGetToken: vi.fn(),
}));

vi.mock("../../providers/store.js", () => ({
  createToken: vi.fn(),
  getToken: mockGetToken,
  getScans: vi.fn(),
  incrementUserCount: vi.fn(),
  getScanLimit: vi.fn(),
  upgradeTier: mockUpgradeTier,
  commitScan: vi.fn(),
  storeOrderTemplateMapping: mockStoreOrderTemplateMapping,
  lookupTokenByOrderTemplate: mockLookupTokenByOrderTemplate,
  storeSquareCustomerMapping: mockStoreSquareCustomerMapping,
  lookupTokenBySquareCustomer: vi.fn(),
  storeSquareSubscriptionMapping: mockStoreSquareSubscriptionMapping,
  lookupTokenBySquareSubscription: mockLookupTokenBySquareSubscription,
  recordFailedCharge: mockRecordFailedCharge,
  clearFailedCharges: mockClearFailedCharges,
  setDowngradeReason: mockSetDowngradeReason,
  clearDowngradeReason: mockClearDowngradeReason,
  getDowngradeReason: vi.fn(),
}));

vi.mock("../../providers/square.js", () => ({
  verifyWebhookSignature: mockVerifyWebhookSignature,
  retrieveOrder: mockRetrieveOrder,
  createPaymentLink: mockCreatePaymentLink,
}));

let app;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  ({ app } = await import("../../index.js"));
});

async function startAppServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyWebhookSignature.mockResolvedValue(true);
  mockLookupTokenByOrderTemplate.mockResolvedValue(null);
  mockLookupTokenBySquareSubscription.mockResolvedValue(null);
  mockRecordFailedCharge.mockResolvedValue({ count: 1, firstFailedAt: "now" });
  mockGetToken.mockResolvedValue({ tier: "free" });
  mockCreatePaymentLink.mockResolvedValue({ payment_link: { url: "https://square.test/checkout", order_id: "order_123" } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Square webhook handling", () => {
  it("rejects webhook requests with an invalid signature", async () => {
    mockVerifyWebhookSignature.mockResolvedValue(false);

    const { server, baseUrl } = await startAppServer();
    try {
      const res = await fetch(`${baseUrl}/webhook/square`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-square-hmacsha256-signature": "bad-signature",
        },
        body: JSON.stringify({ type: "subscription.created", data: { object: { subscription: {} } } }),
      });

      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it("upgrades the token when a subscription becomes active", async () => {
    const tokenId = "token-1234567890";
    mockLookupTokenByOrderTemplate.mockResolvedValue(tokenId);

    const { server, baseUrl } = await startAppServer();
    try {
      const res = await fetch(`${baseUrl}/webhook/square`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-square-hmacsha256-signature": "valid-signature",
        },
        body: JSON.stringify({
          type: "subscription.created",
          data: {
            object: {
              subscription: {
                id: "sub_123",
                customer_id: "cus_123",
                status: "ACTIVE",
                phases: [{ order_template_id: "order_tpl_123" }],
              },
            },
          },
        }),
      });

      expect(res.status).toBe(200);
      expect(mockUpgradeTier).toHaveBeenCalledWith(tokenId, "pro");
    } finally {
      server.close();
    }
  });

  it("downgrades the token after repeated failed charges", async () => {
    const tokenId = "token-0987654321";
    mockLookupTokenBySquareSubscription.mockResolvedValue(tokenId);
    mockRecordFailedCharge.mockResolvedValue({ count: 3, firstFailedAt: "now" });

    const { server, baseUrl } = await startAppServer();
    try {
      const res = await fetch(`${baseUrl}/webhook/square`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-square-hmacsha256-signature": "valid-signature",
        },
        body: JSON.stringify({
          type: "invoice.scheduled_charge_failed",
          data: {
            object: {
              invoice: {
                subscription_id: "sub_456",
              },
            },
          },
        }),
      });

      expect(res.status).toBe(200);
      expect(mockUpgradeTier).toHaveBeenCalledWith(tokenId, "free");
      expect(mockSetDowngradeReason).toHaveBeenCalledWith(tokenId, "payment_failed");
    } finally {
      server.close();
    }
  });

  it("creates a Square checkout link for a valid token", async () => {
    process.env.SQUARE_LOCATION_ID = "loc_123";
    process.env.SQUARE_PLAN_VARIATION_ID = "plan_var_123";

    const { server, baseUrl } = await startAppServer();
    try {
      const res = await fetch(`${baseUrl}/pricing/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "token-1234567890" }),
      });

      expect(res.status).toBe(200);
      expect(mockCreatePaymentLink).toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});
