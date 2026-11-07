import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

/**
 * One-shot commands must finish when the host is unavailable. The SDK's connection
 * timeout bounds one attempt; its default reconnect policy otherwise retries forever.
 * Long-lived scheduler connections deliberately use their own reconnect policy.
 * @param {import("@getpaseo/client/internal/daemon-client").DaemonClientConfig} config
 */
export function commandClient(config) {
  return new DaemonClient({
    connectTimeoutMs: 10000,
    ...config,
    reconnect: { ...config.reconnect, enabled: false },
  });
}
