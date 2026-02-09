import type { VercelRequest, VercelResponse } from '@vercel/node';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const firestore = getDb();

    // GET - Full backup export (projects + artifacts + recent messages)
    if (req.method === 'GET') {
      const format = req.query.format as string || 'json';

      // Fetch all collections in parallel
      const [projectsSnap, artifactsSnap, messagesSnap, archiveSnap] = await Promise.all([
        firestore.collection('projects').orderBy('createdAt', 'desc').get(),
        firestore.collection('artifacts').orderBy('savedAt', 'desc').get(),
        firestore.collection('team-messages').orderBy('ts', 'desc').limitToLast(100).get(),
        firestore.collection('team-messages-archive').orderBy('ts', 'desc').limit(500).get()
      ]);

      const backup = {
        exportedAt: new Date().toISOString(),
        version: '1.0',
        stats: {
          projects: projectsSnap.size,
          artifacts: artifactsSnap.size,
          recentMessages: messagesSnap.size,
          archivedMessages: archiveSnap.size
        },
        projects: projectsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
        artifacts: artifactsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
        recentMessages: messagesSnap.docs.map(d => {
          const data = d.data();
          return { id: d.id, from: data.from, msg: data.msg, type: data.type, ts: data.ts?.toDate?.()?.toISOString() };
        }),
        archivedMessages: archiveSnap.docs.map(d => {
          const data = d.data();
          return { id: d.id, from: data.from, msg: data.msg, type: data.type, ts: data.ts?.toDate?.()?.toISOString() };
        })
      };

      if (format === 'download') {
        const filename = `axe-backup-${new Date().toISOString().split('T')[0]}.json`;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.status(200).send(JSON.stringify(backup, null, 2));
      }

      return res.status(200).json(backup);
    }

    // POST - Save specific content (artifact/file) to Firestore as backup
    if (req.method === 'POST') {
      const { filename, content, folder, type } = req.body;
      if (!filename || !content) {
        return res.status(400).json({ error: 'Missing filename or content' });
      }

      // Store in Firestore backups collection
      const docId = `${folder || 'general'}__${filename}`.replace(/[\/\.#$\[\]]/g, '_').substring(0, 100);
      await firestore.collection('backups').doc(docId).set({
        filename,
        content,
        folder: folder || 'general',
        type: type || 'file',
        savedAt: new Date().toISOString(),
        size: content.length
      });

      return res.status(200).json({
        success: true,
        stored: 'firestore',
        id: docId,
        message: `Saved to Firestore. Download full backup at /api/drive-upload?format=download for Google Drive.`
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('Backup/export error:', error);
    return res.status(500).json({ error: error.message });
  }
}
