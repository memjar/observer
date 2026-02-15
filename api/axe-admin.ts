import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';

// Initialize Firebase if not already done
if (!admin.apps.length) {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : undefined;

  admin.initializeApp(
    serviceAccount
      ? { credential: admin.credential.cert(serviceAccount) }
      : undefined
  );
}

const db = admin.firestore();
const COLLECTION = 'axe-admin';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const action = req.query.action as string;

      if (action === 'list') {
        const doc = await db.collection(COLLECTION).doc('instances').get();
        const data = doc.exists ? doc.data() : { instances: [] };
        return res.json({ instances: data?.instances || [] });
      }

      if (action === 'config') {
        const doc = await db.collection(COLLECTION).doc('default-config').get();
        return res.json(doc.exists ? doc.data() : {});
      }

      return res.json({ status: 'ok', endpoints: ['?action=list', '?action=config'] });
    }

    if (req.method === 'POST') {
      const { action, instances, config } = req.body || {};

      if (action === 'save' && instances) {
        await db.collection(COLLECTION).doc('instances').set(
          { instances, updatedAt: new Date().toISOString() },
          { merge: true }
        );
        return res.json({ success: true });
      }

      if (action === 'saveConfig' && config) {
        await db.collection(COLLECTION).doc('default-config').set(
          { ...config, updatedAt: new Date().toISOString() },
          { merge: true }
        );
        return res.json({ success: true });
      }

      // Register a new instance (called from axe-agent on startup)
      if (action === 'register') {
        const { instance } = req.body;
        if (!instance?.id) return res.status(400).json({ error: 'instance.id required' });

        const doc = await db.collection(COLLECTION).doc('instances').get();
        const existing = doc.exists ? (doc.data()?.instances || []) : [];
        const idx = existing.findIndex((i: { id: string }) => i.id === instance.id);
        if (idx >= 0) {
          existing[idx] = { ...existing[idx], ...instance, lastSeen: new Date().toISOString() };
        } else {
          existing.push({ ...instance, registeredAt: new Date().toISOString() });
        }
        await db.collection(COLLECTION).doc('instances').set({ instances: existing, updatedAt: new Date().toISOString() });
        return res.json({ success: true, count: existing.length });
      }

      // Heartbeat from running instance
      if (action === 'heartbeat') {
        const { id, status, messagestoday, costToday } = req.body;
        if (!id) return res.status(400).json({ error: 'id required' });

        const doc = await db.collection(COLLECTION).doc('instances').get();
        const existing = doc.exists ? (doc.data()?.instances || []) : [];
        const inst = existing.find((i: { id: string }) => i.id === id);
        if (inst) {
          inst.status = status || 'online';
          inst.lastSeen = new Date().toISOString();
          if (messagestoday !== undefined) inst.messagestoday = messagestoday;
          if (costToday !== undefined) inst.costToday = costToday;
          await db.collection(COLLECTION).doc('instances').set({ instances: existing, updatedAt: new Date().toISOString() });
        }
        return res.json({ success: true });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: msg });
  }
}
