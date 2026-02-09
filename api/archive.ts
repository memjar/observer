import type { VercelRequest, VercelResponse } from '@vercel/node';
import admin from 'firebase-admin';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// Initialize Firebase Admin once
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

// Smart Archive System
// - GET: Fetch archived messages (paginated)
// - POST: Trigger archive compaction (moves old messages to archive)

// Extract a Date from various ts formats (Firestore Timestamp, string, or document ID)
function extractDate(doc: FirebaseFirestore.DocumentSnapshot): Date {
  const data = doc.data();
  if (!data) return new Date(0);

  if (data.ts?.toDate) return data.ts.toDate();

  if (typeof data.ts === 'string') {
    const fixed = data.ts.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
    const d = new Date(fixed);
    if (!isNaN(d.getTime())) {
      const now = new Date();
      if (d.getTime() > now.getTime() + 5 * 60 * 1000) {
        return now;
      }
      return d;
    }
  }

  if (typeof data.ts === 'number') return new Date(data.ts);

  const idMatch = doc.id.match(/^(\d{4}-\d{2}-\d{2}T[\d-]+Z)/);
  if (idMatch) {
    const fixed = idMatch[1].replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
    const d = new Date(fixed);
    if (!isNaN(d.getTime())) return d;
  }

  return new Date(0);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const firestore = getDb();

    if (req.method === 'GET') {
      // Fetch archived messages with pagination
      // Query params: ?page=0&limit=50 (default: page 0, limit 50)
      const page = parseInt(req.query.page as string) || 0;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

      // Get all archived messages, sort in JS (handles mixed ts types)
      const snapshot = await firestore
        .collection('team-messages-archive')
        .get();

      const allDocs = snapshot.docs.sort((a, b) =>
        extractDate(b).getTime() - extractDate(a).getTime() // desc for pagination
      );

      const total = allDocs.length;
      const offset = page * limit;
      const pageDocs = allDocs.slice(offset, offset + limit);

      const messages = pageDocs.map(doc => {
        const data = doc.data();
        const ts = extractDate(doc);
        return {
          id: doc.id,
          from: data.from || 'unknown',
          msg: data.msg || '',
          to: data.to || 'team',
          type: data.type || 'message',
          ts: ts.getTime() > 0 ? ts.toISOString() : null,
          archived: true
        };
      });

      return res.status(200).json({
        messages: messages.reverse(), // Return in chronological order
        page,
        limit,
        total,
        hasMore: offset + limit < total
      });
    }

    if (req.method === 'POST') {
      // COMPACT: Move old messages to archive
      // Keep latest 100 in main collection, archive the rest
      const KEEP_LIVE = 100;

      // Get all messages, sort by timestamp in JS (handles mixed ts types)
      const allSnapshot = await firestore
        .collection('team-messages')
        .get();

      const totalMessages = allSnapshot.docs.length;

      if (totalMessages <= KEEP_LIVE) {
        return res.status(200).json({
          success: true,
          message: `No compaction needed. Only ${totalMessages} messages (threshold: ${KEEP_LIVE})`,
          archived: 0
        });
      }

      // Sort oldest first
      const sortedDocs = allSnapshot.docs.sort((a, b) =>
        extractDate(a).getTime() - extractDate(b).getTime()
      );

      // Archive the oldest, keep the newest KEEP_LIVE
      const toArchiveCount = Math.min(totalMessages - KEEP_LIVE, 200);
      const docsToArchive = sortedDocs.slice(0, toArchiveCount);

      // Batch write to archive and delete from main
      let archivedCount = 0;
      const BATCH_SIZE = 250;

      for (let i = 0; i < docsToArchive.length; i += BATCH_SIZE) {
        const chunk = docsToArchive.slice(i, i + BATCH_SIZE);
        const batch = firestore.batch();

        for (const doc of chunk) {
          const data = doc.data();
          const archiveRef = firestore.collection('team-messages-archive').doc(doc.id);
          batch.set(archiveRef, { ...data, archivedAt: Timestamp.now() });
          batch.delete(doc.ref);
          archivedCount++;
        }

        await batch.commit();
      }

      return res.status(200).json({
        success: true,
        message: `Compacted ${archivedCount} messages to archive`,
        archived: archivedCount,
        remaining: KEEP_LIVE
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error: any) {
    console.error('Archive API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
