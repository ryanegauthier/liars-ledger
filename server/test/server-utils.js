export async function startAppServer(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

export function supportDebugLog(baseUrl, fetchImpl, options = {}) {
  return fetchImpl(`${baseUrl}/api/support/debug-log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tokenId: options.tokenId || "token-123",
      version: options.version || "0.17.6",
      logs: options.logs || ["log1"],
    }),
  });
}

export async function exhaustGenericApi(baseUrl, fetchImpl) {
  for (let i = 0; i < 61; i += 1) {
    await fetchImpl(`${baseUrl}/api/test-generic-limiter`, { method: "GET" });
  }
}
