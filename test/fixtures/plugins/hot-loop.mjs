// Fixture: a plugin that becomes LIVE, then wedges its event loop in a hot loop.
// init resolves first (so the runtime sees it reach `live`), then a timer fires
// and spins forever -> the Worker stops draining messages -> the core's watchdog
// sees missed pongs and terminates it.
//
// The loop does trivial work (not an empty `while(true){}`) so V8's interrupt
// checks run and worker.terminate() can stop it; an empty counted loop is the
// pathological case for any preemption mechanism.
export default async function init(sdk) {
  sdk.log("hot-loop plugin live; will wedge shortly");
  setTimeout(() => {
    let x = 0;
    // eslint not run on fixtures; intentional infinite loop with side effect.
    for (;;) { x += Math.random(); if (x === -1) break; }
  }, 50);
}
