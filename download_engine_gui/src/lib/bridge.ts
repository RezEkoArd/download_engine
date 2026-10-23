import { invoke } from "@tauri-apps/api/core";
import type { BridgeInfo } from "../types";

/** Port and pairing token, without starting the listener. */
export function bridgeInfo(): Promise<BridgeInfo> {
  return invoke<BridgeInfo>("bridge_info");
}

/**
 * Opens or closes the loopback port the extension talks to.
 *
 * Rejects when the port is already taken by something else, which is worth
 * showing: the alternative is a toggle that looks on while nothing listens.
 */
export function setBridgeEnabled(enabled: boolean): Promise<BridgeInfo> {
  return invoke<BridgeInfo>("set_bridge_enabled", { enabled });
}
