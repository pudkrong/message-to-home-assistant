/**
 * Allowed `unitFactoryNumber`s and metadata about them. The list is
 * loaded from a JSON file by default; switching to a database is a
 * matter of adding a new branch in the loader (future work).
 */
export type UnitFactoryFilterSource =
  | { type: 'json'; filePath: string }
  | { type: 'database' };

export interface UnitFactoryInfo {
  /** The exact `unitFactoryNumber` we want to accept. */
  unitFactoryNumber: string;
  /** Stable Home Assistant device identifier. */
  deviceId: string;
  /** Optional HA area label. */
  location?: string;
  /** Display name (e.g. room label / device title in HA). */
  name?: string;
  /** Optional human-readable description for logs. */
  description?: string;
}

export interface UnitFactoryFilterOptions {
  source: UnitFactoryFilterSource;
}
