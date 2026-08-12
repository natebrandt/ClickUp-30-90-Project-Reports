// Serverless proxy — adds CLICKUP_TOKEN from env so it never reaches the browser.
export default async function handler(req, res) {
  const token = process.env.CLICKUP_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'CLICKUP_TOKEN environment variable is not set in Vercel.' });
  }

  const { path: pathParts, ...queryParams } = req.query;
  const path = '/' + (Array.isArray(pathParts) ? pathParts.join('/') : pathParts ?? '');

  // Restrict to only the ClickUp API paths this app actually uses
  const ALLOWED_PREFIXES = ['/team', '/space/', '/folder/', '/group', '/list/'];
  if (!ALLOWED_PREFIXES.some(p => path.startsWith(p))) {
    return res.status(403).json({ error: 'Path not allowed.' });
  }

  const qs = new URLSearchParams(queryParams).toString();
  const url = `https://api.clickup.com/api/v2${path}${qs ? '?' + qs : ''}`;

  try {
    const upstream = await fetch(url, {
      headers: { Authorization: token },
    });
    const data = await upstream.json();
    // Cache on Vercel's CDN; time entries are the most frequently changing data
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Upstream fetch failed: ${err.message}` });
  }
}
