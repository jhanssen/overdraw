// Fixture: init never settles. The spawn-phase watchdog must terminate the
// Worker and apply the restart policy; without it, load() blocks forever.
export default function init() {
  return new Promise(() => { /* never resolves */ });
}
