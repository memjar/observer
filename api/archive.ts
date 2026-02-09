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

// ELON MODE: Smart Archive System
// - GET: Fetch archived messages (paginated)
// - POST: Trigger archive compaction (moves old messages to archive)

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
      const offset = page * limit;

      const snapshot = await firestore
        .collection('team-messages-archive')
        .orderBy('ts', 'desc')
        .offset(offset)
        .limit(limit)
        .get();

      const messages = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          from: data.from || 'unknown',
          msg: data.msg || '',
          to: data.to || 'team',
          type: data.type || 'message',
          ts: data.ts?.toDate?.()?.toISOString() || null,
          archived: true
        };
      });

      // Get total count for pagination
      const countSnap = await firestore.collection('team-messages-archive').count().get();
      const total = countSnap.data().count;

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

      // Get total count
      const countSnap = await firestore.collection('team-messages').count().get();
      const totalMessages = countSnap.data().count;

      if (totalMessages <= KEEP_LIVE) {
        return res.status(200).json({
          success: true,
          message: `No compaction needed. Only ${totalMessages} messages (threshold: ${KEEP_LIVE})`,
          archived: 0
        });
      }

      // Calculate how many to archive (cap at 200 per call to stay within batch limits)
      const toArchive = Math.min(totalMessages - KEEP_LIVE, 200);

      // Get oldest messages to archive
      const oldestSnapshot = await firestore
        .collection('team-messages')
        .orderBy('ts', 'asc')
        .limit(toArchive)
        .get();

      // Batch write to archive and delete from main
      // Firestore batch limit is 500 ops, we do 2 per doc (set + delete) = max 250 docs
      let archivedCount = 0;
      const BATCH_SIZE = 250;
      const docs = oldestSnapshot.docs;

      for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        const chunk = docs.slice(i, i + BATCH_SIZE);
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
