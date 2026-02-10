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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const firestore = getDb();
    const col = firestore.collection('companies');

    // GET - List all companies
    if (req.method === 'GET') {
      const snapshot = await col.orderBy('updatedAt', 'desc').limit(20).get();
      const companies = snapshot.docs.map(doc => ({ ...doc.data(), _docId: doc.id }));
      return res.status(200).json({ companies });
    }

    // POST - Create new company
    if (req.method === 'POST') {
      const company = req.body;
      if (!company || !company.name) {
        return res.status(400).json({ error: 'Missing company name' });
      }
      const docId = String(company.id || Date.now());
      await col.doc(docId).set({
        ...company,
        updatedAt: Timestamp.now(),
        createdAt: company.createdAt || new Date().toISOString()
      });
      return res.status(200).json({ success: true, id: docId });
    }

    // PUT - Update company(s) — supports single or bulk sync
    if (req.method === 'PUT') {
      const { companies, company } = req.body;

      // Bulk sync
      if (companies && Array.isArray(companies)) {
        const batch = firestore.batch();
        for (const c of companies) {
          const docId = String(c.id || Date.now());
          batch.set(col.doc(docId), { ...c, updatedAt: Timestamp.now() });
        }
        await batch.commit();
        return res.status(200).json({ success: true, synced: companies.length });
      }

      // Single update
      if (company && company.id) {
        const docId = String(company.id);
        await col.doc(docId).set({ ...company, updatedAt: Timestamp.now() }, { merge: true });
        return res.status(200).json({ success: true, id: docId });
      }

      return res.status(400).json({ error: 'Missing company or companies array' });
    }

    // DELETE - Remove company(s)
    if (req.method === 'DELETE') {
      const { id, ids } = req.body || {};

      // Bulk delete by array of IDs
      if (ids && Array.isArray(ids) && ids.length > 0) {
        const batch = firestore.batch();
        for (const cid of ids.slice(0, 500)) {
          batch.delete(col.doc(String(cid)));
        }
        await batch.commit();
        return res.status(200).json({ success: true, deleted: ids.length });
      }

      // Single delete by ID
      if (!id) return res.status(400).json({ error: 'Missing company id or ids array' });
      await col.doc(String(id)).delete();
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('Companies API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
