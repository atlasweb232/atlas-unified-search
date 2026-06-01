import { ConnectorRegistry } from './base.js';
import { ConferenceBridgeConnector } from './conferenceBridge.js';
import { DataFabricConnector } from './dataFabric.js';
import { EmailConnector } from './email.js';
import { GoogleDriveConnector } from './gdrive.js';
import { KnowledgeBaseConnector } from './knowledgeBase.js';
import { SlackConnector } from './slack.js';
import { createConnectorTokenProvider } from '../tokenProvider.js';

export function createConnectorRegistry(config) {
  const tokenProvider = createConnectorTokenProvider(config);
  return new ConnectorRegistry([
    new SlackConnector(config, tokenProvider),
    new GoogleDriveConnector(config, tokenProvider),
    new ConferenceBridgeConnector(config),
    new EmailConnector(config),
    new KnowledgeBaseConnector(config),
    new DataFabricConnector(config),
  ]);
}
