import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ServiceBusService } from '../service-bus/service-bus.service';
import { ReportMappingService } from '../report-mapping/report-mapping.service';
import { UnitFactoryFilterService } from '../unit-factory-filter/unit-factory-filter.service';
import { HomeAssistantService } from '../home-assistant/home-assistant.service';
import { isPayloadV1 } from './bridge.types';

/**
 * Glues the four modules together:
 *
 *   ServiceBus  ──►  UnitFactoryFilter  ──►  ReportMapping  ──►  HomeAssistant
 *
 * This class is project-specific - the reusable modules above stay
 * untouched. A different project can swap in a different Bridge and
 * keep all of the inputs/outputs.
 */
@Injectable()
export class BridgeService implements OnModuleInit {
  private readonly logger = new Logger(BridgeService.name);

  constructor(
    private readonly serviceBus: ServiceBusService,
    private readonly reportMapping: ReportMappingService,
    private readonly unitFactoryFilter: UnitFactoryFilterService,
    private readonly homeAssistant: HomeAssistantService,
  ) {}

  onModuleInit(): void {
    this.serviceBus.onMessage((body) => this.handle(body));
    this.logger.log('Bridge ready');
  }

  private async handle(body: unknown): Promise<void> {
    if (!isPayloadV1(body)) {
      this.logger.warn(
        `Discarding message with unexpected payload shape: ${summarise(body)}`,
      );
      return;
    }

    if (!this.unitFactoryFilter.isAllowed(body.unitFactoryNumber)) {
      this.logger.debug?.(
        `Skipping message for unitFactoryNumber=${body.unitFactoryNumber} (not allowed)`,
      );
      return;
    }

    let published = 0;
    for (const item of body.data) {
      const descriptor = this.reportMapping.get(item.reportId);
      if (!descriptor) continue;

      const objectId = descriptor.description;
      await this.homeAssistant.publishEntityState(
        {
          objectId,
          name: descriptor.name ?? descriptor.description,
          ...(descriptor.deviceClass ? { deviceClass: descriptor.deviceClass } : {}),
          ...(descriptor.unitOfMeasurement
            ? { unitOfMeasurement: descriptor.unitOfMeasurement }
            : {}),
          ...(descriptor.icon ? { icon: descriptor.icon } : {}),
        },
        item.value,
        body.timestamp,
      );
      published++;
    }

    this.logger.log(
      `unitFactory=${body.unitFactoryNumber} ts=${body.timestamp} -> published ${published} sensor updates`,
    );
  }
}

function summarise(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 200);
  } catch {
    return String(value).slice(0, 200);
  }
}
