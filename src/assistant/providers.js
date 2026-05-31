export class MockChatProvider {
  constructor() {
    this.name = 'mock';
  }

  configured() {
    return true;
  }

  async generate({ actionType, prompt = '', contextResults = [] }) {
    const sourceList = [...new Set(contextResults.map((result) => result.sourceLabel || result.source))].join(', ') || 'no sources';
    const resultLines = contextResults.slice(0, 8).map((result, index) => `${index + 1}. [${result.sourceLabel || result.source}] ${result.oneLine}`).join('\n');
    const actionText = {
      summarize: 'Summary',
      answer_question: 'Answer',
      draft_email: 'Draft email',
      extract_action_items: 'Action items',
      compare_sources: 'Source comparison',
      create_powerpoint: 'PowerPoint outline',
      create_pdf: 'PDF outline',
    }[actionType] || 'Response';
    return {
      text: `${actionText} generated from ${contextResults.length} retrieved result(s) across ${sourceList}.\n\n${prompt ? `Prompt: ${prompt}\n\n` : ''}${resultLines}`,
      citations: contextResults.map((result) => ({ resultId: result.id, documentId: result.documentId })),
      structured: { actionType, resultCount: contextResults.length },
    };
  }
}

export class OpenAICompatibleChatProvider {
  constructor({ apiKey, baseUrl = 'https://api.openai.com/v1', model = 'gpt-4.1-mini', name = 'openai-compatible' } = {}) {
    this.name = name;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
  }

  configured() {
    return Boolean(this.apiKey);
  }

  async generate({ actionType, prompt = '', messages = [], contextResults = [] }) {
    if (!this.configured()) throw new Error('OpenAI-compatible provider is not configured');
    const context = contextResults.map((result) => `[${result.sourceLabel || result.source}] ${result.title}: ${result.oneLine}`).join('\n');
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: `You are an enterprise search assistant. Action: ${actionType}. Cite retrieved result IDs when useful.` },
          { role: 'user', content: `Prompt: ${prompt}\n\nRetrieved context:\n${context}` },
          ...messages,
        ],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || 'Chat provider request failed');
    return {
      text: data.choices?.[0]?.message?.content || '',
      citations: contextResults.map((result) => ({ resultId: result.id, documentId: result.documentId })),
      usage: data.usage || {},
    };
  }
}

export class AzureOpenAIChatProvider extends OpenAICompatibleChatProvider {
  constructor({ apiKey, endpoint, deployment, apiVersion = '2024-06-01', model = '' } = {}) {
    const cleanEndpoint = String(endpoint || '').replace(/\/$/, '');
    super({
      apiKey,
      baseUrl: cleanEndpoint && deployment
        ? `${cleanEndpoint}/openai/deployments/${deployment}`
        : '',
      model: model || deployment,
      name: 'azure-openai',
    });
    this.endpoint = cleanEndpoint;
    this.deployment = deployment;
    this.apiVersion = apiVersion;
  }

  configured() {
    return Boolean(this.apiKey && this.endpoint && this.deployment);
  }

  async generate({ actionType, prompt = '', messages = [], contextResults = [] }) {
    if (!this.configured()) throw new Error('Azure OpenAI provider is not configured');
    const context = contextResults.map((result) => `[${result.sourceLabel || result.source}] ${result.title}: ${result.oneLine}`).join('\n');
    const response = await fetch(`${this.baseUrl}/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`, {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: `You are an enterprise search assistant. Action: ${actionType}. Cite retrieved result IDs when useful.` },
          { role: 'user', content: `Prompt: ${prompt}\n\nRetrieved context:\n${context}` },
          ...messages,
        ],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || 'Azure OpenAI request failed');
    return {
      text: data.choices?.[0]?.message?.content || '',
      citations: contextResults.map((result) => ({ resultId: result.id, documentId: result.documentId })),
      usage: data.usage || {},
    };
  }
}

export class AnthropicChatProvider {
  constructor({ apiKey, baseUrl = 'https://api.anthropic.com', model = 'claude-3-5-sonnet-latest' } = {}) {
    this.name = 'anthropic';
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.model = model;
  }

  configured() {
    return Boolean(this.apiKey);
  }

  async generate({ actionType, prompt = '', contextResults = [] }) {
    if (!this.configured()) throw new Error('Anthropic provider is not configured');
    const context = contextResults.map((result) => `[${result.sourceLabel || result.source}] ${result.title}: ${result.oneLine}`).join('\n');
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1200,
        system: `You are an enterprise search assistant. Action: ${actionType}. Cite retrieved result IDs when useful.`,
        messages: [{ role: 'user', content: `Prompt: ${prompt}\n\nRetrieved context:\n${context}` }],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || 'Anthropic request failed');
    return {
      text: (data.content || []).map((part) => part.text || '').join('\n').trim(),
      citations: contextResults.map((result) => ({ resultId: result.id, documentId: result.documentId })),
      usage: data.usage || {},
    };
  }
}

export function createChatProvider(config) {
  const chat = config.chat || {};
  const provider = String(chat.provider || '').toLowerCase();
  if (provider === 'mock') return new MockChatProvider();
  if (provider === 'azure-openai' || provider === 'azure_openai') {
    return new AzureOpenAIChatProvider({
      apiKey: chat.azureOpenaiApiKey,
      endpoint: chat.azureOpenaiEndpoint,
      deployment: chat.azureOpenaiDeployment,
      apiVersion: chat.azureOpenaiApiVersion,
      model: chat.model,
    });
  }
  if (provider === 'anthropic') {
    return new AnthropicChatProvider({
      apiKey: chat.anthropicApiKey,
      baseUrl: chat.anthropicBaseUrl,
      model: chat.model || 'claude-3-5-sonnet-latest',
    });
  }
  if (provider === 'cerebras') {
    return new OpenAICompatibleChatProvider({
      apiKey: chat.cerebrasApiKey,
      baseUrl: chat.cerebrasBaseUrl,
      model: chat.model || 'llama3.1-8b',
      name: 'cerebras',
    });
  }
  if (chat.openaiApiKey || config.openaiApiKey) {
    return new OpenAICompatibleChatProvider({
      apiKey: chat.openaiApiKey || config.openaiApiKey,
      baseUrl: chat.openaiBaseUrl || 'https://api.openai.com/v1',
      model: chat.model || 'gpt-4.1-mini',
    });
  }
  return new MockChatProvider();
}
