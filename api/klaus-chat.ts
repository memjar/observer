import type { VercelRequest, VercelResponse } from '@vercel/node';

// Klaus Chat API - Routes to Groq (FREE) or Ollama (Mac Studio)
// Supports training mode and preferOllama for Mac Studio priority
// Enhanced with reasoning framework from Modelfile_AXE_Llama4_ULTIMATE

const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';
const KLAUS_BASE = 'https://hdr.it.com.ngrok.pro';
const OLLAMA_API = `${KLAUS_BASE}/klaus/chat`;  // Mac Studio via FastAPI

async function tryGroq(messages: any[], training: boolean, groqKey: string): Promise<any | null> {
  try {
    const response = await fetch(GROQ_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-70b-versatile',
        messages,
        max_tokens: 2048,
        temperature: training ? 0.3 : 0.6,
        stream: false
      })
    });

    if (response.ok) {
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '';
      if (training) {
        console.log('[Klaus Training]', messages[messages.length - 1]?.content?.slice(0, 100));
      }
      return { response: content, model: 'groq-llama-70b', training: training || false };
    }
  } catch (e) {
    console.error('Groq error:', e);
  }
  return null;
}

async function tryOllama(messages: any[], training: boolean): Promise<any | null> {
  try {
    const response = await fetch(OLLAMA_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'klaus',
        messages,
        stream: false
      })
    });

    if (response.ok) {
      const data = await response.json();
      return {
        response: data.message?.content || data.response || '',
        model: 'ollama-klaus',
        training: training || false
      };
    }
  } catch (e) {
    console.error('Ollama error:', e);
  }
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET = health check via /klaus/status
  if (req.method === 'GET') {
    let ollamaStatus: any = { online: false };
    try {
      const statusRes = await fetch(`${KLAUS_BASE}/klaus/status`, { signal: AbortSignal.timeout(5000) });
      if (statusRes.ok) {
        ollamaStatus = await statusRes.json();
        ollamaStatus.online = true;
      }
    } catch (e) {
      // Mac Studio unreachable
    }
    const groqUp = !!process.env.GROQ_API_KEY;
    return res.status(200).json({
      ollama: ollamaStatus.online ? 'online' : 'offline',
      ollamaDetails: ollamaStatus,
      groq: groqUp ? 'configured' : 'no-key',
      timestamp: Date.now()
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, training, preferOllama } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array required' });
    }

    const groqKey = process.env.GROQ_API_KEY;

    if (preferOllama) {
      // Mac Studio first, Groq fallback
      const ollamaResult = await tryOllama(messages, training || false);
      if (ollamaResult) return res.status(200).json(ollamaResult);

      if (groqKey) {
        const groqResult = await tryGroq(messages, training || false, groqKey);
        if (groqResult) return res.status(200).json(groqResult);
      }
    } else {
      // Groq first (free tier), Ollama fallback
      if (groqKey) {
        const groqResult = await tryGroq(messages, training || false, groqKey);
        if (groqResult) return res.status(200).json(groqResult);
      }

      const ollamaResult = await tryOllama(messages, training || false);
      if (ollamaResult) return res.status(200).json(ollamaResult);
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
