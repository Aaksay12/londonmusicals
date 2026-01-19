/**
 * London Musicals - Cloudflare Worker
 *
 * A listing site for musicals currently playing in London
 * - West End, Off West End, and Drama School productions
 * - Daily cron job filters to currently running shows
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API Routes
    if (url.pathname.startsWith('/api/')) {
      return handleAPI(request, env, url);
    }

    // Serve the HTML interface
    return new Response(await generateHTML(env), {
      headers: { 'Content-Type': 'text/html' },
    });
  },

  // Cron trigger - runs daily to log active shows (can be extended for cache refresh)
  async scheduled(event, env, ctx) {
    const today = new Date().toISOString().split('T')[0];
    const { results } = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM musicals
      WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)
    `).bind(today, today).all();

    console.log(`[Cron] ${today}: ${results[0].count} active musicals`);
  },
};

async function handleAPI(request, env, url) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // GET /api/musicals - List currently running musicals
    if (url.pathname === '/api/musicals' && request.method === 'GET') {
      const today = new Date().toISOString().split('T')[0];
      const type = url.searchParams.get('type');

      let query = `
        SELECT * FROM musicals
        WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)
      `;
      const params = [today, today];

      if (type && ['West End', 'Off West End', 'Drama School'].includes(type)) {
        query += ` AND type = ?`;
        params.push(type);
      }

      query += ` ORDER BY type, title`;

      const { results } = await env.DB.prepare(query).bind(...params).all();

      return new Response(JSON.stringify(results), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // GET /api/musicals/:id - Get single musical
    if (url.pathname.match(/^\/api\/musicals\/\d+$/) && request.method === 'GET') {
      const id = url.pathname.split('/')[3];
      const result = await env.DB.prepare('SELECT * FROM musicals WHERE id = ?')
        .bind(id).first();

      if (!result) {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // GET /api/stats - Get counts by type
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      const today = new Date().toISOString().split('T')[0];
      const { results } = await env.DB.prepare(`
        SELECT type, COUNT(*) as count FROM musicals
        WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)
        GROUP BY type
      `).bind(today, today).all();

      return new Response(JSON.stringify(results), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

async function generateHTML(env) {
  const today = new Date().toISOString().split('T')[0];

  // Fetch current musicals
  const { results: musicals } = await env.DB.prepare(`
    SELECT * FROM musicals
    WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)
    ORDER BY type, title
  `).bind(today, today).all();

  // Group by type
  const westEnd = musicals.filter(m => m.type === 'West End');
  const offWestEnd = musicals.filter(m => m.type === 'Off West End');
  const dramaSchool = musicals.filter(m => m.type === 'Drama School');

  return HTML_TEMPLATE
    .replace('{{WEST_END_COUNT}}', westEnd.length)
    .replace('{{OFF_WEST_END_COUNT}}', offWestEnd.length)
    .replace('{{DRAMA_SCHOOL_COUNT}}', dramaSchool.length)
    .replace('{{TOTAL_COUNT}}', musicals.length)
    .replace('{{WEST_END_CARDS}}', westEnd.map(renderCard).join(''))
    .replace('{{OFF_WEST_END_CARDS}}', offWestEnd.map(renderCard).join(''))
    .replace('{{DRAMA_SCHOOL_CARDS}}', dramaSchool.map(renderCard).join(''))
    .replace('{{TODAY}}', new Date().toLocaleDateString('en-GB', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    }));
}

function renderCard(musical) {
  const endDate = musical.end_date
    ? new Date(musical.end_date).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Open run';

  const price = musical.price_from
    ? `From £${musical.price_from.toFixed(2)}`
    : '';

  return `
    <div class="card">
      <div class="card-badge">${escapeHtml(musical.type)}</div>
      <h3 class="card-title">${escapeHtml(musical.title)}</h3>
      <p class="card-venue">${escapeHtml(musical.venue_name)}</p>
      ${musical.description ? `<p class="card-desc">${escapeHtml(musical.description)}</p>` : ''}
      <div class="card-meta">
        <span class="card-date">Until ${endDate}</span>
        ${price ? `<span class="card-price">${price}</span>` : ''}
      </div>
      ${musical.ticket_url ? `<a href="${escapeHtml(musical.ticket_url)}" target="_blank" rel="noopener" class="card-btn">Get Tickets</a>` : ''}
    </div>
  `;
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>London Musicals - What's On Stage Today</title>
  <meta name="description" content="Discover musicals playing in London today. West End, Off West End, and Drama School productions.">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      min-height: 100vh;
      color: #fff;
    }

    .header {
      background: rgba(0, 0, 0, 0.3);
      padding: 20px 0;
      border-bottom: 2px solid #e94560;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 20px;
    }

    .header-content {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 15px;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-icon {
      font-size: 2.5rem;
    }

    .logo h1 {
      font-size: 1.8rem;
      font-weight: 700;
      background: linear-gradient(90deg, #e94560, #f5af19);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .date-badge {
      background: #e94560;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 0.9rem;
      font-weight: 500;
    }

    .stats {
      display: flex;
      justify-content: center;
      gap: 30px;
      padding: 30px 20px;
      flex-wrap: wrap;
    }

    .stat {
      text-align: center;
      background: rgba(255, 255, 255, 0.1);
      padding: 20px 30px;
      border-radius: 15px;
      min-width: 150px;
    }

    .stat-value {
      font-size: 2.5rem;
      font-weight: 700;
      color: #f5af19;
    }

    .stat-label {
      font-size: 0.85rem;
      color: #ccc;
      margin-top: 5px;
    }

    .filters {
      display: flex;
      justify-content: center;
      gap: 10px;
      padding: 20px;
      flex-wrap: wrap;
    }

    .filter-btn {
      padding: 10px 24px;
      border: 2px solid #e94560;
      background: transparent;
      color: #fff;
      border-radius: 25px;
      cursor: pointer;
      font-size: 0.95rem;
      transition: all 0.3s;
    }

    .filter-btn:hover, .filter-btn.active {
      background: #e94560;
    }

    .section {
      padding: 30px 0;
    }

    .section-title {
      font-size: 1.5rem;
      margin-bottom: 20px;
      padding-left: 15px;
      border-left: 4px solid #e94560;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .section-count {
      background: rgba(233, 69, 96, 0.3);
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.85rem;
    }

    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 20px;
    }

    .card {
      background: rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 24px;
      transition: transform 0.3s, box-shadow 0.3s;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .card:hover {
      transform: translateY(-5px);
      box-shadow: 0 15px 40px rgba(233, 69, 96, 0.2);
      border-color: #e94560;
    }

    .card-badge {
      display: inline-block;
      background: #e94560;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      margin-bottom: 12px;
    }

    .card-title {
      font-size: 1.3rem;
      font-weight: 700;
      margin-bottom: 8px;
    }

    .card-venue {
      color: #f5af19;
      font-size: 0.95rem;
      margin-bottom: 10px;
    }

    .card-desc {
      color: #aaa;
      font-size: 0.9rem;
      margin-bottom: 15px;
      line-height: 1.5;
    }

    .card-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
      font-size: 0.85rem;
      color: #999;
    }

    .card-price {
      color: #4ade80;
      font-weight: 600;
    }

    .card-btn {
      display: block;
      text-align: center;
      padding: 12px 20px;
      background: linear-gradient(90deg, #e94560, #f5af19);
      color: #fff;
      text-decoration: none;
      border-radius: 25px;
      font-weight: 600;
      transition: opacity 0.3s, transform 0.3s;
    }

    .card-btn:hover {
      opacity: 0.9;
      transform: scale(1.02);
    }

    .footer {
      text-align: center;
      padding: 40px 20px;
      color: #666;
      font-size: 0.85rem;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      margin-top: 40px;
    }

    .hidden {
      display: none !important;
    }

    @media (max-width: 600px) {
      .logo h1 {
        font-size: 1.4rem;
      }

      .stats {
        gap: 15px;
      }

      .stat {
        padding: 15px 20px;
        min-width: 100px;
      }

      .stat-value {
        font-size: 1.8rem;
      }

      .cards-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="container header-content">
      <div class="logo">
        <span class="logo-icon">🎭</span>
        <h1>London Musicals</h1>
      </div>
      <div class="date-badge">{{TODAY}}</div>
    </div>
  </header>

  <div class="stats">
    <div class="stat">
      <div class="stat-value">{{TOTAL_COUNT}}</div>
      <div class="stat-label">Shows Playing</div>
    </div>
    <div class="stat">
      <div class="stat-value">{{WEST_END_COUNT}}</div>
      <div class="stat-label">West End</div>
    </div>
    <div class="stat">
      <div class="stat-value">{{OFF_WEST_END_COUNT}}</div>
      <div class="stat-label">Off West End</div>
    </div>
    <div class="stat">
      <div class="stat-value">{{DRAMA_SCHOOL_COUNT}}</div>
      <div class="stat-label">Drama Schools</div>
    </div>
  </div>

  <div class="filters">
    <button class="filter-btn active" data-filter="all">All Shows</button>
    <button class="filter-btn" data-filter="west-end">West End</button>
    <button class="filter-btn" data-filter="off-west-end">Off West End</button>
    <button class="filter-btn" data-filter="drama-school">Drama Schools</button>
  </div>

  <main class="container">
    <section class="section" data-section="west-end">
      <h2 class="section-title">
        <span>West End</span>
        <span class="section-count">{{WEST_END_COUNT}} shows</span>
      </h2>
      <div class="cards-grid">
        {{WEST_END_CARDS}}
      </div>
    </section>

    <section class="section" data-section="off-west-end">
      <h2 class="section-title">
        <span>Off West End</span>
        <span class="section-count">{{OFF_WEST_END_COUNT}} shows</span>
      </h2>
      <div class="cards-grid">
        {{OFF_WEST_END_CARDS}}
      </div>
    </section>

    <section class="section" data-section="drama-school">
      <h2 class="section-title">
        <span>Drama School Productions</span>
        <span class="section-count">{{DRAMA_SCHOOL_COUNT}} shows</span>
      </h2>
      <div class="cards-grid">
        {{DRAMA_SCHOOL_CARDS}}
      </div>
    </section>
  </main>

  <footer class="footer">
    <p>London Musicals &copy; 2025 | Powered by Cloudflare Workers</p>
    <p style="margin-top: 10px;">Data updated daily at 6:00 AM UTC</p>
  </footer>

  <script>
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const filter = btn.dataset.filter;
        document.querySelectorAll('.section').forEach(section => {
          if (filter === 'all') {
            section.classList.remove('hidden');
          } else {
            section.classList.toggle('hidden', section.dataset.section !== filter);
          }
        });
      });
    });
  </script>
</body>
</html>`;
