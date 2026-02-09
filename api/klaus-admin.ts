import type { VercelRequest, VercelResponse } from '@vercel/node';
import admin from 'firebase-admin';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

let db: FirebaseFirestore.Firestore | null = null;

function getDb() {
  if (db) return db;
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccount) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(serviceAccount)) });
  }
  db = getFirestore(admin.app(), 'axe-team');
  return db;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const firestore = getDb();
    const col = firestore.collection('klaus-admin');

    if (req.method === 'GET') {
      const doc = req.query.doc as string;

      if (doc === 'health') {
        const results: Record<string, { status: string; latency: number }> = {};

        // Check Ollama
        const ollamaStart = Date.now();
        try {
          const ollamaRes = await fetch('https://hdr.it.com.ngrok.pro/ollama/api/tags', {
            signal: AbortSignal.timeout(5000)
          });
          results.ollama = {
            status: ollamaRes.ok ? 'online' : 'error',
            latency: Date.now() - ollamaStart
          };
        } catch {
          results.ollama = { status: 'offline', latency: Date.now() - ollamaStart };
        }

        // Check Groq
        const groqStart = Date.now();
        try {
          const groqKey = process.env.GROQ_API_KEY;
          const groqRes = await fetch('https://api.groq.com/openai/v1/models', {
            headers: groqKey ? { 'Authorization': `Bearer ${groqKey}` } : {},
            signal: AbortSignal.timeout(5000)
          });
          results.groq = {
            status: groqRes.ok ? 'online' : 'error',
            latency: Date.now() - groqStart
          };
        } catch {
          results.groq = { status: 'offline', latency: Date.now() - groqStart };
        }

        return res.status(200).json(results);
      }

      if (doc === 'errors') {
        const snapshot = await col.doc('errors').collection('log')
          .orderBy('timestamp', 'desc')
          .limit(50)
          .get();
        const errors = snapshot.docs.map(d => ({
          id: d.id,
          ...d.data(),
          timestamp: d.data().timestamp?.toDate?.()?.toISOString() || null
        }));
        return res.status(200).json({ errors });
      }

      if (doc === 'tests') {
        const snapshot = await col.doc('tests').collection('queue')
          .orderBy('createdAt', 'desc')
          .get();
        const tests = snapshot.docs.map(d => ({
          id: d.id,
          ...d.data(),
          createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null,
          completedAt: d.data().completedAt?.toDate?.()?.toISOString() || null
        }));
        return res.status(200).json({ tests });
      }

      if (doc === 'personal-tasks') {
        const snapshot = await col.doc('personal-tasks').collection('items')
          .orderBy('createdAt', 'desc')
          .get();
        const tasks = snapshot.docs.map(d => ({
          id: d.id,
          ...d.data(),
          createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null,
          completedAt: d.data().completedAt?.toDate?.()?.toISOString() || null
        }));
        return res.status(200).json({ tasks });
      }

      if (doc === 'skills') {
        const snapshot = await col.doc('skills').collection('items')
          .get();
        const skills = snapshot.docs.map(d => ({
          id: d.id,
          ...d.data()
        }));
        return res.status(200).json({ skills });
      }

      if (doc && ['config', 'feature-flags', 'injections'].includes(doc)) {
        const snap = await col.doc(doc).get();
        return res.status(200).json({ data: snap.exists ? snap.data() : {} });
      }

      return res.status(400).json({ error: 'Missing or invalid doc parameter' });
    }

    if (req.method === 'POST') {
      const { doc, data } = req.body;
      if (!doc) return res.status(400).json({ error: 'Missing doc parameter' });

      if (doc === 'errors') {
        const ref = await col.doc('errors').collection('log').add({
          ...data,
          timestamp: Timestamp.now()
        });
        return res.status(200).json({ success: true, id: ref.id });
      }

      if (doc === 'tests') {
        const ref = await col.doc('tests').collection('queue').add({
          ...data,
          status: data.status || 'pending',
          createdAt: Timestamp.now()
        });
        return res.status(200).json({ success: true, id: ref.id });
      }

      if (doc === 'personal-tasks') {
        const { id: taskId } = req.body;
        if (taskId) {
          // Update existing task
          await col.doc('personal-tasks').collection('items').doc(taskId).set(
            { ...data, updatedAt: Timestamp.now() },
            { merge: true }
          );
          return res.status(200).json({ success: true, id: taskId });
        }
        // Create new task
        const ref = await col.doc('personal-tasks').collection('items').add({
          ...data,
          status: data.status || 'pending',
          createdAt: Timestamp.now()
        });
        return res.status(200).json({ success: true, id: ref.id });
      }

      if (doc === 'skills') {
        const { id: skillId } = req.body;
        if (skillId) {
          // Update existing skill
          await col.doc('skills').collection('items').doc(skillId).set(
            { ...data, updatedAt: Timestamp.now() },
            { merge: true }
          );
          return res.status(200).json({ success: true, id: skillId });
        }
        // Check if builtin skill already has a doc (by skill id field)
        if (data.id) {
          const existing = await col.doc('skills').collection('items')
            .where('id', '==', data.id).limit(1).get();
          if (!existing.empty) {
            await existing.docs[0].ref.set(
              { ...data, updatedAt: Timestamp.now() },
              { merge: true }
            );
            return res.status(200).json({ success: true, id: existing.docs[0].id });
          }
        }
        const ref = await col.doc('skills').collection('items').add({
          ...data,
          createdAt: Timestamp.now()
        });
        return res.status(200).json({ success: true, id: ref.id });
      }

      if (['config', 'feature-flags', 'injections'].includes(doc)) {
        await col.doc(doc).set(
          { ...data, updatedAt: Timestamp.now() },
          { merge: true }
        );
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: 'Invalid doc parameter' });
    }

    if (req.method === 'DELETE') {
      const { doc, id, clearAll } = req.body || {};

      if (doc === 'errors' && clearAll) {
        const snapshot = await col.doc('errors').collection('log').get();
        const batch = firestore.batch();
        snapshot.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        return res.status(200).json({ success: true, deleted: snapshot.size });
      }

      if (doc === 'errors' && id) {
        await col.doc('errors').collection('log').doc(id).delete();
        return res.status(200).json({ success: true });
      }

      if (doc === 'tests' && id) {
        await col.doc('tests').collection('queue').doc(id).delete();
        return res.status(200).json({ success: true });
      }

      if (doc === 'personal-tasks' && id) {
        await col.doc('personal-tasks').collection('items').doc(id).delete();
        return res.status(200).json({ success: true });
      }

      if (doc === 'skills' && id) {
        await col.doc('skills').collection('items').doc(id).delete();
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: 'Missing doc/id parameter' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('Klaus Admin API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
