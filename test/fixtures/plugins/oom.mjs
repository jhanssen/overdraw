// Fixture: a plugin that exceeds its heap cap after going live. The Worker's
// resourceLimits.maxOldGenerationSizeMb makes V8 abort the isolate; the runtime
// sees the Worker die and applies the restart policy.
export default async function init(sdk) {
  sdk.log("oom plugin live; will exceed heap cap");
  const sink = [];
  setTimeout(() => {
    // Retain large allocations so they can't be GC'd, driving old-gen past the cap.
    for (;;) { sink.push(new Array(1_000_000).fill(sink.length)); }
  }, 50);
}
