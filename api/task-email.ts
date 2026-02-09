import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Resend } from 'resend';

function buildTaskEmailHtml(task: any, artifactContent: string): string {
  const priority = task.priority || 'medium';
  const priorityColor = { high: '#ef4444', medium: '#f59e0b', low: '#3b82f6' }[priority] || '#f59e0b';
  const createdDate = task.createdAt ? new Date(task.createdAt).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }) : 'Unknown';
  const completedDate = new Date().toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  // Convert markdown-like content to basic HTML
  const contentHtml = artifactContent
    .replace(/^# (.+)$/gm, '<h2 style="color:#e8e8e8;font-size:18px;margin:16px 0 8px;">$1</h2>')
    .replace(/^## (.+)$/gm, '<h3 style="color:#ccc;font-size:15px;margin:14px 0 6px;">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#e8e8e8;">$1</strong>')
    .replace(/^- (.+)$/gm, '<div style="padding-left:12px;margin:2px 0;">&#8226; $1</div>')
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #222;margin:16px 0;">')
    .replace(/\n/g, '<br>');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px;">
    <!-- Header -->
    <div style="text-align:center;padding:20px 0;border-bottom:1px solid #222;">
      <div style="font-size:24px;font-weight:700;color:#e8e8e8;">A<span style="color:#ff6b00;">X</span>e</div>
      <div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:2px;margin-top:4px;">Task Completed</div>
    </div>

    <!-- Task Card -->
    <div style="background:#111;border:1px solid #222;border-radius:12px;padding:20px;margin:20px 0;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        <span style="font-size:24px;">&#9989;</span>
        <div>
          <div style="font-size:16px;font-weight:700;color:#e8e8e8;">${task.text || 'Task'}</div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
            <span style="background:${priorityColor}22;color:${priorityColor};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase;">${priority}</span>
          </div>
        </div>
      </div>
      <div style="display:flex;gap:20px;padding-top:12px;border-top:1px solid #222;">
        <div>
          <div style="font-size:10px;color:#555;text-transform:uppercase;">Created</div>
          <div style="font-size:13px;color:#999;">${createdDate}</div>
        </div>
        <div>
          <div style="font-size:10px;color:#555;text-transform:uppercase;">Completed</div>
          <div style="font-size:13px;color:#22c55e;">${completedDate}</div>
        </div>
      </div>
    </div>

    <!-- Artifact Content -->
    <div style="background:#111;border:1px solid #222;border-radius:12px;padding:20px;margin:20px 0;">
      <div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">Artifact</div>
      <div style="color:#999;font-size:13px;line-height:1.6;">
        ${contentHtml}
      </div>
    </div>

    <!-- CTA -->
    <div style="text-align:center;padding:20px 0;">
      <a href="https://axe.observer" style="display:inline-block;background:#ff6b00;color:white;padding:10px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;">View in Klaus Admin</a>
    </div>

    <!-- Footer -->
    <div style="text-align:center;padding:20px 0;border-top:1px solid #222;">
      <div style="font-size:11px;color:#333;">Sent by Klaus via AXe Observer &middot; <a href="https://axe.observer" style="color:#ff6b00;text-decoration:none;">axe.observer</a></div>
    </div>
  </div>
</body>
</html>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
      return res.status(500).json({ error: 'RESEND_API_KEY not set' });
    }

    const { task, artifactContent } = req.body;
    if (!task || !artifactContent) {
      return res.status(400).json({ error: 'Missing task or artifactContent' });
    }

    const resend = new Resend(resendKey);
    const html = buildTaskEmailHtml(task, artifactContent);
    const emailFrom = process.env.EMAIL_FROM || 'AXe Observer <onboarding@resend.dev>';

    const { data, error } = await resend.emails.send({
      from: emailFrom,
      to: ['james@virul.co'],
      subject: `[Klaus] Task Complete: ${(task.text || 'Task').substring(0, 60)}`,
      html
    });

    if (error) {
      console.error('Task email error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ success: true, emailId: data?.id });
  } catch (error: any) {
    console.error('Task email error:', error);
    return res.status(500).json({ error: error.message });
  }
}
