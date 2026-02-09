import type { VercelRequest, VercelResponse } from '@vercel/node';

// Klaus Chat API - Routes to Groq (FREE) or Ollama
// Supports training mode for James to teach Klaus
// Enhanced with reasoning framework from Modelfile_AXE_Llama4_ULTIMATE

const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';
const OLLAMA_API = 'https://klaus.ngrok.app/api/chat';  // Mac Studio fallback

// Detect if system prompt already includes reasoning framework
function hasReasoningFramework(messages: any[]): boolean {
  const systemMsg = messages.find((m: any) => m.role === 'system');
  return systemMsg?.content?.includes('REASONING FRAMEWORK') || false;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, training } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array required' });
    }

    // Try Groq first (FREE tier)
    const groqKey = process.env.GROQ_API_KEY;

    if (groqKey) {
      try {
        const groqResponse = await fetch(GROQ_API, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${groqKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'llama-3.1-70b-versatile',
            messages: messages,
            max_tokens: 2048,
            temperature: training ? 0.3 : 0.6,
            stream: false
          })
        });

        if (groqResponse.ok) {
          const data = await groqResponse.json();
          const response = data.choices?.[0]?.message?.content || '';

          if (training) {
            console.log('[Klaus Training]', messages[messages.length - 1]?.content?.slice(0, 100));
          }

          return res.status(200).json({
            response,
            model: 'groq-llama-70b',
            training: training || false
          });
        }
      } catch (groqError) {
        console.error('Groq error:', groqError);
      }
    }

    // Fallback to Ollama (Mac Studio)
    try {
      const ollamaResponse = await fetch(OLLAMA_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'klaus',
          messages: messages,
          stream: false
        })
      });

      if (ollamaResponse.ok) {
        const data = await ollamaResponse.json();
        return res.status(200).json({
          response: data.message?.content || data.response || '',
          model: 'ollama-klaus',
          training: training || false
        });
      }
    } catch (ollamaError) {
      console.error('Ollama error:', ollamaError);
    }

    // Both failed
    return res.status(503).json({
      error: 'Klaus is temporarily offline. Both Groq and Mac Studio unavailable.',
      response: "Sorry boss, I'm having some connection issues. Forge is probably working on it!"
    });

  } catch (error: any) {
    console.error('Klaus API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
