// All ClickUp fetching and aggregation happens here; result is cached in Vercel KV.
import { kv } from '@vercel/kv';

export const config = { maxDuration: 300 };

const CACHE_TTL = 7200; // 2 hours

function clickupFetch(path) {
  return fetch(`https://api.clickup.com/api/v2${path}`, {
    headers: { Authorization: process.env.CLICKUP_TOKEN },
  }).then(async r => {
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(`ClickUp ${r.status} — ${b.err || b.error || path}`);
    }
    return r.json();
  });
}

async function getPMUserIds(teamId, groupName) {
  if (!groupName) return [];
  const data = await clickupFetch(`/group?team_id=${teamId}`);
  const match = (data.groups || []).find(g =>
    g.name === groupName ||
    (g.alias && g.alias.replace(/^@/, '') === groupName.replace(/^@/, ''))
  );
  if (!match) return [];
  return (match.members || []).map(m => String(m.user?.id ?? m.id));
}

async function getMemberIds(teamId) {
  const data = await clickupFetch('/team');
  const team = (data.teams || []).find(t => String(t.id) === String(teamId));
  if (!team) throw new Error(`Workspace ${teamId} not found.`);
  return (team.members || []).map(m => String(m.user?.id ?? m.id)).filter(Boolean);
}

async function getListMap(spaceIds) {
  const map = {};
  await Promise.all(spaceIds.map(async spaceId => {
    let spaceName = spaceId;
    try { spaceName = (await clickupFetch(`/space/${spaceId}`)).name || spaceId; } catch (_) {}

    const fl = await clickupFetch(`/space/${spaceId}/list?archived=false`);
    (fl.lists || []).forEach(l => { map[String(l.id)] = { name: l.name, spaceName }; });

    const fd = await clickupFetch(`/space/${spaceId}/folder?archived=false`);
    await Promise.all((fd.folders || []).map(async folder => {
      const fl2 = await clickupFetch(`/folder/${folder.id}/list?archived=false`);
      (fl2.lists || []).forEach(l => { map[String(l.id)] = { name: l.name, spaceName }; });
    }));
  }));
  return map;
}

async function getTimeEntries(teamId, memberIds, startMs, endMs) {
  const all = [];
  let page = 0;
  while (true) {
    const params = new URLSearchParams({
      start_date: String(Math.floor(startMs)),
      end_date:   String(Math.floor(endMs)),
      include_location_names: 'true',
      assignee:   memberIds.join(','),
      page:       String(page),
    });
    const data = await clickupFetch(`/team/${teamId}/time_entries?${params}`);
    const entries = data.data || [];
    all.push(...entries);
    if (entries.length < 50) break;
    page++;
    if (page > 200) break;
  }
  // Deduplicate — ClickUp repeats entries once per matching task assignee
  const seen = new Set();
  return all.filter(e => e.id && !seen.has(e.id) && seen.add(e.id));
}

function aggregate(entries90, entries30, listMap, pmUserIds) {
  const pmSet = new Set(pmUserIds);
  const map = Object.fromEntries(
    Object.entries(listMap).map(([id, v]) => [id, { name: v.name, spaceName: v.spaceName, ms90: 0, ms30: 0, pmMs90: 0 }])
  );

  for (const e of entries90) {
    const listId = String(e.task_location?.list_id);
    if (!listId || listId === 'null' || !map[listId]) continue;
    const dur = Number(e.duration) || 0;
    map[listId].ms90 += dur;
    if (pmSet.has(String(e.user?.id))) map[listId].pmMs90 += dur;
  }

  for (const e of entries30) {
    const listId = String(e.task_location?.list_id);
    if (!listId || listId === 'null' || !map[listId]) continue;
    map[listId].ms30 += (Number(e.duration) || 0);
  }

  return Object.entries(map)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function buildReport(teamId, spaceIds, pmGroup) {
  const now     = Date.now();
  const start90 = now - 90 * 24 * 60 * 60 * 1000;
  const start30 = now - 30 * 24 * 60 * 60 * 1000;

  const [listMap, memberIds, pmUserIds] = await Promise.all([
    getListMap(spaceIds),
    getMemberIds(teamId),
    getPMUserIds(teamId, pmGroup),
  ]);

  const entries90 = await getTimeEntries(teamId, memberIds, start90, now);
  const entries30 = entries90.filter(e => Number(e.start) >= start30);

  return {
    generatedAt: new Date().toISOString(),
    windows:     { start90, start30, end: now },
    meta:        { totalEntries: entries90.length, memberCount: memberIds.length, pmMemberCount: pmUserIds.length },
    lists:       aggregate(entries90, entries30, listMap, pmUserIds),
  };
}

export default async function handler(req, res) {
  if (!process.env.CLICKUP_TOKEN) return res.status(500).json({ error: 'CLICKUP_TOKEN not configured.' });

  const { teamId, spaceIds: raw, pmGroup = '', force } = req.query;
  if (!teamId || !raw) return res.status(400).json({ error: 'teamId and spaceIds are required.' });

  const spaceIds = raw.split(',').map(s => s.trim()).filter(Boolean);
  const cacheKey = `report:${teamId}:${spaceIds.join(',')}:${pmGroup}`;

  // Check KV cache unless force-refresh requested
  const kvReady = !!process.env.KV_REST_API_URL;
  if (kvReady && force !== 'true') {
    try {
      const cached = await kv.get(cacheKey);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached);
      }
    } catch (_) {}
  }

  try {
    const report = await buildReport(teamId, spaceIds, pmGroup);
    if (kvReady) {
      kv.set(cacheKey, report, { ex: CACHE_TTL }).catch(() => {});
    }
    res.setHeader('X-Cache', 'MISS');
    return res.json(report);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
