/**
 * The seam between "respond to Intercom" and "do the slow work".
 *
 * Intercom allows roughly 5 seconds for a webhook response and retries a failed
 * delivery once, about a minute later. An AI call plus a Slack post can exceed
 * that budget, so the route acknowledges first and processes afterwards.
 *
 * The route calls `await defer(task)`. A `Defer` that returns `void` lets the
 * response flush immediately and the work continue on the event loop; one that
 * returns the promise makes the route wait.
 *
 * On a long-lived Node process, {@link backgroundDefer} is correct.
 *
 * On a serverless platform the process may be frozen the moment the response is
 * returned, which would silently drop the work. Swapping this one function is
 * the whole port:
 *
 *   Cloudflare Workers / Vercel Edge : (task) => { ctx.waitUntil(task()); }
 *   AWS Lambda (no response streaming): use `awaitingDefer` and accept that
 *                                       processing counts against Intercom's
 *                                       ~5s budget
 *   Google Cloud Run (min instances)  : `backgroundDefer` is fine
 */
export type Defer = (task: () => Promise<void>) => void | Promise<void>;

/**
 * Default: start the task, return immediately. The task handles its own errors;
 * the catch here exists only so a bug in that contract cannot produce an
 * unhandled rejection that takes the process down.
 */
export const backgroundDefer: Defer = (task) => {
  void (async () => {
    try {
      await task();
    } catch {
      // Intentionally swallowed: the pipeline logs its own failures.
    }
  })();
};

/**
 * Runs the task to completion before the route responds. Used by tests for
 * determinism, and by runtimes that freeze after the response is sent. The
 * tradeoff is that slow AI or Slack calls count against Intercom's response
 * budget, which can trigger its retry.
 */
export const awaitingDefer: Defer = async (task) => {
  try {
    await task();
  } catch {
    // Same contract as above.
  }
};
