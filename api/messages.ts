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
      // Get recent messages - fetch more than needed so merging still yields ~100
      const snapshot = await firestore
        .collection('team-messages')
        .orderBy('ts', 'asc')
        .limitToLast(300)
        .get();

      const raw = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          from: data.from || 'unknown',
          msg: data.msg || '',
          to: data.to || 'team',
          type: data.type || 'message',
          ts: data.ts?.toDate?.() || null
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

      // Check if the last message is from the same agent within the merge window
      // If so, append to it instead of creating a new message (prevents spam)
      const recentSnap = await firestore
        .collection('team-messages')
        .orderBy('ts', 'desc')
        .limit(1)
        .get();

      if (!recentSnap.empty) {
        const lastDoc = recentSnap.docs[0];
        const lastData = lastDoc.data();
        const lastTs = lastData.ts?.toDate?.();
        const now = new Date();

        const sameAgent = lastData.from === sender;
        const withinWindow = lastTs && (now.getTime() - lastTs.getTime()) < MERGE_WINDOW_SECONDS * 1000;
        // Only merge regular messages/thoughts, not system types like task_added
        const mergeable = !['task_added', 'task', 'solving_mode', 'bash_request'].includes(msgType)
                       && !['task_added', 'task', 'solving_mode', 'bash_request'].includes(lastData.type || '');

        if (sameAgent && withinWindow && mergeable) {
          // Append to existing message
          const merged = (lastData.msg || '') + '\n\n' + msgText;
          await lastDoc.ref.update({ msg: merged, ts: Timestamp.now() });
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

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
