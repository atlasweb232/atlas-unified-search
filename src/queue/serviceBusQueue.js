import { ServiceBusClient } from '@azure/service-bus';

export class InlineQueue {
  constructor() {
    this.name = 'inline';
  }

  async enqueue(_message) {
    return { backend: this.name };
  }
}

export class ServiceBusQueue {
  constructor({ connectionString, queueName }) {
    this.name = 'azure-service-bus';
    this.queueName = queueName;
    this.client = new ServiceBusClient(connectionString);
    this.sender = this.client.createSender(queueName);
  }

  async enqueue(message) {
    await this.sender.sendMessages({
      body: message,
      contentType: 'application/json',
      subject: 'unified-search-sync',
      correlationId: message.jobId,
      applicationProperties: {
        tenantId: message.tenantId,
        userId: message.userId,
        source: message.source,
      },
    });
    return { backend: this.name, queueName: this.queueName };
  }

  async close() {
    await this.sender.close();
    await this.client.close();
  }

  createReceiver() {
    return this.client.createReceiver(this.queueName);
  }
}

export function createJobQueue(config) {
  if (config.serviceBus?.connectionString && config.serviceBus?.syncQueueName) {
    return new ServiceBusQueue({
      connectionString: config.serviceBus.connectionString,
      queueName: config.serviceBus.syncQueueName,
    });
  }
  return new InlineQueue();
}
