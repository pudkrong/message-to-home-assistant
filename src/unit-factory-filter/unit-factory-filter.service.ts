import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'node:fs/promises';
import { MODULE_OPTIONS_TOKEN } from './unit-factory-filter.constants';
import type {
  UnitFactoryFilterOptions,
  UnitFactoryInfo,
} from './unit-factory-filter.types';

/**
 * Decides whether an inbound Service Bus message belongs to one of
 * the configured unit factory numbers.
 *
 * Today only `type: 'json'` is implemented; the {@link UnitFactoryFilterSource}
 * union was designed to grow a `database` branch without changing
 * consumers.
 */
@Injectable()
export class UnitFactoryFilterService implements OnModuleInit {
  private readonly logger = new Logger(UnitFactoryFilterService.name);
  private readonly byNumber = new Map<string, UnitFactoryInfo>();

  constructor(
    @Inject(MODULE_OPTIONS_TOKEN)
    private readonly options: UnitFactoryFilterOptions,
  ) {}

  async onModuleInit(): Promise<void> {
    const source = this.options.source;
    if (source.type === 'json') {
      await this.loadFromJson(source.filePath);
    } else {
      throw new Error(
        `[UnitFactoryFilter] source type "${source.type}" is not implemented yet`,
      );
    }
    this.logger.log(
      `Loaded ${this.byNumber.size} allowed unit factory numbers`,
    );
  }

  /** True if `unitFactoryNumber` is in the allow-list. */
  isAllowed(unitFactoryNumber: string): boolean {
    return this.byNumber.has(unitFactoryNumber);
  }

  /** Returns the info for `unitFactoryNumber` or `undefined`. */
  get(unitFactoryNumber: string): UnitFactoryInfo | undefined {
    return this.byNumber.get(unitFactoryNumber);
  }

  private async loadFromJson(filePath: string): Promise<void> {
    const raw = await fs.readFile(filePath, 'utf-8');
    let list: unknown;
    try {
      list = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `[UnitFactoryFilter] failed to parse ${filePath}: ${(err as Error).message}`,
      );
    }
    if (!Array.isArray(list)) {
      throw new Error(
        `[UnitFactoryFilter] ${filePath} must be a JSON array of unit factory entries`,
      );
    }
    for (const item of list) {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof (item as UnitFactoryInfo).unitFactoryNumber !== 'string'
      ) {
        this.logger.warn(
          `Skipping malformed entry: ${JSON.stringify(item).slice(0, 120)}`,
        );
        continue;
      }
      const info = item as UnitFactoryInfo;
      this.byNumber.set(info.unitFactoryNumber, info);
    }
  }
}
