import type { ModuleMetadata } from '@nestjs/common';
import type { MessagingOptions } from '../messaging/messaging.types';
import type { ReportMappingOptions } from '../report-mapping/report-mapping.types';
import type { UnitFactoryFilterOptions } from '../unit-factory-filter/unit-factory-filter.types';
import type { HomeAssistantOptions } from '../home-assistant/home-assistant.types';

/**
 * Aggregated wiring options for {@link BridgeModule}. Each field
 * is forwarded verbatim to the matching child module's
 * `forRoot/forRootAsync` API.
 *
 * `messaging` is provider-agnostic: pick `provider: 'azure'` or
 * `provider: 'kubemq'` and supply the matching options block. The
 * {@link MessagingModule} resolves to the right adapter without
 * the rest of the app needing to know which broker is in use.
 */
export interface BridgeOptions {
  messaging: MessagingOptions;
  reportMapping: ReportMappingOptions;
  unitFactoryFilter: UnitFactoryFilterOptions;
  homeAssistant: HomeAssistantOptions;
}

export interface BridgeAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (
    ...args: any[]
  ) => Promise<BridgeOptions> | BridgeOptions;
  inject?: any[];
}

/**
 * Shape of a single Service Bus / KubeMQ message body.
 *
 * Kept defensive: the broker may carry messages produced under
 * different `version`s; we verify structure before using it. The
 * same shape works for both transports because both carry UTF-8
 * JSON.
 */
export interface PayloadV1 {
  unitFactoryNumber: string;
  version: number;
  timestamp: string;
  data: Array<{ reportId: number; value: number }>;
}

export function isPayloadV1(value: unknown): value is PayloadV1 {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj['unitFactoryNumber'] !== 'string') return false;
  if (typeof obj['version'] !== 'number') return false;
  if (typeof obj['timestamp'] !== 'string') return false;
  if (!Array.isArray(obj['data'])) return false;
  return (obj['data'] as unknown[]).every(
    (item) =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as { reportId: unknown }).reportId === 'number' &&
      typeof (item as { value: unknown }).value === 'number',
  );
}
