// Silence all console output — third-party libraries must not write to the
// terminal. User-facing messages go through p.log.* or process.stdout.write;
// debug/operational logs go through logger.* (file only).
//
// Using defineProperty (getter returns noop, setter is a noop) so that ink's
// synchronizedOutput feature — which temporarily swaps console methods during
// React render cycles — cannot restore a live writer.
const noop = () => {};
for (const key of ["log", "info", "warn", "error", "debug"] as const) {
  Object.defineProperty(console, key, {
    get: () => noop,
    set: () => {},
    configurable: true,
    enumerable: true,
  });
}
