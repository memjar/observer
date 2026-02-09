import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Web Search API - DuckDuckGo (FREE) with Gemini fallback
 * Usage: GET /api/search?q=your+query
 */

async function searchDuckDuckGo(query: string): Promise<any> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  });

  if (!response.ok) throw new Error('DuckDuckGo API error');

  const text = await response.text();
  if (!text || text.trim() === '') throw new Error('Empty response');

  return JSON.parse(text);
}

async function searchGemini(query: string, apiKey: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `Search query: "${query}". Provide a brief, factual answer (2-3 sentences max). Be concise.`
        }]
      }],
      generationConfig: {
        maxOutputTokens: 150,
        temperature: 0.3
      }
    })
  });

  if (!response.ok) throw new Error('Gemini API error');

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No answer available';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const query = req.query.q as string;
  if (!query) return res.status(400).json({ error: 'Missing ?q= parameter' });

  let summary = '';
  let source = '';
  let success = false;

  // Try DuckDuckGo first (FREE)
  try {
    const data = await searchDuckDuckGo(query);

    if (data.Abstract) {
      summary = data.Abstract;
      source = `DuckDuckGo (${data.AbstractSource || 'Wikipedia'})`;
      success = true;
    } else if (data.Answer) {
      summary = data.Answer;
      source = 'DuckDuckGo Instant Answer';
      success = true;
    } else if (data.Definition) {
      summary = data.Definition;
      source = data.DefinitionSource || 'DuckDuckGo';
      success = true;
    } else if (data.RelatedTopics?.length > 0) {
      const topics = data.RelatedTopics.filter((t: any) => t.Text).slice(0, 3);
      summary = topics.map((t: any) => `• ${t.Text}`).join('\n');
      source = 'DuckDuckGo Related';
      success = true;
    }
  } catch (e) {
    console.log('DuckDuckGo failed, trying Gemini...');
  }

  // Fallback to Gemini if DuckDuckGo didn't return useful results
  if (!success && process.env.GEMINI_API_KEY) {
    try {
      summary = await searchGemini(query, process.env.GEMINI_API_KEY);
      source = 'Gemini Pro (Google)';
      success = true;
    } catch (e) {
      console.log('Gemini also failed');
    }
  }

  // Final fallback
  if (!success) {
    return res.status(200).json({
      success: false,
      query,
      summary: 'No instant answer available.',
      source: 'none',
      fallbackUrl: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
    });
  }

  return res.status(200).json({
    success: true,
    query,
    summary,
    source
  });
}
