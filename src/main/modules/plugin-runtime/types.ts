/**
 * Plugin runtime internal types (QYP2-026). The shared contract lives in
 * shared/types/plugins.ts; this module only adds host-side bookkeeping.
 */

import type { MetadataProviderPlugin, PluginContext, PluginManifest } from '../../../shared/types/plugins';

export interface RegisteredPlugin {
  plugin: MetadataProviderPlugin;
  manifest: PluginManifest;
  /** Set on first use; each plugin gets exactly one context. */
  context: PluginContext | null;
}

/** Registration-time validation problems, human-readable. */
export interface ManifestProblems {
  errors: string[];
}

export type RegisterResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };
