import { Injectable } from '@nestjs/common';
import { ServiceBusService } from '../service-bus/service-bus.service';
import { MessageHandler, MessageTransport } from './messaging.transport';

/**
 * Thin adapter that exposes {@link ServiceBusService} via the
 * provider-agnostic {@link MessageTransport} port.
 *
 * `ServiceBusService` keeps its existing `onMessage(handler)`
 * shape (so it remains a usable standalone module - nothing in
 * `src/service-bus/` changes). Anything that wants to be
 * provider-agnostic injects {@link MESSAGE_TRANSPORT} instead and
 * receives this adapter.
 */
@Injectable()
export class AzureServiceBusAdapter implements MessageTransport {
  constructor(private readonly bus: ServiceBusService) {}

  registerHandler(handler: MessageHandler): void {
    this.bus.onMessage(handler);
  }
}
