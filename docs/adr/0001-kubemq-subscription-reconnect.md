# ADR-0001: App-owned resubscription for KubeMQ Events

- Status: Superseded by the v1.4 RxJS subscription adapter
- Date: 2026-08-29
- Area: Messaging / KubeMQ Events adapter

## Context

`KubeMqEventsService` (in `src/messaging/kubemq-events.service.ts`) subscribes to a
single KubeMQ events channel via `kubemq-js` v3.0.1. After a dropped connection we
observed a single `ERROR [KubeMqEventsService] KubeMQ subscription error: Connection
dropped` log, after which the app **kept running but stopped receiving events**, with
no crash and no re-delivery.

This v3-specific decision was superseded when the adapter moved to
`kubemq-js` v1.4.0. The current implementation wraps the v1 callback subscription
in an RxJS observable and owns retries by creating a fresh `EventsClient`.

The expectation — based on the SDK's documentation — was that the client would
reconnect indefinitely and the subscription would resume on its own.

### Root cause

`kubemq-js`'s automatic reconnect + resubscribe path is driven entirely by the gRPC
**channel** connectivity state machine, not by individual subscription streams:

1. `subscribeToEvents` registers each subscription in the SDK's internal
   `subscriptionTracker` with a `resubscribe` callback and attaches
   `stream.on("error")` which only forwards to the caller's `onError` handler
   (`index.cjs` ~line 8382/8394).
2. The **only** trigger for `subscriptionTracker.resubscribeAll()` is
   `handleTransientFailure()`, which runs when `watchChannelState()` observes the
   whole gRPC channel enter `TRANSIENT_FAILURE` (`index.cjs` ~line 6022/5971).
3. When only the server **stream** dies (KubeMQ broker restart, a load balancer
   closing an idle/dropped stream), the underlying channel may never enter
   `TRANSIENT_FAILURE`. Only `onError` fires; the SDK never re-subscribes.

Our service was merely logging the error, so the subscription stayed dead and events
stopped arriving while the process remained healthy.

## Decision

Take ownership of resubscription in `KubeMqEventsService` and stop relying on the
SDK's channel-state-based resubscribe:

- `onModuleInit` creates the `KubeMQClient` once and then calls a `subscribe()`
  helper instead of wiring the subscription inline.
- `subscribe()`'s `onError` handler increments a backoff counter and calls
  `scheduleReconnect()` rather than only logging.
- `scheduleReconnect()` cancels the dead stream and, after a capped exponential
  backoff (`1s` → `30s`) with jitter, creates a fresh subscription — retrying
  indefinitely.
- A `closed` flag plus a cleared pending timer prevent reconnect attempts during
  `onApplicationShutdown`.

This makes recovery robust to both stream-level drops and whole-channel drops,
independent of the SDK's internal reconnection state machine.

## Consequences

### Positive

- The subscriber recovers from a KubeMQ broker restart / connection drop and resumes
  receiving events without a process restart.
- Recovery also handles SDK versions where the channel-state watcher fails to trip for
  stream-only failures.
- Jitter avoids thundering-herd reconnects across multiple consumer replicas.
- Shutdown remains clean: no reconnect after `onApplicationShutdown`.

### Negative / Trade-offs

- **No durability during downtime.** KubeMQ events remain fire-and-forget; events
  published while the connection is down are still lost. Applications requiring
  at-least-once semantics must use the Azure Service Bus queue adapter instead.
- Resubscription is app-managed, so reconnect tuning (backoff base, cap, jitter) now
  lives in our code and must be kept in mind on SDK upgrades.
- Best-effort coalescing means a burst of stream errors collapses into a single
  pending reconnect; duplicate-delivery after reconnect has not been observed but
  should be verified if stream `onError` ever fires more than once per subscription.

## Alternatives considered

- **Rely on the SDK's built-in reconnect.** Documented as auto-reconnecting, but
  empirically only resubscribes on channel-level `TRANSIENT_FAILURE`; does not cover
  stream-only drops — the observed failure mode. Rejected.
- **Restart the whole `KubeMQClient` on error.** More heavyweight and offers no
  benefit over re-subscribing because the SDK already recreates its internal gRPC
  client on channel drops. Deferred unless reconnect-on-the-same-client is ever shown
  insufficient.
