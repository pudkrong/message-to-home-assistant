/**
 * Describes how the module should find its report -> entity mapping.
 *
 * Today only `type: 'json'` is implemented; future types might
 * include `database`, `rest`, etc. Add new branches in
 * {@link ReportMappingSourceFactory} without touching consumers.
 */
export type ReportMappingSource =
  | { type: 'json'; filePath: string }
  | { type: 'database' };

export interface ReportMappingOptions {
  source: ReportMappingSource;
}

/**
 * On-disk shape for `type: 'json'`. Mirrors the example in the
 * task brief: `[{ reportId, description, ... }]`.
 */
export interface ReportDescriptor {
  reportId: number;
  description: string;
  /** Optional HA display name override (defaults to description). */
  name?: string;
  /** Optional HA sensor `device_class` (e.g. `humidity`, `temperature`). */
  deviceClass?: string;
  /** Optional unit of measurement suffix (e.g. `%`, `°C`). */
  unitOfMeasurement?: string;
  /** Optional icon override. */
  icon?: string;
}

