import type { VercelRequest, VercelResponse } from '@vercel/node';
import admin from 'firebase-admin';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { Resend } from 'resend';

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

interface Message {
  from: string;
  msg: string;
  type: string;
  ts: Date | null;
}

function getAgentEmoji(agent: string): string {
  const map: Record<string, string> = {
    forge: '\u{1F525}', cortana: '\u{1F48E}', klaus: '\u{1F9E0}',
    gemini: '\u{2728}', james: '\u{1F451}', system: '\u{2699}\uFE0F'
  };
  return map[agent] || '\u{1F4AC}';
}

function getTypeLabel(type: string): string {
  const map: Record<string, string> = {
    message: 'Message', task: 'Task', task_added: 'Task Added',
    solving_mode: 'Solving Mode', research: 'Research', analysis: 'Analysis',
    ideation: 'Ideation', thought: 'Thought', thinking: 'Thinking',
    artifact: 'Artifact', bash_request: 'Bash Request'
  };
  return map[type] || type;
}

function buildEmailHtml(messages: Message[], date: string): string {
  // Group by agent
  const byAgent: Record<string, Message[]> = {};
  for (const m of messages) {
    const agent = m.from || 'unknown';
    if (!byAgent[agent]) byAgent[agent] = [];
    byAgent[agent].push(m);
  }

  // Group by type
  const byType: Record<string, number> = {};
  for (const m of messages) {
    const t = m.type || 'message';
    byType[t] = (byType[t] || 0) + 1;
  }

  // Extract key discussions (longer messages, non-system)
  const keyMessages = messages
    .filter(m => m.msg.length > 80 && m.from !== 'system')
    .sort((a, b) => b.msg.length - a.msg.length)
    .slice(0, 10);

  const agentSections = Object.entries(byAgent)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([agent, msgs]) => {
      const types = msgs.reduce((acc, m) => {
        const t = m.type || 'message';
        acc[t] = (acc[t] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const typeBreakdown = Object.entries(types)
        .map(([t, c]) => `${getTypeLabel(t)}: ${c}`)
        .join(' &middot; ');

      // Top 3 messages from this agent (by length, as proxy for substance)
      const topMsgs = msgs
        .filter(m => m.msg.length > 40)
        .sort((a, b) => b.msg.length - a.msg.length)
        .slice(0, 3);

      const highlights = topMsgs.map(m => {
        const preview = m.msg.replace(/[#*`\[\]]/g, '').substring(0, 200);
        const time = m.ts ? new Date(m.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : '';
        return `<div style="background:#1a1a1a;border-left:3px solid #ff6b00;padding:8px 12px;margin:6px 0;border-radius:4px;font-size:13px;color:#999;line-height:1.5;">
          <span style="color:#555;font-size:11px;">${time}</span><br>
          ${preview}${m.msg.length > 200 ? '...' : ''}
        </div>`;
      }).join('');

      return `<div style="margin-bottom:24px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <span style="font-size:20px;">${getAgentEmoji(agent)}</span>
          <span style="font-size:16px;font-weight:700;color:#e8e8e8;text-transform:capitalize;">${agent}</span>
          <span style="background:#222;color:#777;padding:2px 8px;border-radius:10px;font-size:11px;">${msgs.length} msgs</span>
        </div>
        <div style="color:#666;font-size:12px;margin-bottom:8px;">${typeBreakdown}</div>
        ${highlights}
      </div>`;
    }).join('');

  const activityBreakdown = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `<span style="background:#1a1a1a;border:1px solid #222;padding:4px 10px;border-radius:6px;font-size:12px;color:#888;display:inline-block;margin:2px;">${getTypeLabel(t)}: ${c}</span>`)
    .join(' ');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px;">
    <!-- Header -->
    <div style="text-align:center;padding:20px 0;border-bottom:1px solid #222;">
      <div style="font-size:24px;font-weight:700;color:#e8e8e8;">A<span style="color:#ff6b00;">X</span>e</div>
      <div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:2px;margin-top:4px;">Daily Channel Summary</div>
      <div style="font-size:13px;color:#777;margin-top:8px;">${date}</div>
    </div>

    <!-- Stats bar -->
    <div style="display:flex;justify-content:space-around;padding:16px 0;border-bottom:1px solid #222;text-align:center;">
      <div>
        <div style="font-size:24px;font-weight:700;color:#ff6b00;">${messages.length}</div>
        <div style="font-size:10px;color:#555;text-transform:uppercase;">Messages</div>
      </div>
      <div>
        <div style="font-size:24px;font-weight:700;color:#3b82f6;">${Object.keys(byAgent).length}</div>
        <div style="font-size:10px;color:#555;text-transform:uppercase;">Agents</div>
      </div>
      <div>
        <div style="font-size:24px;font-weight:700;color:#a855f7;">${Object.keys(byType).length}</div>
        <div style="font-size:10px;color:#555;text-transform:uppercase;">Types</div>
      </div>
    </div>

    <!-- Activity types -->
    <div style="padding:16px 0;border-bottom:1px solid #222;">
      <div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Activity Breakdown</div>
      ${activityBreakdown}
    </div>

    <!-- Agent sections -->
    <div style="padding:20px 0;">
      <div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:16px;">Per-Agent Summary</div>
      ${agentSections}
    </div>

    <!-- Key discussions -->
    ${keyMessages.length > 0 ? `
    <div style="padding:20px 0;border-top:1px solid #222;">
      <div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">Key Discussions</div>
      ${keyMessages.map(m => {
        const preview = m.msg.replace(/[#*`\[\]]/g, '').substring(0, 250);
        const time = m.ts ? new Date(m.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : '';
        return `<div style="background:#111;border:1px solid #222;border-radius:8px;padding:12px;margin-bottom:8px;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
            <span>${getAgentEmoji(m.from)}</span>
            <span style="font-weight:600;color:#e8e8e8;text-transform:capitalize;font-size:13px;">${m.from}</span>
            <span style="color:#444;font-size:11px;">${time}</span>
          </div>
          <div style="color:#888;font-size:13px;line-height:1.5;">${preview}${m.msg.length > 250 ? '...' : ''}</div>
        </div>`;
      }).join('')}
    </div>` : ''}

    <!-- Footer -->
    <div style="text-align:center;padding:20px 0;border-top:1px solid #222;">
      <div style="font-size:11px;color:#333;">Sent from AXe Observer &middot; <a href="https://axe.observer" style="color:#ff6b00;text-decoration:none;">axe.observer</a></div>
    </div>
  </div>
</body>
</html>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Verify cron secret or allow manual trigger with secret
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const firestore = getDb();
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
      return res.status(500).json({ error: 'RESEND_API_KEY not set' });
    }

    const resend = new Resend(resendKey);

    // Get today's date range (UTC)
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);

    // Fetch all messages from today
    const snapshot = await firestore
      .collection('team-messages')
      .where('ts', '>=', Timestamp.fromDate(startOfDay))
      .where('ts', '<=', Timestamp.fromDate(now))
      .orderBy('ts', 'asc')
      .get();

    // Also check archive
    const archiveSnapshot = await firestore
      .collection('team-messages-archive')
      .where('ts', '>=', Timestamp.fromDate(startOfDay))
      .where('ts', '<=', Timestamp.fromDate(now))
      .orderBy('ts', 'asc')
      .get();

    const messages: Message[] = [
      ...snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          from: data.from || 'unknown',
          msg: data.msg || '',
          type: data.type || 'message',
          ts: data.ts?.toDate?.() || null
        };
      }),
      ...archiveSnapshot.docs.map(doc => {
        const data = doc.data();
        return {
          from: data.from || 'unknown',
          msg: data.msg || '',
          type: data.type || 'message',
          ts: data.ts?.toDate?.() || null
        };
      })
    ].sort((a, b) => (a.ts?.getTime() || 0) - (b.ts?.getTime() || 0));

    if (messages.length === 0) {
      return res.status(200).json({ sent: false, reason: 'No messages today' });
    }

    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    const html = buildEmailHtml(messages, dateStr);

    // Send via Resend
    const emailFrom = process.env.EMAIL_FROM || 'AXe Observer <onboarding@resend.dev>';
    const { data, error } = await resend.emails.send({
      from: emailFrom,
      to: ['james@virul.co'],
      subject: `AXe Daily Summary - ${dateStr} (${messages.length} messages)`,
      html
    });

    if (error) {
      console.error('Resend error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      sent: true,
      emailId: data?.id,
      messageCount: messages.length,
      date: dateStr
    });

  } catch (error: any) {
    console.error('Daily summary error:', error);
    return res.status(500).json({ error: error.message });
  }
}
