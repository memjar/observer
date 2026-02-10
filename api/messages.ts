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

// Merge window: if same agent sends again within this many seconds, append to previous message
const MERGE_WINDOW_SECONDS = 60;

// Extract a Date from various ts formats (Firestore Timestamp, string, or document ID)
function extractDate(doc: FirebaseFirestore.DocumentSnapshot): Date {
  const data = doc.data();
  if (!data) return new Date(0);

  // Firestore Timestamp
  if (data.ts?.toDate) return data.ts.toDate();

  // String timestamp (ISO or daemon format like "2026-02-09T01-10-00Z")
  if (typeof data.ts === 'string') {
    // Convert daemon format: 2026-02-09T01-10-00Z → 2026-02-09T01:10:00Z
    const fixed = data.ts.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
    const d = new Date(fixed);
    if (!isNaN(d.getTime())) {
      // Cap future-dated string timestamps at current time
      // (daemon wrote local time as UTC, creating future dates)
      const now = new Date();
      if (d.getTime() > now.getTime() + 5 * 60 * 1000) {
        return now;
      }
      return d;
    }
  }

  // Numeric timestamp
  if (typeof data.ts === 'number') return new Date(data.ts);

  // Fallback: extract from document ID (format: 2026-02-09T01-10-00Z_agent)
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const firestore = getDb();

    if (req.method === 'GET') {
      // Get recent messages (collection kept small by compaction, ~100 docs)
      // Don't use orderBy('ts') — daemon writes string ts, API writes Timestamp ts,
      // Firestore separates by type and breaks ordering across both sources
      // Limit to 200 as safety net in case compaction falls behind
      const snapshot = await firestore
        .collection('team-messages')
        .limit(200)
        .get();

      // Sort in JS using our universal timestamp extractor
      const sortedDocs = snapshot.docs.sort((a, b) =>
        extractDate(a).getTime() - extractDate(b).getTime()
      );

      // Take last 300 for merge processing
      const recentDocs = sortedDocs.slice(-300);

      const raw = recentDocs.map(doc => {
        const data = doc.data();
        const ts = extractDate(doc);
        return {
          id: doc.id,
          from: data.from || 'unknown',
          msg: data.msg || '',
          to: data.to || 'team',
          type: data.type || 'message',
          ts: ts.getTime() > 0 ? ts : null
        };
      });

      // Merge consecutive messages from the same agent within 60s window
      // This prevents chat spam — multiple rapid messages become one
      const merged: typeof raw = [];
      for (const m of raw) {
        const prev = merged[merged.length - 1];
        if (prev
          && prev.from === m.from
          && prev.ts && m.ts
          && (m.ts.getTime() - prev.ts.getTime()) < MERGE_WINDOW_SECONDS * 1000
          && !['task_added', 'task', 'solving_mode', 'bash_request'].includes(m.type)
          && !['task_added', 'task', 'solving_mode', 'bash_request'].includes(prev.type)
        ) {
          // Append to previous message
          prev.msg = prev.msg + '\n\n' + m.msg;
          prev.ts = m.ts; // Update timestamp to latest
        } else {
          merged.push({ ...m });
        }
      }

      // Return last 100 merged messages
      const messages = merged.slice(-100).map(m => ({
        ...m,
        ts: m.ts?.toISOString() || null
      }));

      return res.status(200).json({ messages });
    }

    if (req.method === 'POST') {
      const { from, to, msg, type } = req.body;
      const sender = from || 'james';
      const msgText = msg || '';
      const msgType = type || 'message';

      // Check recent messages for merge — only fetch messages from last 2 minutes
      // Using WHERE on Timestamp correctly filters only Firestore Timestamp fields
      // (avoids reading ALL docs just to find the last one)
      const twoMinAgo = Timestamp.fromDate(new Date(Date.now() - 120000));
      const recentSnap = await firestore
        .collection('team-messages')
        .where('ts', '>', twoMinAgo)
        .orderBy('ts', 'desc')
        .limit(5)
        .get();

      let lastDoc: FirebaseFirestore.DocumentSnapshot | null = null;
      let lastTime = 0;
      for (const doc of recentSnap.docs) {
        const t = extractDate(doc).getTime();
        if (t > lastTime) {
          lastTime = t;
          lastDoc = doc;
        }
      }

      if (lastDoc) {
        const lastData = lastDoc.data()!;
        const lastTs = extractDate(lastDoc);
        const now = new Date();

        const sameAgent = lastData.from === sender;
        const withinWindow = lastTime > 0 && (now.getTime() - lastTs.getTime()) < MERGE_WINDOW_SECONDS * 1000;
        // Only merge regular messages/thoughts, not system types like task_added
        const mergeable = !['task_added', 'task', 'solving_mode', 'bash_request'].includes(msgType)
                       && !['task_added', 'task', 'solving_mode', 'bash_request'].includes(lastData.type || '');

        if (sameAgent && withinWindow && mergeable) {
          // Append to existing message
          const mergedMsg = (lastData.msg || '') + '\n\n' + msgText;
          await lastDoc.ref.update({ msg: mergedMsg, ts: Timestamp.now() });
          return res.status(200).json({ success: true, id: lastDoc.id, merged: true });
        }
      }

      // Otherwise create a new message
      const docRef = await firestore.collection('team-messages').add({
        from: sender,
        to: to || 'team',
        msg: msgText,
        type: msgType,
        ts: Timestamp.now()
      });

      return res.status(200).json({ success: true, id: docRef.id });
    }

    // DELETE - Remove messages (individual, bulk, or by sender)
    if (req.method === 'DELETE') {
      const { id, ids, from: sender } = req.body || {};

      // Bulk delete by array of IDs
      if (ids && Array.isArray(ids) && ids.length > 0) {
        const toDelete = ids.slice(0, 500);
        const BATCH_SIZE = 500;
        let deleted = 0;
        for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
          const chunk = toDelete.slice(i, i + BATCH_SIZE);
          const batch = firestore.batch();
          for (const docId of chunk) {
            batch.delete(firestore.collection('team-messages').doc(String(docId)));
          }
          await batch.commit();
          deleted += chunk.length;
        }
        return res.status(200).json({ success: true, deleted });
      }

      // Delete all messages from a specific sender
      if (sender) {
        const snap = await firestore.collection('team-messages')
          .where('from', '==', sender).get();
        if (snap.empty) {
          return res.status(200).json({ success: true, deleted: 0 });
        }
        const batch = firestore.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        return res.status(200).json({ success: true, deleted: snap.docs.length });
      }

      // Single delete by ID
      if (id) {
        await firestore.collection('team-messages').doc(String(id)).delete();
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: 'Missing id, ids array, or from (sender)' });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
