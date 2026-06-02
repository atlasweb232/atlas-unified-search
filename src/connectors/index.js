import { ConnectorRegistry } from './base.js';
import { ConferenceBridgeConnector } from './conferenceBridge.js';
import { DataFabricConnector } from './dataFabric.js';
import { EmailConnector } from './email.js';
import { GoogleDriveConnector } from './gdrive.js';
import { KnowledgeBaseConnector } from './knowledgeBase.js';
import { SlackConnector } from './slack.js';
import { createConnectorTokenProvider } from '../tokenProvider.js';

// All connectors are coded, but only the configured `enabledSources` are
// registered/surfaced. Phase 1 = email + slack + google_drive. conference_bridge,
// knowledge_base, and data_fabric stay defined here so a later feature phase can
// enable them via UNIFIED_SEARCH_ENABLED_SOURCES with no code change.
export function createConnectorRegistry(config, { credentialResolver = null } = {}) {
  const tokenProvider = createConnectorTokenProvider(config, { dynamicResolver: credentialResolver });
  const all = [
    new SlackConnector(config, tokenProvider),
    new GoogleDriveConnector(config, tokenProvider),
    new EmailConnector(config),
    new ConferenceBridgeConnector(config),
    new KnowledgeBaseConnector(config),
    new DataFabricConnector(config),
  ];
  const enabled = new Set(config.enabledSources || all.map((connector) => connector.source));
  return new ConnectorRegistry(all.filter((connector) => enabled.has(connector.source)));
}
