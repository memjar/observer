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
    const col = firestore.collection('artifacts');

    // GET - Retrieve artifact(s)
    if (req.method === 'GET') {
      const name = req.query.name as string;

      // Single artifact by name
      if (name) {
        const snapshot = await col.where('name', '==', name).limit(1).get();
        if (snapshot.empty) {
          return res.status(404).json({ error: 'Artifact not found', name });
        }
        const doc = snapshot.docs[0];
        return res.status(200).json({ artifact: { ...doc.data(), _docId: doc.id } });
      }

      // List all artifacts (includes content for slider previews + chat rendering)
      const snapshot = await col.orderBy('savedAt', 'desc').limit(200).get();
      const artifacts = snapshot.docs.map(doc => {
        const d = doc.data();
        return {
          _docId: doc.id,
          name: d.name,
          content: d.content || '',
          creator: d.creator || 'unknown',
          projectId: d.projectId || null,
          type: d.type || 'artifact',
          savedAt: d.savedAt,
          size: (d.content || '').length
        };
      });
      return res.status(200).json({ artifacts, total: artifacts.length });
    }

    // POST - Save artifact content
    if (req.method === 'POST') {
      const { name, content, creator, projectId, type } = req.body;
      if (!name || !content) {
        return res.status(400).json({ error: 'Missing name or content' });
      }

      // Use name as doc ID (sanitized) for deduplication
      const docId = name.replace(/[\/\.#$\[\]]/g, '_').substring(0, 100);

      await col.doc(docId).set({
        name,
        content,
        creator: creator || 'unknown',
        projectId: projectId || null,
        type: type || 'artifact',
        savedAt: Timestamp.now()
      }, { merge: true });

      return res.status(200).json({ success: true, id: docId });
    }

    // DELETE - Remove an artifact
    if (req.method === 'DELETE') {
      const { name } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Missing artifact name' });
      const docId = name.replace(/[\/\.#$\[\]]/g, '_').substring(0, 100);
      await col.doc(docId).delete();
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('Artifacts API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
