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
      const creator = req.query.creator as string;
      const projectId = req.query.projectId as string;

      // Single artifact by name
      if (name) {
        const snapshot = await col.where('name', '==', name).limit(1).get();
        if (snapshot.empty) {
          return res.status(404).json({ error: 'Artifact not found', name });
        }
        const doc = snapshot.docs[0];
        return res.status(200).json({ artifact: { ...doc.data(), _docId: doc.id } });
      }

      // Build query with optional filters
      let query: FirebaseFirestore.Query = col.orderBy('savedAt', 'desc');

      // Firestore only allows range/inequality on one field, so creator/projectId
      // filters are applied in-memory after fetch
      const snapshot = await query.limit(100).get();
      let artifacts = snapshot.docs.map(doc => {
        const d = doc.data();
        return {
          _docId: doc.id,
          name: d.name,
          content: d.content || '',
          creator: d.creator || 'unknown',
          projectId: d.projectId || null,
          type: d.type || 'artifact',
          savedAt: d.savedAt?.toDate?.()?.toISOString() || null,
          size: (d.content || '').length
        };
      });

      // Apply filters
      if (creator) {
        artifacts = artifacts.filter(a => a.creator === creator);
      }
      if (projectId) {
        artifacts = artifacts.filter(a => a.projectId === projectId);
      }

      // Pagination support
      const page = parseInt(req.query.page as string);
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const total = artifacts.length;

      if (!isNaN(page)) {
        const offset = page * limit;
        const paginated = artifacts.slice(offset, offset + limit);
        return res.status(200).json({
          artifacts: paginated,
          total,
          page,
          limit,
          hasMore: offset + limit < total
        });
      }

      return res.status(200).json({ artifacts, total });
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

    // DELETE - Remove artifact(s): individual, bulk by names, by age, or all
    if (req.method === 'DELETE') {
      const { name, names, olderThanDays, all } = req.body || {};

      // Delete ALL artifacts
      if (all === true) {
        const snap = await col.get();
        if (snap.empty) return res.status(200).json({ success: true, deleted: 0 });
        const batch = firestore.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        return res.status(200).json({ success: true, deleted: snap.docs.length });
      }

      // Bulk delete by array of names
      if (names && Array.isArray(names) && names.length > 0) {
        const batch = firestore.batch();
        let count = 0;
        for (const n of names.slice(0, 500)) {
          const docId = n.replace(/[\/\.#$\[\]]/g, '_').substring(0, 100);
          batch.delete(col.doc(docId));
          count++;
        }
        await batch.commit();
        return res.status(200).json({ success: true, deleted: count });
      }

      // Delete artifacts older than N days
      if (olderThanDays && typeof olderThanDays === 'number') {
        const cutoff = new Date(Date.now() - olderThanDays * 86400000);
        const snap = await col.where('savedAt', '<', Timestamp.fromDate(cutoff)).get();
        if (snap.empty) return res.status(200).json({ success: true, deleted: 0 });
        const batch = firestore.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        return res.status(200).json({ success: true, deleted: snap.docs.length });
      }

      // Single delete by name
      if (!name) return res.status(400).json({ error: 'Missing artifact name, names array, olderThanDays, or all flag' });
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
