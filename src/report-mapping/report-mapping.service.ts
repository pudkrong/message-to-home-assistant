import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'node:fs/promises';
import { MODULE_OPTIONS_TOKEN } from './report-mapping.constants';
import type {
  ReportDescriptor,
  ReportMappingOptions,
} from './report-mapping.types';

/**
 * Looks up the {@link ReportDescriptor} for a given Service Bus
 * `reportId`. The actual backing source is chosen by the factory
 * so the service itself can stay source-agnostic.
 */
@Injectable()
export class ReportMappingService implements OnModuleInit {
  private readonly logger = new Logger(ReportMappingService.name);
  private readonly byReportId = new Map<number, ReportDescriptor>();

  constructor(
    @Inject(MODULE_OPTIONS_TOKEN)
    private readonly options: ReportMappingOptions,
  ) {}

  async onModuleInit(): Promise<void> {
    const source = this.options.source;
    if (source.type === 'json') {
      await this.loadFromJson(source.filePath);
    } else {
      throw new Error(
        `[ReportMapping] source type "${source.type}" is not implemented yet`,
      );
    }
    this.logger.log(
      `Loaded ${this.byReportId.size} report mappings from ${describeSource(source)}`,
    );
  }

  /** Returns the descriptor for `reportId` or `undefined` if unmapped. */
  get(reportId: number): ReportDescriptor | undefined {
    return this.byReportId.get(reportId);
  }

  /** Iterate over every loaded descriptor. */
  entries(): IterableIterator<ReportDescriptor> {
    return this.byReportId.values();
  }

  private async loadFromJson(filePath: string): Promise<void> {
    const raw = await fs.readFile(filePath, 'utf-8');
    let list: unknown;
    try {
      list = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `[ReportMapping] failed to parse ${filePath}: ${(err as Error).message}`,
      );
    }
    if (!Array.isArray(list)) {
      throw new Error(
        `[ReportMapping] ${filePath} must be a JSON array of report descriptors`,
      );
    }
    for (const item of list) {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof (item as ReportDescriptor).reportId !== 'number' ||
        typeof (item as ReportDescriptor).description !== 'string'
      ) {
        this.logger.warn(
          `Skipping malformed entry: ${JSON.stringify(item).slice(0, 120)}`,
        );
        continue;
      }
      const d = item as ReportDescriptor;
      this.byReportId.set(d.reportId, d);
    }
  }
}

function describeSource(source: ReportMappingOptions['source']): string {
  return source.type === 'json' ? `file:${source.filePath}` : `db:${source.type}`;
}
