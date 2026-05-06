import darwin from "./darwin";
import linux from "./linux";
import type { PlatformOps } from "./types";

const SUPPORTED = {
  darwin,
  linux,
} satisfies Partial<Record<NodeJS.Platform, PlatformOps>>;

type SupportedPlatform = keyof typeof SUPPORTED;

let _cached: PlatformOps | null = null;

export function platform(): PlatformOps {
  if (_cached) return _cached;

  const p = process.platform as SupportedPlatform;
  if (!(p in SUPPORTED)) {
    console.error(
      `Unsupported platform: "${process.platform}". claude-relay supports macOS (darwin) and Linux.`,
    );
    process.exit(1);
  }

  _cached = SUPPORTED[p];
  return _cached;
}
