// Proxy that forwards the full ClickUp API path (including query string) passed as ?path=
export default async function handler(req, res) {
  const token = process.env.CLICKUP_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'CLICKUP_TOKEN environment variable is not set in Vercel.' });
  }

  const { path } = req.query;
  if (!path || !path.startsWith('/') || path.includes('..')) {
    return res.status(400).json({ error: 'Invalid path.' });
  }

  const url = `https://api.clickup.com/api/v2${path}`;

  try {
    const upstream = await fetch(url, {
      headers: { Authorization: token },
    });
    const data = await upstream.json();
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Upstream fetch failed: ${err.message}` });
  }
}
