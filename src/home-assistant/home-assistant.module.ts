import { Module } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
  RESOLVED_OPTIONS_TOKEN,
} from './home-assistant.constants';
import { HomeAssistantService } from './home-assistant.service';
import type {
  HomeAssistantDevice,
  HomeAssistantOptions,
  ResolvedHomeAssistantOptions,
} from './home-assistant.types';

/**
 * Configurable module around {@link HomeAssistantService}.
 *
 * Extends the `ConfigurableModuleClass` produced by
 * `ConfigurableModuleBuilder`, which supplies the standard
 * `forRoot(options)` / `forRootAsync({ useFactory })` entry points
 * and exposes options through `MODULE_OPTIONS_TOKEN`. Device metadata
 * is loaded from the unit-factory JSON before the service is created.
 */
@Module({
  providers: [
    {
      provide: RESOLVED_OPTIONS_TOKEN,
      useFactory: loadHomeAssistantOptions,
      inject: [MODULE_OPTIONS_TOKEN],
    },
    {
      provide: HomeAssistantService,
      useClass: HomeAssistantService,
    },
  ],
  exports: [HomeAssistantService],
})
export class HomeAssistantModule extends ConfigurableModuleClass {}

async function loadHomeAssistantOptions(
  options: HomeAssistantOptions,
): Promise<ResolvedHomeAssistantOptions> {
  const filePath = resolve(options.unitFactoriesFilePath);
  let entries: unknown;
  try {
    entries = JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `[HomeAssistant] failed to load ${filePath}: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(
      `[HomeAssistant] ${filePath} must contain a non-empty array of unit factories`,
    );
  }

  const seenDeviceIds = new Set<string>();
  const seenFactoryNumbers = new Set<string>();
  const devices = entries.map((entry, index): HomeAssistantDevice => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`[HomeAssistant] invalid unit factory at index ${index}`);
    }
    const item = entry as Record<string, unknown>;
    const { deviceId, location, name, unitFactoryNumber } = item;
    if (
      typeof deviceId !== 'string' ||
      !deviceId.trim() ||
      ['/', '+', '#'].some((character) => deviceId.includes(character)) ||
      typeof unitFactoryNumber !== 'string' ||
      !unitFactoryNumber.trim() ||
      typeof name !== 'string' ||
      !name.trim() ||
      (location !== undefined && typeof location !== 'string')
    ) {
      throw new Error(`[HomeAssistant] invalid unit factory at index ${index}`);
    }
    if (seenDeviceIds.has(deviceId) || seenFactoryNumbers.has(unitFactoryNumber)) {
      throw new Error(
        `[HomeAssistant] duplicate deviceId or unitFactoryNumber at index ${index}`,
      );
    }
    seenDeviceIds.add(deviceId);
    seenFactoryNumbers.add(unitFactoryNumber);
    return {
      deviceId,
      sensor: name,
      ...(typeof location === 'string' && location.trim()
        ? { room: location }
        : {}),
    };
  });

  return { ...options, devices };
}
