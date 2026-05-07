// Silence all console output — third-party libraries must not write to the
// terminal. User-facing messages go through p.log.* or process.stdout.write;
// debug/operational logs go through logger.* (file only).
const noop = () => {};
console.log   = noop;
console.info  = noop;
console.warn  = noop;
console.error = noop;
console.debug = noop;
