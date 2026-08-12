import { buildReport } from '../report.js';

// Vercel cron calls this; CRON_SECRET must match the secret set in Vercel env vars.
export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const teamId   = process.env.CLICKUP_TEAM_ID;
  const spaceIds = process.env.CLICKUP_SPACE_IDS;
  const pmGroup  = process.env.CLICKUP_PM_GROUP || '';

  if (!teamId || !spaceIds) {
    return res.status(400).json({ error: 'CLICKUP_TEAM_ID and CLICKUP_SPACE_IDS env vars are required for cron refresh.' });
  }

  try {
    await buildReport(teamId, spaceIds.split(',').map(s => s.trim()), pmGroup);
    return res.json({ ok: true, refreshedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
