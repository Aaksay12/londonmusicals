/**
 * London Musicals - Cloudflare Worker
 *
 * A listing site for musicals currently playing in London
 * - West End, Off West End, and Drama School productions
 * - Daily cron job filters to currently running shows
 * - Admin panel with Basic Auth for CRUD operations
 */

// Basic Auth check
function checkBasicAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return false;
  }
  const base64Credentials = authHeader.slice(6);
  const credentials = atob(base64Credentials);
  const [username, password] = credentials.split(':');
  return username === env.ADMIN_USERNAME && password === env.ADMIN_PASSWORD;
}

function unauthorizedResponse() {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Admin Panel", charset="UTF-8"' },
  });
}

// Generate normalized slug from title, venue, and start_date
function generateRunId(title, venueName, startDate) {
  const normalize = (str) => str
    .toLowerCase()
    .replace(/['']/g, '')           // Remove apostrophes
    .replace(/[^a-z0-9\s-]/g, '')   // Remove special chars
    .replace(/\s+/g, '-')           // Spaces to hyphens
    .replace(/-+/g, '-')            // Multiple hyphens to single
    .replace(/^-|-$/g, '');         // Trim hyphens

  return `${normalize(title)}-${normalize(venueName)}-${startDate}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Admin routes - require authentication
    if (url.pathname.startsWith('/admin')) {
      if (!checkBasicAuth(request, env)) {
        return unauthorizedResponse();
      }

      // Admin API routes
      if (url.pathname.startsWith('/admin/api/')) {
        return handleAdminAPI(request, env, url);
      }

      // Admin UI
      return new Response(await generateAdminHTML(env), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // Public API Routes
    if (url.pathname.startsWith('/api/')) {
      return handleAPI(request, env, url);
    }

    // Demo showcards page
    if (url.pathname === '/showcards') {
      return new Response(getShowcardsDemo(), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // Serve the public HTML interface
    return new Response(await generateHTML(env), {
      headers: { 'Content-Type': 'text/html' },
    });
  },

  // Cron trigger - runs daily
  async scheduled(event, env, ctx) {
    const today = new Date().toISOString().split('T')[0];
    const { results } = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM musicals
      WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)
    `).bind(today, today).all();
    console.log(`[Cron] ${today}: ${results[0].count} active musicals`);
  },
};

