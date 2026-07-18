// Fixture: exercises the Worker console shim. Module-load-time and
// init-time console calls at several levels; the host should receive them
// as "log" events carrying { level, text }.
console.log("module-load line %d", 1);

export default async function init(sdk) {
  console.info("info line");
  console.warn("warn line");
  console.error("error line", { code: 7 });
  sdk.log("sdk-log line");
}
