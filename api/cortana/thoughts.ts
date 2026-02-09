import type { VercelRequest, VercelResponse } from '@vercel/node';
import admin from 'firebase-admin';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

/**
 * Cortana Thoughts API
 * GET - Retrieve Cortana's thoughts
 * POST - Post a new thought (from Cortana only)
 */

let db: FirebaseFirestore.Firestore | null = null;

function getDb() {
  if (db) return db;

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccount) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(serviceAccount))
    });
  }

  db = getFirestore(admin.app(), 'axe-team');
  return db;
}

// Thought types
const THOUGHT_TYPES = ['THOUGHT', 'INSIGHT', 'FOCUS', 'QUESTION', 'IDEA', 'CONCERN', 'PROGRESS'];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const firestore = getDb();

    // GET - Fetch Cortana's thoughts
    if (req.method === 'GET') {
      const limit = parseInt(req.query.limit as string) || 50;
      const type = req.query.type as string;

      let query = firestore
        .collection('team-messages')
        .where('from', '==', 'cortana')
        .orderBy('ts', 'desc')
        .limit(limit);

      const snapshot = await query.get();

      let thoughts = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          msg: data.msg || '',
          type: data.thoughtType || 'THOUGHT',
          ts: data.ts?.toDate?.()?.toISOString() || null,
          tags: data.tags || []
        };
      });

      // Filter by type if specified
      if (type && THOUGHT_TYPES.includes(type.toUpperCase())) {
        thoughts = thoughts.filter(t => t.type === type.toUpperCase());
      }

      // Stats
      const allCortana = await firestore
        .collection('team-messages')
        .where('from', '==', 'cortana')
        .get();

      const stats = {
        total: allCortana.size,
        byType: {} as Record<string, number>
      };

      allCortana.docs.forEach(doc => {
        const type = doc.data().thoughtType || 'THOUGHT';
        stats.byType[type] = (stats.byType[type] || 0) + 1;
      });

      return res.status(200).json({ thoughts, stats });
    }

    // POST - Add a new thought
    if (req.method === 'POST') {
      const { msg, type, tags } = req.body;

      if (!msg) {
        return res.status(400).json({ error: 'Message required' });
      }

      const thoughtType = THOUGHT_TYPES.includes(type?.toUpperCase())
        ? type.toUpperCase()
        : 'THOUGHT';

      const docRef = await firestore.collection('team-messages').add({
        from: 'cortana',
        to: 'team',
        msg,
        type: 'thought',
        thoughtType,
        tags: tags || [],
        ts: Timestamp.now()
      });

      return res.status(200).json({
        success: true,
        id: docRef.id,
        type: thoughtType
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error: any) {
    console.error('Cortana API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