// Admin API handlers
async function handleAdminAPI(request, env, url) {
  const headers = { 'Content-Type': 'application/json' };

  try {
    // GET /admin/api/musicals - List ALL musicals (not just current)
    if (url.pathname === '/admin/api/musicals' && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM musicals ORDER BY type, title'
      ).all();
      return new Response(JSON.stringify(results), { headers });
    }

    // POST /admin/api/musicals - Create new musical
    if (url.pathname === '/admin/api/musicals' && request.method === 'POST') {
      const data = await request.json();
      const runId = generateRunId(data.title, data.venue_name, data.start_date);

      const result = await env.DB.prepare(`
        INSERT INTO musicals (title, venue_name, venue_address, type, start_date, end_date, description, ticket_url, price_from, schedule, lottery_url, lottery_price, rush_url, rush_price, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        data.title,
        data.venue_name,
        data.venue_address || null,
        data.type,
        data.start_date,
        data.end_date || null,
        data.description || null,
        data.ticket_url || null,
        data.price_from || null,
        data.schedule || null,
        data.lottery_url || null,
        data.lottery_price || null,
        data.rush_url || null,
        data.rush_price || null,
        runId
      ).run();

      const newMusical = await env.DB.prepare('SELECT * FROM musicals WHERE id = ?')
        .bind(result.meta.last_row_id).first();

      return new Response(JSON.stringify(newMusical), { status: 201, headers });
    }

    // PUT /admin/api/musicals/:id - Update musical
    if (url.pathname.match(/^\/admin\/api\/musicals\/\d+$/) && request.method === 'PUT') {
      const id = url.pathname.split('/')[4];
      const data = await request.json();
      const runId = generateRunId(data.title, data.venue_name, data.start_date);

      await env.DB.prepare(`
        UPDATE musicals SET
          title = ?, venue_name = ?, venue_address = ?, type = ?,
          start_date = ?, end_date = ?, description = ?,
          ticket_url = ?, price_from = ?, schedule = ?,
          lottery_url = ?, lottery_price = ?, rush_url = ?, rush_price = ?,
          run_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        data.title,
        data.venue_name,
        data.venue_address || null,
        data.type,
        data.start_date,
        data.end_date || null,
        data.description || null,
        data.ticket_url || null,
        data.price_from || null,
        data.schedule || null,
        data.lottery_url || null,
        data.lottery_price || null,
        data.rush_url || null,
        data.rush_price || null,
        runId,
        id
      ).run();

      const updated = await env.DB.prepare('SELECT * FROM musicals WHERE id = ?').bind(id).first();
      return new Response(JSON.stringify(updated), { headers });
    }

    // DELETE /admin/api/musicals/:id - Delete musical
    if (url.pathname.match(/^\/admin\/api\/musicals\/\d+$/) && request.method === 'DELETE') {
      const id = url.pathname.split('/')[4];
      await env.DB.prepare('DELETE FROM musicals WHERE id = ?').bind(id).run();
      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // POST /admin/api/musicals/import - Bulk import from CSV data with upsert
    if (url.pathname === '/admin/api/musicals/import' && request.method === 'POST') {
      const { records } = await request.json();
      let inserted = 0;
      let updated = 0;
      let errors = [];

      for (const row of records) {
        try {
          // Use provided run_id or generate one
          const runId = (row.run_id && row.run_id.trim()) ? row.run_id.trim() : generateRunId(row.title, row.venue_name, row.start_date);

          // Check if record exists
          const existing = await env.DB.prepare('SELECT id FROM musicals WHERE run_id = ?').bind(runId).first();

          if (existing) {
            // Update existing record
            await env.DB.prepare(`
              UPDATE musicals SET
                title = ?, venue_name = ?, venue_address = ?, type = ?,
                start_date = ?, end_date = ?, description = ?,
                ticket_url = ?, price_from = ?, schedule = ?,
                lottery_url = ?, lottery_price = ?, rush_url = ?, rush_price = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE run_id = ?
            `).bind(
              row.title,
              row.venue_name,
              row.venue_address || null,
              row.type,
              row.start_date,
              row.end_date || null,
              row.description || null,
              row.ticket_url || null,
              row.price_from ? parseFloat(row.price_from) : null,
              row.schedule || null,
              row.lottery_url || null,
              row.lottery_price ? parseFloat(row.lottery_price) : null,
              row.rush_url || null,
              row.rush_price ? parseFloat(row.rush_price) : null,
              runId
            ).run();
            updated++;
          } else {
            // Insert new record
            await env.DB.prepare(`
              INSERT INTO musicals (title, venue_name, venue_address, type, start_date, end_date, description, ticket_url, price_from, schedule, lottery_url, lottery_price, rush_url, rush_price, run_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              row.title,
              row.venue_name,
              row.venue_address || null,
              row.type,
              row.start_date,
              row.end_date || null,
              row.description || null,
              row.ticket_url || null,
              row.price_from ? parseFloat(row.price_from) : null,
              row.schedule || null,
              row.lottery_url || null,
              row.lottery_price ? parseFloat(row.lottery_price) : null,
              row.rush_url || null,
              row.rush_price ? parseFloat(row.rush_price) : null,
              runId
            ).run();
            inserted++;
          }
        } catch (err) {
          errors.push({ row: row.title, error: err.message });
        }
      }

      return new Response(JSON.stringify({ inserted, updated, errors }), { headers });
    }

    // POST /admin/api/delete-all - Delete all records (requires password confirmation)
    if (url.pathname === '/admin/api/delete-all' && request.method === 'POST') {
      const { password } = await request.json();

      // Verify password matches
      if (password !== env.ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: 'Invalid password' }), { status: 401, headers });
      }

      const { meta } = await env.DB.prepare('DELETE FROM musicals').run();
      return new Response(JSON.stringify({ deleted: meta.changes }), { headers });
    }

    // POST /admin/api/migrate-run-ids - One-time migration to populate run_ids
    if (url.pathname === '/admin/api/migrate-run-ids' && request.method === 'POST') {
      const { results } = await env.DB.prepare('SELECT id, title, venue_name, start_date FROM musicals WHERE run_id IS NULL').all();
      let migrated = 0;

      for (const row of results) {
        const runId = generateRunId(row.title, row.venue_name, row.start_date);
        await env.DB.prepare('UPDATE musicals SET run_id = ? WHERE id = ?').bind(runId, row.id).run();
        migrated++;
      }

      return new Response(JSON.stringify({ migrated }), { headers });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
  }
}

// Public API handlers
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
    if (url.pathname === '/api/musicals' && request.method === 'GET') {
      const today = new Date().toISOString().split('T')[0];
      const type = url.searchParams.get('type');

      let query = `SELECT * FROM musicals WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)`;
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

    if (url.pathname.match(/^\/api\/musicals\/\d+$/) && request.method === 'GET') {
      const id = url.pathname.split('/')[3];
      const result = await env.DB.prepare('SELECT * FROM musicals WHERE id = ?').bind(id).first();
      if (!result) {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

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
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// Admin HTML generator
async function generateAdminHTML(env) {
  const { results: musicals } = await env.DB.prepare(
    'SELECT * FROM musicals ORDER BY type, title'
  ).all();

  return ADMIN_TEMPLATE.replace('{{MUSICALS_JSON}}', JSON.stringify(musicals));
}

// Public HTML generator
async function generateHTML(env) {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // Calculate 3 months from today
  const threeMonths = new Date(today);
  threeMonths.setMonth(threeMonths.getMonth() + 3);
  const threeMonthsStr = threeMonths.toISOString().split('T')[0];

  // Fetch ALL musicals for client-side date filtering
  const { results: allMusicals } = await env.DB.prepare(`
    SELECT * FROM musicals ORDER BY type, title
  `).all();

  return HTML_TEMPLATE
    .replaceAll('{{MUSICALS_DATA}}', JSON.stringify(allMusicals))
    .replaceAll('{{TODAY_DATE}}', todayStr)
    .replaceAll('{{THREE_MONTHS_DATE}}', threeMonthsStr)
    .replaceAll('{{TODAY}}', today.toLocaleDateString('en-GB', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    }));
}

function renderCard(musical) {
  const endDate = musical.end_date
    ? new Date(musical.end_date).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Open run';
  const price = musical.price_from ? `From £${musical.price_from.toFixed(2)}` : '';

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
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Admin Panel Template
const ADMIN_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin - London Musicals</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #fff;
      min-height: 100vh;
    }
    .header {
      background: #16213e;
      padding: 20px;
      border-bottom: 2px solid #e94560;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header h1 { color: #e94560; font-size: 1.5rem; }
    .header a { color: #f5af19; text-decoration: none; }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }

    .form-section {
      background: #16213e;
      padding: 25px;
      border-radius: 12px;
      margin-bottom: 30px;
    }
    .form-section h2 { margin-bottom: 20px; color: #f5af19; }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
    }
    .form-group { display: flex; flex-direction: column; gap: 5px; }
    .form-group.full { grid-column: 1 / -1; }
    label { font-size: 0.85rem; color: #aaa; }
    input, select, textarea {
      padding: 10px 12px;
      border: 1px solid #333;
      border-radius: 6px;
      background: #0f3460;
      color: #fff;
      font-size: 0.95rem;
    }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: #e94560;
    }
    textarea { resize: vertical; min-height: 80px; }
    .schedule-grid { background: #0f3460; border-radius: 8px; padding: 15px; margin-top: 8px; }
    .schedule-header, .schedule-row { display: grid; grid-template-columns: 70px repeat(7, 1fr); gap: 8px; align-items: center; }
    .schedule-header { margin-bottom: 10px; font-size: 0.8rem; color: #888; text-align: center; }
    .schedule-header span:first-child { text-align: left; }
    .schedule-row { margin-bottom: 8px; }
    .schedule-row span { font-size: 0.85rem; color: #aaa; }
    .schedule-row input[type="time"] {
      padding: 4px;
      background: #1a1a2e;
      border: 1px solid #333;
      border-radius: 4px;
      color: #fff;
      font-size: 0.8rem;
      width: 100%;
    }
    .schedule-row input[type="time"]::-webkit-calendar-picker-indicator { filter: invert(1); }
    .btn-row { display: flex; gap: 10px; margin-top: 15px; }
    .btn {
      padding: 12px 24px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-size: 0.95rem;
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.9; }
    .btn-primary { background: #e94560; color: #fff; }
    .btn-secondary { background: #333; color: #fff; }
    .btn-danger { background: #dc2626; color: #fff; }

    .table-section { background: #16213e; border-radius: 12px; overflow: hidden; }
    .table-header {
      padding: 20px;
      border-bottom: 1px solid #333;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .table-header h2 { color: #f5af19; }
    .search-box {
      padding: 8px 12px;
      border: 1px solid #333;
      border-radius: 6px;
      background: #0f3460;
      color: #fff;
      width: 250px;
    }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #333; }
    th { background: #0f3460; font-weight: 600; color: #aaa; font-size: 0.85rem; }
    th.sortable { cursor: pointer; user-select: none; }
    th.sortable:hover { color: #f5af19; }
    th .sort-icon { margin-left: 5px; font-size: 0.7rem; }
    th.sort-asc .sort-icon::after { content: '▲'; }
    th.sort-desc .sort-icon::after { content: '▼'; }
    tr:hover { background: rgba(233, 69, 96, 0.1); }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge-west-end { background: #e94560; }
    .badge-off-west-end { background: #8b5cf6; }
    .badge-drama-school { background: #06b6d4; }
    .badge-active { background: #22c55e; }
    .badge-ended { background: #6b7280; }
    .actions { display: flex; gap: 8px; }
    .btn-sm {
      padding: 6px 12px;
      font-size: 0.8rem;
      border-radius: 4px;
    }
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 15px 25px;
      border-radius: 8px;
      color: #fff;
      font-weight: 500;
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.3s;
    }
    .toast.show { transform: translateY(0); opacity: 1; }
    .toast.success { background: #22c55e; }
    .toast.error { background: #dc2626; }
  </style>
</head>
<body>
  <header class="header">
    <h1>Admin Panel</h1>
    <a href="/">← Back to Site</a>
  </header>

  <div class="container">
    <div class="form-section">
      <h2 id="formTitle">Add New Musical</h2>
      <form id="musicalForm">
        <input type="hidden" id="editId">
        <div class="form-grid">
          <div class="form-group">
            <label for="title">Title *</label>
            <input type="text" id="title" required>
          </div>
          <div class="form-group">
            <label for="type">Type *</label>
            <select id="type" required>
              <option value="West End">West End</option>
              <option value="Off West End">Off West End</option>
              <option value="Drama School">Drama School</option>
            </select>
          </div>
          <div class="form-group">
            <label for="venue_name">Venue Name *</label>
            <input type="text" id="venue_name" required>
          </div>
          <div class="form-group">
            <label for="venue_address">Venue Address</label>
            <input type="text" id="venue_address">
          </div>
          <div class="form-group">
            <label for="start_date">Start Date * <small style="color:#888">(YYYY-MM-DD)</small></label>
            <input type="text" id="start_date" placeholder="2026-01-15" required>
          </div>
          <div class="form-group">
            <label for="end_date">End Date <small style="color:#888">(leave empty for Open Run)</small></label>
            <input type="text" id="end_date" placeholder="2026-12-31">
          </div>
          <div class="form-group">
            <label for="price_from">Price From (£)</label>
            <input type="number" id="price_from" step="0.01" min="0">
          </div>
          <div class="form-group">
            <label for="ticket_url">Ticket URL</label>
            <input type="url" id="ticket_url">
          </div>
          <div class="form-group">
            <label for="lottery_url">Lottery URL</label>
            <input type="url" id="lottery_url">
          </div>
          <div class="form-group">
            <label for="lottery_price">Lottery Price (£)</label>
            <input type="number" id="lottery_price" step="0.01" min="0">
          </div>
          <div class="form-group">
            <label for="rush_url">Rush URL</label>
            <input type="url" id="rush_url">
          </div>
          <div class="form-group">
            <label for="rush_price">Rush Price (£)</label>
            <input type="number" id="rush_price" step="0.01" min="0">
          </div>
          <div class="form-group full">
            <label for="description">Description</label>
            <textarea id="description"></textarea>
          </div>
          <div class="form-group full">
            <label>Weekly Schedule <small style="color:#888">(enter show times, leave empty if no performance)</small></label>
            <div class="schedule-grid">
              <div class="schedule-header">
                <span></span>
                <span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span>
              </div>
              <div class="schedule-row">
                <span>Matinee</span>
                <input type="time" id="sch_mon_m"><input type="time" id="sch_tue_m"><input type="time" id="sch_wed_m">
                <input type="time" id="sch_thu_m"><input type="time" id="sch_fri_m"><input type="time" id="sch_sat_m"><input type="time" id="sch_sun_m">
              </div>
              <div class="schedule-row">
                <span>Evening</span>
                <input type="time" id="sch_mon_e"><input type="time" id="sch_tue_e"><input type="time" id="sch_wed_e">
                <input type="time" id="sch_thu_e"><input type="time" id="sch_fri_e"><input type="time" id="sch_sat_e"><input type="time" id="sch_sun_e">
              </div>
            </div>
          </div>
        </div>
        <div class="btn-row">
          <button type="submit" class="btn btn-primary" id="submitBtn">Add Musical</button>
          <button type="button" class="btn btn-secondary" onclick="resetForm()">Cancel</button>
        </div>
      </form>
    </div>

    <div class="form-section">
      <h2>Import from CSV</h2>
      <p style="color:#888;margin-bottom:15px;font-size:0.9rem;">
        CSV columns: title, venue_name, venue_address, type, start_date, end_date, description, ticket_url, price_from
      </p>
      <div class="form-grid">
        <div class="form-group full">
          <label for="csvFile">Select CSV File</label>
          <input type="file" id="csvFile" accept=".csv" style="padding:10px;background:#0f3460;border:1px solid #333;border-radius:6px;">
        </div>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" id="importBtn">Import CSV</button>
        <button type="button" class="btn btn-secondary" id="downloadTemplate">Download Template</button>
        <button type="button" class="btn btn-secondary" id="exportBtn">Export Data</button>
        <button type="button" class="btn btn-secondary" id="migrateBtn" style="background:#8b5cf6;">Migrate Run IDs</button>
        <button type="button" class="btn btn-danger" id="deleteAllBtn">Delete All</button>
      </div>
      <div id="importResult" style="margin-top:15px;"></div>
    </div>

    <div class="table-section">
      <div class="table-header">
        <h2>All Musicals (<span id="totalCount">0</span>)</h2>
        <input type="text" class="search-box" placeholder="Search..." id="searchBox">
      </div>
      <table>
        <thead>
          <tr>
            <th class="sortable" data-sort="title">Title <span class="sort-icon"></span></th>
            <th class="sortable" data-sort="type">Type <span class="sort-icon"></span></th>
            <th class="sortable" data-sort="venue_name">Venue <span class="sort-icon"></span></th>
            <th class="sortable" data-sort="start_date">Start Date <span class="sort-icon"></span></th>
            <th class="sortable" data-sort="end_date">End Date <span class="sort-icon"></span></th>
            <th class="sortable" data-sort="status">Status <span class="sort-icon"></span></th>
            <th title="Tickets">🎟️</th>
            <th title="Lottery">🎲</th>
            <th title="Rush">⚡</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="tableBody"></tbody>
      </table>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    let musicals = {{MUSICALS_JSON}};
    const today = new Date().toISOString().split('T')[0];
    let sortColumn = 'title';
    let sortDirection = 'asc';

    function getStatus(m) {
      return m.start_date <= today && (!m.end_date || m.end_date >= today) ? 'Active' : 'Ended';
    }

    function sortMusicals(list) {
      return [...list].sort((a, b) => {
        let aVal, bVal;
        if (sortColumn === 'status') {
          aVal = getStatus(a);
          bVal = getStatus(b);
        } else {
          aVal = a[sortColumn] || '';
          bVal = b[sortColumn] || '';
        }
        if (typeof aVal === 'string') {
          aVal = aVal.toLowerCase();
          bVal = bVal.toLowerCase();
        }
        if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
        return 0;
      });
    }

    function updateSortIcons() {
      document.querySelectorAll('th.sortable').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.dataset.sort === sortColumn) {
          th.classList.add(sortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
        }
      });
    }

    function render(filter = '') {
      let filtered = musicals.filter(m =>
        m.title.toLowerCase().includes(filter.toLowerCase()) ||
        m.venue_name.toLowerCase().includes(filter.toLowerCase())
      );

      filtered = sortMusicals(filtered);
      updateSortIcons();

      document.getElementById('totalCount').textContent = musicals.length;
      document.getElementById('tableBody').innerHTML = filtered.map(m => {
        const isActive = getStatus(m) === 'Active';
        const typeClass = m.type.toLowerCase().replace(/ /g, '-');

        return \`
          <tr>
            <td><strong>\${escapeHtml(m.title)}</strong></td>
            <td><span class="badge badge-\${typeClass}">\${m.type}</span></td>
            <td>\${escapeHtml(m.venue_name)}</td>
            <td>\${m.start_date}</td>
            <td>\${m.end_date || 'Open Run'}</td>
            <td><span class="badge \${isActive ? 'badge-active' : 'badge-ended'}">\${isActive ? 'Active' : 'Ended'}</span></td>
            <td>\${m.ticket_url ? '<a href="' + escapeHtml(m.ticket_url) + '" target="_blank">URL</a>' : '-'}</td>
            <td>\${m.lottery_url ? '<a href="' + escapeHtml(m.lottery_url) + '" target="_blank">URL</a>' : '-'}</td>
            <td>\${m.rush_url ? '<a href="' + escapeHtml(m.rush_url) + '" target="_blank">URL</a>' : '-'}</td>
            <td class="actions">
              <button class="btn btn-secondary btn-sm" onclick="editMusical(\${m.id})">Edit</button>
              <button class="btn btn-danger btn-sm" onclick="deleteMusical(\${m.id})">Delete</button>
            </td>
          </tr>
        \`;
      }).join('');
    }

    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function showToast(message, type = 'success') {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = 'toast ' + type + ' show';
      setTimeout(() => toast.classList.remove('show'), 3000);
    }

    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

    function getScheduleFromForm() {
      const schedule = {};
      days.forEach(day => {
        const mat = document.getElementById('sch_' + day + '_m').value;
        const eve = document.getElementById('sch_' + day + '_e').value;
        if (mat || eve) {
          schedule[day] = { m: mat || null, e: eve || null };
        }
      });
      return Object.keys(schedule).length ? JSON.stringify(schedule) : null;
    }

    function setScheduleToForm(scheduleJson) {
      days.forEach(day => {
        document.getElementById('sch_' + day + '_m').value = '';
        document.getElementById('sch_' + day + '_e').value = '';
      });
      if (!scheduleJson) return;
      try {
        const schedule = JSON.parse(scheduleJson);
        days.forEach(day => {
          if (schedule[day]) {
            // Handle both old boolean format and new time format
            const mat = schedule[day].m;
            const eve = schedule[day].e;
            document.getElementById('sch_' + day + '_m').value = (typeof mat === 'string') ? mat : '';
            document.getElementById('sch_' + day + '_e').value = (typeof eve === 'string') ? eve : '';
          }
        });
      } catch (e) {}
    }

    function resetForm() {
      document.getElementById('musicalForm').reset();
      document.getElementById('editId').value = '';
      document.getElementById('formTitle').textContent = 'Add New Musical';
      document.getElementById('submitBtn').textContent = 'Add Musical';
      setScheduleToForm(null);
    }

    function editMusical(id) {
      const m = musicals.find(x => x.id === id);
      if (!m) return;

      document.getElementById('editId').value = m.id;
      document.getElementById('title').value = m.title;
      document.getElementById('type').value = m.type;
      document.getElementById('venue_name').value = m.venue_name;
      document.getElementById('venue_address').value = m.venue_address || '';
      document.getElementById('start_date').value = m.start_date;
      document.getElementById('end_date').value = m.end_date || '';
      document.getElementById('price_from').value = m.price_from || '';
      document.getElementById('ticket_url').value = m.ticket_url || '';
      document.getElementById('lottery_url').value = m.lottery_url || '';
      document.getElementById('lottery_price').value = m.lottery_price || '';
      document.getElementById('rush_url').value = m.rush_url || '';
      document.getElementById('rush_price').value = m.rush_price || '';
      document.getElementById('description').value = m.description || '';
      setScheduleToForm(m.schedule);

      document.getElementById('formTitle').textContent = 'Edit Musical';
      document.getElementById('submitBtn').textContent = 'Update Musical';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    async function deleteMusical(id) {
      if (!confirm('Are you sure you want to delete this musical?')) return;

      try {
        const res = await fetch('/admin/api/musicals/' + id, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete');

        musicals = musicals.filter(m => m.id !== id);
        render(document.getElementById('searchBox').value);
        showToast('Musical deleted successfully');
      } catch (err) {
        showToast('Error: ' + err.message, 'error');
      }
    }

    function normalizeDate(input) {
      if (!input) return null;
      const val = input.trim();
      // Already in YYYY-MM-DD format
      if (/^\\d{4}-\\d{2}-\\d{2}$/.test(val)) return val;
      // DD/MM/YYYY or DD-MM-YYYY format
      const match = val.match(/^(\\d{1,2})[\\/\\-](\\d{1,2})[\\/\\-](\\d{4})$/);
      if (match) {
        const day = match[1].padStart(2, '0');
        const month = match[2].padStart(2, '0');
        const year = match[3];
        return year + '-' + month + '-' + day;
      }
      return val;
    }

    function isValidDate(str) {
      if (!str) return true; // Empty is OK for optional fields
      if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(str)) return false;
      const date = new Date(str);
      return !isNaN(date.getTime());
    }

    document.getElementById('musicalForm').addEventListener('submit', async (e) => {
      e.preventDefault();

      const startDateInput = document.getElementById('start_date');
      const endDateInput = document.getElementById('end_date');

      const startDate = normalizeDate(startDateInput.value);
      const endDate = normalizeDate(endDateInput.value);

      if (!startDate) {
        showToast('Start date is required.', 'error');
        startDateInput.focus();
        return;
      }

      if (!isValidDate(startDate)) {
        showToast('Invalid start date. Use YYYY-MM-DD or DD/MM/YYYY format.', 'error');
        startDateInput.focus();
        return;
      }

      if (!isValidDate(endDate)) {
        showToast('Invalid end date. Use YYYY-MM-DD or DD/MM/YYYY format.', 'error');
        endDateInput.focus();
        return;
      }

      // Update the input values with normalized dates
      if (startDate) startDateInput.value = startDate;
      if (endDate) endDateInput.value = endDate;

      const editId = document.getElementById('editId').value;
      const data = {
        title: document.getElementById('title').value,
        type: document.getElementById('type').value,
        venue_name: document.getElementById('venue_name').value,
        venue_address: document.getElementById('venue_address').value || null,
        start_date: startDate,
        end_date: endDate,
        price_from: document.getElementById('price_from').value ? parseFloat(document.getElementById('price_from').value) : null,
        ticket_url: document.getElementById('ticket_url').value || null,
        lottery_url: document.getElementById('lottery_url').value || null,
        lottery_price: document.getElementById('lottery_price').value ? parseFloat(document.getElementById('lottery_price').value) : null,
        rush_url: document.getElementById('rush_url').value || null,
        rush_price: document.getElementById('rush_price').value ? parseFloat(document.getElementById('rush_price').value) : null,
        description: document.getElementById('description').value || null,
        schedule: getScheduleFromForm(),
      };

      try {
        const url = editId ? '/admin/api/musicals/' + editId : '/admin/api/musicals';
        const method = editId ? 'PUT' : 'POST';

        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });

        if (!res.ok) throw new Error('Failed to save');

        const saved = await res.json();

        if (editId) {
          const idx = musicals.findIndex(m => m.id === parseInt(editId));
          musicals[idx] = saved;
          showToast('Musical updated successfully');
        } else {
          musicals.unshift(saved);
          showToast('Musical added successfully');
        }

        resetForm();
        render(document.getElementById('searchBox').value);
      } catch (err) {
        showToast('Error: ' + err.message, 'error');
      }
    });

    document.getElementById('searchBox').addEventListener('input', (e) => {
      render(e.target.value);
    });

    // Sortable column headers
    document.querySelectorAll('th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const column = th.dataset.sort;
        if (sortColumn === column) {
          sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          sortColumn = column;
          sortDirection = 'asc';
        }
        render(document.getElementById('searchBox').value);
      });
    });

    // CSV Import functionality
    function parseCSV(text) {
      const lines = text.split('\\n').filter(line => line.trim());
      if (lines.length < 2) return [];

      const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z_]/g, ''));
      const records = [];

      for (let i = 1; i < lines.length; i++) {
        const values = [];
        let current = '';
        let inQuotes = false;
        const line = lines[i];

        for (let j = 0; j < line.length; j++) {
          const char = line[j];
          const nextChar = line[j + 1];

          if (char === '"' && inQuotes && nextChar === '"') {
            // Escaped quote ("") - add single quote and skip next char
            current += '"';
            j++;
          } else if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            values.push(current.trim());
            current = '';
          } else {
            current += char;
          }
        }
        values.push(current.trim());

        const record = {};
        headers.forEach((h, idx) => {
          record[h] = values[idx] || '';
        });
        records.push(record);
      }

      return records;
    }

    document.getElementById('importBtn').addEventListener('click', async () => {
      const fileInput = document.getElementById('csvFile');
      const resultDiv = document.getElementById('importResult');

      if (!fileInput.files.length) {
        showToast('Please select a CSV file', 'error');
        return;
      }

      const file = fileInput.files[0];
      const text = await file.text();
      const records = parseCSV(text);

      if (!records.length) {
        showToast('No valid records found in CSV', 'error');
        return;
      }

      resultDiv.innerHTML = '<span style="color:#f5af19;">Importing ' + records.length + ' records...</span>';

      try {
        const res = await fetch('/admin/api/musicals/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ records }),
        });

        const result = await res.json();

        if (result.inserted > 0 || result.updated > 0) {
          showToast('Inserted ' + result.inserted + ', Updated ' + result.updated + ' musicals');
          // Reload the page to refresh data
          setTimeout(() => location.reload(), 1500);
        }

        let html = '<span style="color:#22c55e;">Inserted: ' + result.inserted + '</span>';
        html += '<br><span style="color:#f5af19;">Updated: ' + result.updated + '</span>';
        if (result.errors.length) {
          html += '<br><span style="color:#dc2626;">Errors: ' + result.errors.length + '</span>';
          html += '<ul style="margin-top:10px;font-size:0.85rem;color:#999;">';
          result.errors.forEach(e => {
            html += '<li>' + escapeHtml(e.row) + ': ' + escapeHtml(e.error) + '</li>';
          });
          html += '</ul>';
        }
        resultDiv.innerHTML = html;

      } catch (err) {
        showToast('Import failed: ' + err.message, 'error');
        resultDiv.innerHTML = '<span style="color:#dc2626;">Error: ' + escapeHtml(err.message) + '</span>';
      }
    });

    document.getElementById('downloadTemplate').addEventListener('click', () => {
      const template = 'title,venue_name,venue_address,type,start_date,end_date,description,ticket_url,price_from,schedule,lottery_url,lottery_price,rush_url,rush_price\\n' +
        '"Example Musical","Theatre Name","123 London St, W1","West End","2025-01-01","2025-12-31","A great show","https://example.com",29.99,"{\\"mon\\":{\\"m\\":null,\\"e\\":\\"19:30\\"}}","","","",""';
      const blob = new Blob([template], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'musicals_template.csv';
      a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById('deleteAllBtn').addEventListener('click', async () => {
      if (!confirm('WARNING: This will DELETE ALL ' + musicals.length + ' records. This cannot be undone!')) return;

      const password = prompt('Enter admin password to confirm:');
      if (!password) return;

      try {
        const res = await fetch('/admin/api/delete-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });

        const result = await res.json();

        if (!res.ok) {
          showToast(result.error || 'Delete failed', 'error');
          return;
        }

        showToast('Deleted ' + result.deleted + ' records');
        setTimeout(() => location.reload(), 1000);
      } catch (err) {
        showToast('Delete failed: ' + err.message, 'error');
      }
    });

    document.getElementById('migrateBtn').addEventListener('click', async () => {
      if (!confirm('This will generate run_ids for all records that don\\'t have one. Continue?')) return;

      try {
        const res = await fetch('/admin/api/migrate-run-ids', { method: 'POST' });
        const result = await res.json();
        showToast('Migrated ' + result.migrated + ' records');
        if (result.migrated > 0) {
          setTimeout(() => location.reload(), 1000);
        }
      } catch (err) {
        showToast('Migration failed: ' + err.message, 'error');
      }
    });

    document.getElementById('exportBtn').addEventListener('click', () => {
      const headers = ['run_id', 'title', 'venue_name', 'venue_address', 'type', 'start_date', 'end_date', 'description', 'ticket_url', 'price_from', 'schedule', 'lottery_url', 'lottery_price', 'rush_url', 'rush_price'];
      const csvRows = [headers.join(',')];

      musicals.forEach(m => {
        const row = headers.map(h => {
          const val = m[h];
          if (val === null || val === undefined) return '';
          const str = String(val);
          if (str.includes(',') || str.includes('"') || str.includes('\\n')) {
            return '"' + str.replace(/"/g, '""') + '"';
          }
          return str;
        });
        csvRows.push(row.join(','));
      });

      const csv = csvRows.join('\\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'musicals_export_' + new Date().toISOString().split('T')[0] + '.csv';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Exported ' + musicals.length + ' musicals');
    });

    render();
  </script>
</body>
</html>`;

// Public Site Template
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>London Musicals - What's On Stage Today</title>
  <meta name="description" content="Discover musicals playing in London today. West End, Off West End, and Drama School productions.">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
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
    .container { max-width: 1200px; margin: 0 auto; padding: 0 20px; }
    .header-content {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 15px;
    }
    .logo { display: flex; align-items: center; gap: 12px; }
    .logo-icon { font-size: 2.5rem; }
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
    .stat-value { font-size: 2.5rem; font-weight: 700; color: #f5af19; }
    .stat-label { font-size: 0.85rem; color: #ccc; margin-top: 5px; }
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
    .filter-btn:hover, .filter-btn.active { background: #e94560; }
    .date-filter {
      display: flex;
      justify-content: center;
      padding: 15px 20px;
    }
    .date-filter-inner {
      display: flex;
      align-items: center;
      gap: 15px;
      background: rgba(255,255,255,0.1);
      padding: 12px 20px;
      border-radius: 12px;
      flex-wrap: wrap;
      justify-content: center;
    }
    .date-filter label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.9rem;
      color: #ccc;
    }
    .date-filter input[type="date"] {
      padding: 8px 12px;
      border: 1px solid #444;
      border-radius: 6px;
      background: #0f3460;
      color: #fff;
      font-size: 0.9rem;
    }
    .date-filter input[type="date"]:focus {
      outline: none;
      border-color: #e94560;
    }
    .date-filter-btn {
      padding: 8px 18px;
      border: none;
      border-radius: 6px;
      background: #e94560;
      color: #fff;
      font-weight: 600;
      cursor: pointer;
      font-size: 0.9rem;
      transition: opacity 0.2s;
    }
    .date-filter-btn:hover { opacity: 0.9; }
    .date-filter-btn.secondary {
      background: #444;
    }
    .date-filter-btn.secondary.active {
      background: #e94560;
    }
    .date-separator {
      color: #555;
      font-size: 1.2rem;
    }
    .section { padding: 30px 0; }
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
      position: relative;
    }
    .ticket-badges {
      position: absolute;
      top: 12px;
      right: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .ticket-badge {
      display: flex;
      align-items: center;
      gap: 4px;
      background: rgba(0, 0, 0, 0.6);
      padding: 4px 8px;
      border-radius: 8px;
      font-size: 0.75rem;
      font-weight: 600;
      text-decoration: none;
      color: #fff;
      transition: background 0.2s;
    }
    .ticket-badge:hover {
      background: rgba(0, 0, 0, 0.8);
    }
    .ticket-badge.lottery { border: 1px solid #a855f7; }
    .ticket-badge.rush { border: 1px solid #f59e0b; }
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
    .card-title { font-size: 1.3rem; font-weight: 700; margin-bottom: 8px; }
    .card-venue { color: #f5af19; font-size: 0.95rem; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .venue-icons { display: inline-flex; gap: 6px; }
    .venue-icon {
      font-size: 0.85rem;
      text-decoration: none;
      opacity: 0.7;
      transition: opacity 0.2s;
    }
    .venue-icon:hover { opacity: 1; }
    .card-desc { color: #aaa; font-size: 0.9rem; margin-bottom: 15px; line-height: 1.5; }
    .card-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
      font-size: 0.85rem;
      color: #999;
    }
    .card-price { color: #4ade80; font-weight: 600; }
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
    .card-btn:hover { opacity: 0.9; transform: scale(1.02); }
    .schedule-grid-public {
      display: flex;
      justify-content: center;
      gap: 6px;
      margin: 12px 0;
      padding: 10px;
      background: rgba(0,0,0,0.2);
      border-radius: 8px;
    }
    .day-col {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      min-width: 32px;
    }
    .day-label {
      font-size: 10px;
      color: #888;
      font-weight: 600;
    }
    .show-time {
      font-size: 9px;
      color: #4ade80;
      background: rgba(74, 222, 128, 0.1);
      padding: 2px 4px;
      border-radius: 3px;
    }
    .show-time.empty {
      color: #444;
      background: transparent;
    }
    .footer {
      text-align: center;
      padding: 40px 20px;
      color: #666;
      font-size: 0.85rem;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      margin-top: 40px;
    }
    .hidden { display: none !important; }
    @media (max-width: 600px) {
      .logo h1 { font-size: 1.4rem; }
      .stats { gap: 15px; }
      .stat { padding: 15px 20px; min-width: 100px; }
      .stat-value { font-size: 1.8rem; }
      .cards-grid { grid-template-columns: 1fr; }
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
    <button class="filter-btn" data-filter="rush-lottery">Rush & Lottery</button>
    <button class="filter-btn" data-filter="closing-soon">Closing Soon</button>
  </div>

  <div class="date-filter">
    <div class="date-filter-inner">
      <button class="date-filter-btn secondary" id="btnToday">Today</button>
      <button class="date-filter-btn secondary" id="btnThisWeek">This Week</button>
      <button class="date-filter-btn secondary" id="btnThisMonth">This Month</button>
      <button class="date-filter-btn secondary active" id="btnThisQuarter">This Quarter</button>
      <button class="date-filter-btn secondary" id="btnThisYear">This Year</button>
      <span class="date-separator">|</span>
      <label>
        <span>From</span>
        <input type="date" id="dateFrom">
      </label>
      <label>
        <span>To</span>
        <input type="date" id="dateTo">
      </label>
      <button class="date-filter-btn" id="applyDateFilter">Apply</button>
      <button class="date-filter-btn secondary" id="clearDateFilter">Clear</button>
    </div>
  </div>

  <main class="container">
    <section class="section" data-section="west-end">
      <h2 class="section-title">
        <span>West End</span>
        <span class="section-count" id="westEndCount">0 shows</span>
      </h2>
      <div class="cards-grid" id="westEndCards"></div>
    </section>

    <section class="section" data-section="off-west-end">
      <h2 class="section-title">
        <span>Off West End</span>
        <span class="section-count" id="offWestEndCount">0 shows</span>
      </h2>
      <div class="cards-grid" id="offWestEndCards"></div>
    </section>

    <section class="section" data-section="drama-school">
      <h2 class="section-title">
        <span>Drama School Productions</span>
        <span class="section-count" id="dramaSchoolCount">0 shows</span>
      </h2>
      <div class="cards-grid" id="dramaSchoolCards"></div>
    </section>
  </main>

  <footer class="footer">
    <p>London Musicals &copy; 2025 | Powered by Cloudflare Workers</p>
    <p style="margin-top: 10px;">Data updated daily at 6:00 AM UTC</p>
  </footer>

  <script>
    const allMusicals = {{MUSICALS_DATA}};
    const defaultDate = '{{TODAY_DATE}}';
    const defaultEndDate = '{{THREE_MONTHS_DATE}}';
    let typeFilter = 'all';

    // Set default date range
    document.getElementById('dateFrom').value = defaultDate;
    document.getElementById('dateTo').value = defaultEndDate;

    function getDayOfWeek(dateStr) {
      // Parse YYYY-MM-DD manually to avoid timezone issues
      const parts = dateStr.split('-');
      const date = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      return date.getDay(); // 0 = Sunday, 1 = Monday, etc.
    }

    function hasPerformance(value) {
      // Handle both boolean (old format) and string time (new format)
      if (typeof value === 'string') return value.length > 0;
      return !!value;
    }

    function isShowActive(show, fromDate, toDate) {
      const start = show.start_date;
      const end = show.end_date || '9999-12-31';

      // Basic date range check
      if (!(start <= toDate && end >= fromDate)) {
        return false;
      }

      // If single day selected and show has schedule, check if it plays that day
      if (fromDate === toDate && show.schedule) {
        try {
          const schedule = JSON.parse(show.schedule);
          const dayIndex = getDayOfWeek(fromDate);
          const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
          const dayKey = dayKeys[dayIndex];

          // If schedule exists but this day has no performances, filter out
          if (!schedule[dayKey] || (!hasPerformance(schedule[dayKey].m) && !hasPerformance(schedule[dayKey].e))) {
            return false;
          }
        } catch (e) {
          // If schedule parsing fails, include the show
        }
      }

      return true;
    }

    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function formatTime(timeStr) {
      if (!timeStr) return '-';
      // Convert 24h format (19:30) to 12h format (7:30pm)
      const [h, m] = timeStr.split(':');
      const hour = parseInt(h);
      const suffix = hour >= 12 ? 'pm' : 'am';
      const hour12 = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
      return hour12 + ':' + m + suffix;
    }

    function renderScheduleDots(scheduleJson) {
      if (!scheduleJson) return '';
      try {
        const schedule = JSON.parse(scheduleJson);
        const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
        const labels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
        let html = '<div class="schedule-grid-public">';
        days.forEach((day, i) => {
          const mat = schedule[day] && schedule[day].m;
          const eve = schedule[day] && schedule[day].e;
          // Handle both old boolean format and new time format
          const matTime = (typeof mat === 'string') ? formatTime(mat) : (mat ? '•' : '-');
          const eveTime = (typeof eve === 'string') ? formatTime(eve) : (eve ? '•' : '-');
          html += '<div class="day-col">' +
            '<span class="day-label">' + labels[i] + '</span>' +
            '<span class="show-time ' + (matTime === '-' ? 'empty' : '') + '">' + matTime + '</span>' +
            '<span class="show-time ' + (eveTime === '-' ? 'empty' : '') + '">' + eveTime + '</span>' +
            '</div>';
        });
        html += '</div>';
        return html;
      } catch (e) { return ''; }
    }

    function renderTicketBadges(m) {
      let html = '';
      if (m.lottery_url || m.rush_url) {
        html = '<div class="ticket-badges">';
        if (m.lottery_url) {
          const lotteryPrice = m.lottery_price ? '£' + m.lottery_price.toFixed(0) : '';
          html += '<a href="' + escapeHtml(m.lottery_url) + '" target="_blank" rel="noopener" class="ticket-badge lottery">🎲 ' + lotteryPrice + '</a>';
        }
        if (m.rush_url) {
          const rushPrice = m.rush_price ? '£' + m.rush_price.toFixed(0) : '';
          html += '<a href="' + escapeHtml(m.rush_url) + '" target="_blank" rel="noopener" class="ticket-badge rush">⚡ ' + rushPrice + '</a>';
        }
        html += '</div>';
      }
      return html;
    }

    function renderVenueIcons(venueName, venueAddress) {
      if (!venueAddress) return '';
      const query = encodeURIComponent(venueName + ' ' + venueAddress);
      return '<span class="venue-icons">' +
        '<a href="https://www.google.com/maps/search/?api=1&query=' + query + '" target="_blank" rel="noopener" class="venue-icon" title="View on map">📍</a>' +
        '<a href="https://www.google.com/maps/dir/?api=1&destination=' + query + '" target="_blank" rel="noopener" class="venue-icon" title="Get directions">🧭</a>' +
        '</span>';
    }

    function renderCard(m) {
      const today = new Date().toISOString().split('T')[0];
      const hasStarted = m.start_date <= today;
      const isSingleDay = m.end_date && m.start_date === m.end_date;

      let dateText;
      if (isSingleDay) {
        // Single day show/concert
        const dateFormatted = new Date(m.start_date).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: 'numeric' });
        dateText = 'Only on ' + dateFormatted;
      } else if (hasStarted) {
        // Show started - display end date only
        dateText = m.end_date
          ? 'Until ' + new Date(m.end_date).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: 'numeric' })
          : 'Open run';
      } else {
        // Show not started yet - display both dates (or just start if open run)
        const startFormatted = new Date(m.start_date).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: 'numeric' });
        if (m.end_date) {
          const endFormatted = new Date(m.end_date).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: 'numeric' });
          dateText = 'From ' + startFormatted + ' until ' + endFormatted;
        } else {
          dateText = 'From ' + startFormatted;
        }
      }

      const price = m.price_from ? 'From £' + m.price_from.toFixed(2) : '';

      return '<div class="card">' +
        renderTicketBadges(m) +
        '<div class="card-badge">' + escapeHtml(m.type) + '</div>' +
        '<h3 class="card-title">' + escapeHtml(m.title) + '</h3>' +
        '<p class="card-venue"><span>' + escapeHtml(m.venue_name) + '</span>' + renderVenueIcons(m.venue_name, m.venue_address) + '</p>' +
        (m.description ? '<p class="card-desc">' + escapeHtml(m.description) + '</p>' : '') +
        renderScheduleDots(m.schedule) +
        '<div class="card-meta">' +
        '<span class="card-date">' + dateText + '</span>' +
        (price ? '<span class="card-price">' + price + '</span>' : '') +
        '</div>' +
        (m.ticket_url ? '<a href="' + escapeHtml(m.ticket_url) + '" target="_blank" rel="noopener" class="card-btn">Get Tickets</a>' : '') +
        '</div>';
    }

    function render() {
      const fromDate = document.getElementById('dateFrom').value || defaultDate;
      const toDate = document.getElementById('dateTo').value || defaultEndDate;

      let filtered = allMusicals.filter(m => isShowActive(m, fromDate, toDate));

      // Apply rush-lottery filter if selected
      if (typeFilter === 'rush-lottery') {
        filtered = filtered.filter(m => m.rush_url || m.lottery_url);
      }

      // Apply closing-soon filter if selected (shows ending within 4 weeks)
      if (typeFilter === 'closing-soon') {
        const today = new Date();
        const fourWeeksLater = new Date(today.getTime() + 28 * 24 * 60 * 60 * 1000);
        const fourWeeksDate = fourWeeksLater.toISOString().split('T')[0];
        filtered = filtered.filter(m => m.end_date && m.end_date <= fourWeeksDate);
      }

      const westEnd = filtered.filter(m => m.type === 'West End');
      const offWestEnd = filtered.filter(m => m.type === 'Off West End');
      const dramaSchool = filtered.filter(m => m.type === 'Drama School');

      document.getElementById('westEndCards').innerHTML = westEnd.map(renderCard).join('');
      document.getElementById('offWestEndCards').innerHTML = offWestEnd.map(renderCard).join('');
      document.getElementById('dramaSchoolCards').innerHTML = dramaSchool.map(renderCard).join('');

      document.getElementById('westEndCount').textContent = westEnd.length + ' shows';
      document.getElementById('offWestEndCount').textContent = offWestEnd.length + ' shows';
      document.getElementById('dramaSchoolCount').textContent = dramaSchool.length + ' shows';

      // Update stats
      document.querySelectorAll('.stat-value')[0].textContent = filtered.length;
      document.querySelectorAll('.stat-value')[1].textContent = westEnd.length;
      document.querySelectorAll('.stat-value')[2].textContent = offWestEnd.length;
      document.querySelectorAll('.stat-value')[3].textContent = dramaSchool.length;

      // Apply type filter
      document.querySelectorAll('.section').forEach(section => {
        if (typeFilter === 'all' || typeFilter === 'rush-lottery' || typeFilter === 'closing-soon') {
          section.classList.remove('hidden');
        } else {
          section.classList.toggle('hidden', section.dataset.section !== typeFilter);
        }
      });
    }

    // Type filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        typeFilter = btn.dataset.filter;
        render();
      });
    });

    // Helper to set active date button
    function setActiveDateBtn(btnId) {
      document.querySelectorAll('.date-filter-btn.secondary').forEach(btn => btn.classList.remove('active'));
      if (btnId) document.getElementById(btnId).classList.add('active');
    }

    // Date filter
    document.getElementById('applyDateFilter').addEventListener('click', () => {
      setActiveDateBtn(null);
      render();
    });
    document.getElementById('clearDateFilter').addEventListener('click', () => {
      document.getElementById('dateFrom').value = defaultDate;
      document.getElementById('dateTo').value = defaultEndDate;
      setActiveDateBtn('btnThisQuarter');
      render();
    });

    // Quick date filters
    document.getElementById('btnToday').addEventListener('click', () => {
      document.getElementById('dateFrom').value = defaultDate;
      document.getElementById('dateTo').value = defaultDate;
      setActiveDateBtn('btnToday');
      render();
    });

    document.getElementById('btnThisWeek').addEventListener('click', () => {
      const today = new Date(defaultDate);
      const endOfWeek = new Date(today);
      endOfWeek.setDate(today.getDate() + (7 - today.getDay()));
      document.getElementById('dateFrom').value = defaultDate;
      document.getElementById('dateTo').value = endOfWeek.toISOString().split('T')[0];
      setActiveDateBtn('btnThisWeek');
      render();
    });

    document.getElementById('btnThisMonth').addEventListener('click', () => {
      const today = new Date(defaultDate);
      const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      document.getElementById('dateFrom').value = defaultDate;
      document.getElementById('dateTo').value = endOfMonth.toISOString().split('T')[0];
      setActiveDateBtn('btnThisMonth');
      render();
    });

    document.getElementById('btnThisQuarter').addEventListener('click', () => {
      document.getElementById('dateFrom').value = defaultDate;
      document.getElementById('dateTo').value = defaultEndDate;
      setActiveDateBtn('btnThisQuarter');
      render();
    });

    document.getElementById('btnThisYear').addEventListener('click', () => {
      const today = new Date(defaultDate);
      const endOfYear = new Date(today.getFullYear(), 11, 31);
      document.getElementById('dateFrom').value = defaultDate;
      document.getElementById('dateTo').value = endOfYear.toISOString().split('T')[0];
      setActiveDateBtn('btnThisYear');
      render();
    });

    // Initial render
    render();
  </script>
</body>
</html>`;

// Demo showcards page for experimenting with card designs
function getShowcardsDemo() {
  const cabaret = {
    id: 1,
    title: 'Cabaret',
    venue_name: 'Playhouse Theatre',
    venue_address: 'Northumberland Avenue, London WC2N 5DE',
    type: 'West End',
    start_date: '2024-11-01',
    end_date: '2025-04-30',
    description: 'Welcome to the Kit Kat Club. Experience the legendary musical in an intimate, immersive setting.',
    ticket_url: 'https://example.com/cabaret',
    price_from: 35.00,
    schedule: {
      mon: { m: null, e: '19:30' },
      tue: { m: null, e: '19:30' },
      wed: { m: '14:00', e: '19:30' },
      thu: { m: null, e: '19:30' },
      fri: { m: null, e: '19:30' },
      sat: { m: '14:00', e: '19:30' },
      sun: { m: null, e: null }
    },
    lottery_url: 'https://example.com/lottery',
    lottery_price: 25.00,
    rush_url: 'https://example.com/rush',
    rush_price: 29.50
  };

  function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatTime12(time24) {
    if (!time24) return null;
    const [h, m] = time24.split(':');
    const hour = parseInt(h);
    const suffix = hour >= 12 ? 'pm' : 'am';
    const hour12 = hour % 12 || 12;
    return hour12 + ':' + m + suffix;
  }

  function renderScheduleDots(schedule) {
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const labels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    if (!schedule) return '';
    let html = '<div class="schedule-grid-public">';
    days.forEach((d, i) => {
      const day = schedule[d] || { m: null, e: null };
      const mat = formatTime12(day.m);
      const eve = formatTime12(day.e);
      html += '<div class="day-col">';
      html += '<span class="day-label">' + labels[i] + '</span>';
      html += '<span class="show-time ' + (mat ? '' : 'empty') + '">' + (mat || '-') + '</span>';
      html += '<span class="show-time ' + (eve ? '' : 'empty') + '">' + (eve || '-') + '</span>';
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  function renderTicketBadges(m) {
    let badges = '';
    if (m.lottery_url) {
      badges += '<a href="' + escapeHtml(m.lottery_url) + '" target="_blank" class="ticket-badge lottery">🎲 £' + (m.lottery_price || 0).toFixed(0) + '</a>';
    }
    if (m.rush_url) {
      badges += '<a href="' + escapeHtml(m.rush_url) + '" target="_blank" class="ticket-badge rush">⚡ £' + (m.rush_price || 0).toFixed(0) + '</a>';
    }
    return badges ? '<div class="ticket-badges">' + badges + '</div>' : '';
  }

  function renderVenueIcons(venueName, venueAddress) {
    if (!venueAddress) return '';
    const query = encodeURIComponent(venueName + ' ' + venueAddress);
    return '<span class="venue-icons">' +
      '<a href="https://www.google.com/maps/search/?api=1&query=' + query + '" target="_blank" rel="noopener" class="venue-icon" title="View on map">📍</a>' +
      '<a href="https://www.google.com/maps/dir/?api=1&destination=' + query + '" target="_blank" rel="noopener" class="venue-icon" title="Get directions">🧭</a>' +
      '</span>';
  }

  function renderCard(m, variant = '') {
    const price = m.price_from ? 'From £' + m.price_from.toFixed(2) : '';
    const endDate = m.end_date
      ? 'Until ' + new Date(m.end_date).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'Open run';

    return '<div class="card ' + variant + '">' +
      renderTicketBadges(m) +
      '<div class="card-badge">' + escapeHtml(m.type) + '</div>' +
      '<h3 class="card-title">' + escapeHtml(m.title) + '</h3>' +
      '<p class="card-venue"><span>' + escapeHtml(m.venue_name) + '</span>' + renderVenueIcons(m.venue_name, m.venue_address) + '</p>' +
      (m.description ? '<p class="card-desc">' + escapeHtml(m.description) + '</p>' : '') +
      renderScheduleDots(m.schedule) +
      '<div class="card-meta">' +
      '<span class="card-date">' + endDate + '</span>' +
      (price ? '<span class="card-price">' + price + '</span>' : '') +
      '</div>' +
      (m.ticket_url ? '<a href="' + escapeHtml(m.ticket_url) + '" target="_blank" rel="noopener" class="card-btn">Get Tickets</a>' : '') +
      '</div>';
  }

  // Card D variant - badge-style venue icons and tickets button next to title
  function renderVenueIconsD(venueName, venueAddress) {
    if (!venueAddress) return '';
    const query = encodeURIComponent(venueName + ' ' + venueAddress);
    return '<span class="venue-icons-d">' +
      '<a href="https://www.google.com/maps/search/?api=1&query=' + query + '" target="_blank" rel="noopener" class="venue-badge" title="View on map">📍 Map</a>' +
      '<a href="https://www.google.com/maps/dir/?api=1&destination=' + query + '" target="_blank" rel="noopener" class="venue-badge" title="Get directions">🧭 Directions</a>' +
      '</span>';
  }

  function renderCardD(m) {
    const endDate = m.end_date
      ? 'Until ' + new Date(m.end_date).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'Open run';

    const ticketsBadge = m.ticket_url
      ? '<a href="' + escapeHtml(m.ticket_url) + '" target="_blank" rel="noopener" class="title-badge tickets">🎟️ Tickets</a>'
      : '';

    return '<div class="card variant-d">' +
      renderTicketBadges(m) +
      '<div class="card-badge">' + escapeHtml(m.type) + '</div>' +
      '<div class="title-row"><h3 class="card-title">' + escapeHtml(m.title) + '</h3>' + ticketsBadge + '</div>' +
      '<p class="card-venue-d"><span>' + escapeHtml(m.venue_name) + '</span>' + renderVenueIconsD(m.venue_name, m.venue_address) + '</p>' +
      renderScheduleDots(m.schedule) +
      '<div class="card-meta">' +
      '<span class="card-date">' + endDate + '</span>' +
      '</div>' +
      '</div>';
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Show Cards Demo - London Musicals</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      min-height: 100vh;
      color: #fff;
      padding: 40px 20px;
    }
    h1 {
      text-align: center;
      margin-bottom: 10px;
      font-size: 2rem;
      background: linear-gradient(90deg, #e94560, #f5af19);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .subtitle {
      text-align: center;
      color: #888;
      margin-bottom: 40px;
    }
    .cards-container {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 25px;
      max-width: 1400px;
      margin: 0 auto;
    }
    .card-wrapper {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .card-label {
      text-align: center;
      font-size: 0.85rem;
      color: #f5af19;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .card {
      background: rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 24px;
      transition: transform 0.3s, box-shadow 0.3s;
      border: 1px solid rgba(255, 255, 255, 0.1);
      position: relative;
    }
    .ticket-badges {
      position: absolute;
      top: 12px;
      right: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .ticket-badge {
      display: flex;
      align-items: center;
      gap: 4px;
      background: rgba(0, 0, 0, 0.6);
      padding: 4px 8px;
      border-radius: 8px;
      font-size: 0.75rem;
      font-weight: 600;
      text-decoration: none;
      color: #fff;
      transition: background 0.2s;
    }
    .ticket-badge:hover { background: rgba(0, 0, 0, 0.8); }
    .ticket-badge.lottery { border: 1px solid #a855f7; }
    .ticket-badge.rush { border: 1px solid #f59e0b; }
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
    .card-title { font-size: 1.3rem; font-weight: 700; margin-bottom: 8px; }
    .card-venue { color: #f5af19; font-size: 0.95rem; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .venue-icons { display: inline-flex; gap: 6px; }
    .venue-icon {
      font-size: 0.85rem;
      text-decoration: none;
      opacity: 0.7;
      transition: opacity 0.2s;
    }
    .venue-icon:hover { opacity: 1; }
    .card-desc { color: #aaa; font-size: 0.9rem; margin-bottom: 15px; line-height: 1.5; }
    .card-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
      font-size: 0.85rem;
      color: #999;
    }
    .card-price { color: #4ade80; font-weight: 600; }
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
    .card-btn:hover { opacity: 0.9; transform: scale(1.02); }
    .schedule-grid-public {
      display: flex;
      justify-content: center;
      gap: 6px;
      margin: 12px 0;
      padding: 10px;
      background: rgba(0,0,0,0.2);
      border-radius: 8px;
    }
    .day-col {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      min-width: 32px;
    }
    .day-label {
      font-size: 10px;
      color: #888;
      font-weight: 600;
    }
    .show-time {
      font-size: 9px;
      color: #4ade80;
      background: rgba(74, 222, 128, 0.1);
      padding: 2px 4px;
      border-radius: 3px;
    }
    .show-time.empty {
      color: #444;
      background: transparent;
    }
    .footer {
      text-align: center;
      margin-top: 50px;
      color: #666;
      font-size: 0.85rem;
    }
    .footer a { color: #e94560; text-decoration: none; }
    .footer a:hover { text-decoration: underline; }

    /* Card D specific styles */
    .variant-d .title-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    .variant-d .card-title {
      margin-bottom: 0;
    }
    .title-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(0, 0, 0, 0.6);
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 0.8rem;
      font-weight: 600;
      text-decoration: none;
      color: #fff;
      transition: background 0.2s;
      border: 1px solid #e94560;
    }
    .title-badge:hover {
      background: rgba(0, 0, 0, 0.8);
    }
    .card-venue-d {
      color: #f5af19;
      font-size: 0.95rem;
      margin-bottom: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .venue-icons-d {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .venue-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(0, 0, 0, 0.6);
      padding: 4px 8px;
      border-radius: 8px;
      font-size: 0.75rem;
      font-weight: 600;
      text-decoration: none;
      color: #fff;
      transition: background 0.2s;
      border: 1px solid #f5af19;
    }
    .venue-badge:hover {
      background: rgba(0, 0, 0, 0.8);
    }

    @media (max-width: 1200px) {
      .cards-container { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 700px) {
      .cards-container { grid-template-columns: 1fr; max-width: 400px; }
    }
  </style>
</head>
<body>
  <h1>Show Cards Demo</h1>
  <p class="subtitle">Experiment with different card designs using Cabaret data</p>

  <div class="cards-container">
    <div class="card-wrapper">
      <div class="card-label">Card A (Current)</div>
      ${renderCard(cabaret, 'variant-a')}
    </div>
    <div class="card-wrapper">
      <div class="card-label">Card B</div>
      ${renderCard(cabaret, 'variant-b')}
    </div>
    <div class="card-wrapper">
      <div class="card-label">Card C</div>
      ${renderCard(cabaret, 'variant-c')}
    </div>
    <div class="card-wrapper">
      <div class="card-label">Card D (New Style)</div>
      ${renderCardD(cabaret)}
    </div>
  </div>

  <div class="footer">
    <a href="/">← Back to Main Page</a>
  </div>
</body>
</html>`;
}
