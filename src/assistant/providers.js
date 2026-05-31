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
  constructor({ apiKey, baseUrl = 'https://api.openai.com/v1', model = 'gpt-4.1-mini' } = {}) {
    this.name = 'openai-compatible';
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

export function createChatProvider(config) {
  if (config.openaiApiKey) {
    return new OpenAICompatibleChatProvider({ apiKey: config.openaiApiKey, model: process.env.CHAT_MODEL || 'gpt-4.1-mini' });
  }
  return new MockChatProvider();
}
