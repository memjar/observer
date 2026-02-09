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
    const col = firestore.collection('projects');

    // GET - List all projects
    if (req.method === 'GET') {
      const snapshot = await col.orderBy('createdAt', 'desc').get();
      const projects = snapshot.docs.map(doc => ({ ...doc.data(), _docId: doc.id }));
      return res.status(200).json({ projects });
    }

    // POST - Create new project
    if (req.method === 'POST') {
      const project = req.body;
      if (!project || !project.title) {
        return res.status(400).json({ error: 'Missing project title' });
      }
      // Use project.id as the document ID for easy lookup
      const docId = String(project.id || Date.now());
      await col.doc(docId).set({
        ...project,
        updatedAt: Timestamp.now(),
        createdAt: project.createdAt || new Date().toISOString()
      });
      return res.status(200).json({ success: true, id: docId });
    }

    // PUT - Update project(s) — supports single or bulk sync
    if (req.method === 'PUT') {
      const { projects, project } = req.body;

      // Bulk sync: replace all projects
      if (projects && Array.isArray(projects)) {
        const batch = firestore.batch();
        // Write each project with its ID as doc key
        for (const p of projects) {
          const docId = String(p.id || Date.now());
          batch.set(col.doc(docId), { ...p, updatedAt: Timestamp.now() });
        }
        await batch.commit();
        return res.status(200).json({ success: true, synced: projects.length });
      }

      // Single update
      if (project && project.id) {
        const docId = String(project.id);
        await col.doc(docId).set({ ...project, updatedAt: Timestamp.now() }, { merge: true });
        return res.status(200).json({ success: true, id: docId });
      }

      return res.status(400).json({ error: 'Missing project or projects array' });
    }

    // DELETE - Remove a project
    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Missing project id' });
      await col.doc(String(id)).delete();
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('Projects API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
