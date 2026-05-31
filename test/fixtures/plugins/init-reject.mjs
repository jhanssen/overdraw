// Fixture: init rejects. The bootstrap reports {ok:false} and the Worker exits;
// the runtime applies the restart policy (init failure counts toward the budget).
export default async function init() {
  throw new Error("intentional init failure");
}
