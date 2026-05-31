import { ConnectorRegistry } from './base.js';
import { ConferenceBridgeConnector } from './conferenceBridge.js';
import { DataFabricConnector } from './dataFabric.js';
import { EmailConnector } from './email.js';
import { GoogleDriveConnector } from './gdrive.js';
import { KnowledgeBaseConnector } from './knowledgeBase.js';
import { SlackConnector } from './slack.js';

export function createConnectorRegistry(config) {
  return new ConnectorRegistry([
    new SlackConnector(config),
    new GoogleDriveConnector(config),
    new ConferenceBridgeConnector(config),
    new EmailConnector(config),
    new KnowledgeBaseConnector(config),
    new DataFabricConnector(config),
  ]);
}
