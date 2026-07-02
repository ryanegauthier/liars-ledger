import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.resetModules();
  mockFetch.mockReset();

  process.env.NODE_ENV = "test";
  process.env.VOTESMART_EMAIL = "test@example.com";
  process.env.VOTESMART_PASSWORD = "test-password";

  globalThis.fetch = mockFetch;
});

afterEach(() => {
  delete process.env.VOTESMART_EMAIL;
  delete process.env.VOTESMART_PASSWORD;
  globalThis.fetch = realFetch;
});

describe("VoteSmart proxy retry behavior", () => {
  it("retries transient 429 responses and succeeds on the next attempt", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "header.payload.signature" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Too many requests",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ candidateId: 123, name: "Jane Doe" }),
      });

    const { votesmart } = await import("../../providers/votesmart.js");
    const result = await votesmart.fetch("/v1/officials/by-lastname?lastName=Doe");

    expect(result).toEqual({ candidateId: 123, name: "Jane Doe" });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[1][0]).toContain("/v1/officials/by-lastname");
  });
});
