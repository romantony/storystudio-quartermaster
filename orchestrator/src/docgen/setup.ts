/**
 * Builds the doc-gen client and EC2 transport from config, or null when the
 * feature is off. "On" needs all three of: the base URL, the API token, and the
 * webhook secret — without the last the instance's status events would be
 * rejected and every job would be followed by polling alone.
 */
import type { Config } from '../config';
import { DocgenClient } from './client';
import type { Ec2Transport } from './ec2';

export interface DocgenRuntime {
  client: DocgenClient;
  ec2: Ec2Transport;
}

export function docgenEnabled(cfg: Config): boolean {
  return Boolean(cfg.docgenBaseUrl && cfg.docgenApiToken && cfg.docgenCallbackSecret);
}

export function createDocgenRuntime(cfg: Config): DocgenRuntime | null {
  if (!docgenEnabled(cfg)) return null;
  return {
    client: new DocgenClient({ baseUrl: cfg.docgenBaseUrl, token: cfg.docgenApiToken as string }),
    ec2: { instanceId: cfg.docgenInstanceId, region: cfg.docgenRegion },
  };
}
