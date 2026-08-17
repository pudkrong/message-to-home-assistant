/**
 * Provider-agnostic message subscription port.
 *
 * Both adapters (Azure Service Bus, KubeMQ, ...) implement this
 * shape so the rest of the app can stay broker-blind. The Bridge
 * injects it via {@link MESSAGE_TRANSPORT} and never sees which
 * adapter is in use underneath.
 *
 * Each adapter is responsible for its own delivery semantics:
 *
 *   - Azure Service Bus (queue, peekLock): handlers run in order;
 *     any failure abandons the message so the broker re-delivers.
 *   - KubeMQ (events, fire-and-forget): handlers are invoked
 *     directly with no ack/nack - delivery is at-most-once per
 *     active subscriber.
 *
 * Handlers receive only the parsed `body`. Adding more transports
 * (RabbitMQ, NATS, Kafka, ...) only requires a new adapter; the
 * Bridge and every other consumer remain untouched.
 */
export interface MessageTransport {
  /**
   * Register a handler invoked for every inbound message's parsed
   * `body`. Multiple handlers are supported; the adapter decides
   * what to do if a handler throws (ack, reject, requeue, drop).
   */
  registerHandler(handler: MessageHandler): void;
}

export type MessageHandler = (body: unknown) => Promise<void> | void;
