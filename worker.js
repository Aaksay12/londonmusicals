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

      const result = await env.DB.prepare(`
        INSERT INTO musicals (title, venue_name, venue_address, type, start_date, end_date, description, ticket_url, price_from)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        data.title,
        data.venue_name,
        data.venue_address || null,
        data.type,
        data.start_date,
        data.end_date || null,
        data.description || null,
        data.ticket_url || null,
        data.price_from || null
      ).run();

      const newMusical = await env.DB.prepare('SELECT * FROM musicals WHERE id = ?')
        .bind(result.meta.last_row_id).first();

      return new Response(JSON.stringify(newMusical), { status: 201, headers });
    }

    // PUT /admin/api/musicals/:id - Update musical
    if (url.pathname.match(/^\/admin\/api\/musicals\/\d+$/) && request.method === 'PUT') {
      const id = url.pathname.split('/')[4];
      const data = await request.json();

      await env.DB.prepare(`
        UPDATE musicals SET
          title = ?, venue_name = ?, venue_address = ?, type = ?,
          start_date = ?, end_date = ?, description = ?,
          ticket_url = ?, price_from = ?, updated_at = CURRENT_TIMESTAMP
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
  const today = new Date().toISOString().split('T')[0];

  // Fetch ALL musicals for client-side date filtering
  const { results: allMusicals } = await env.DB.prepare(`
    SELECT * FROM musicals ORDER BY type, title
  `).all();

  return HTML_TEMPLATE
    .replaceAll('{{MUSICALS_DATA}}', JSON.stringify(allMusicals))
    .replaceAll('{{TODAY_DATE}}', today)
    .replaceAll('{{TODAY}}', new Date().toLocaleDateString('en-GB', {
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
            <label for="start_date">Start Date *</label>
            <input type="date" id="start_date" required>
          </div>
          <div class="form-group">
            <label for="end_date">End Date <small style="color:#888">(leave empty for Open Run)</small></label>
            <input type="date" id="end_date">
          </div>
          <div class="form-group">
            <label for="price_from">Price From (£)</label>
            <input type="number" id="price_from" step="0.01" min="0">
          </div>
          <div class="form-group">
            <label for="ticket_url">Ticket URL</label>
            <input type="url" id="ticket_url">
          </div>
          <div class="form-group full">
            <label for="description">Description</label>
            <textarea id="description"></textarea>
          </div>
        </div>
        <div class="btn-row">
          <button type="submit" class="btn btn-primary" id="submitBtn">Add Musical</button>
          <button type="button" class="btn btn-secondary" onclick="resetForm()">Cancel</button>
        </div>
      </form>
    </div>

    <div class="table-section">
      <div class="table-header">
        <h2>All Musicals (<span id="totalCount">0</span>)</h2>
        <input type="text" class="search-box" placeholder="Search..." id="searchBox">
      </div>
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Type</th>
            <th>Venue</th>
            <th>Dates</th>
            <th>Status</th>
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

    function render(filter = '') {
      const filtered = musicals.filter(m =>
        m.title.toLowerCase().includes(filter.toLowerCase()) ||
        m.venue_name.toLowerCase().includes(filter.toLowerCase())
      );

      document.getElementById('totalCount').textContent = musicals.length;
      document.getElementById('tableBody').innerHTML = filtered.map(m => {
        const isActive = m.start_date <= today && (!m.end_date || m.end_date >= today);
        const typeClass = m.type.toLowerCase().replace(/ /g, '-');
        const dates = m.end_date ? \`\${m.start_date} → \${m.end_date}\` : \`\${m.start_date} → Open Run\`;

        return \`
          <tr>
            <td><strong>\${escapeHtml(m.title)}</strong></td>
            <td><span class="badge badge-\${typeClass}">\${m.type}</span></td>
            <td>\${escapeHtml(m.venue_name)}</td>
            <td>\${dates}</td>
            <td><span class="badge \${isActive ? 'badge-active' : 'badge-ended'}">\${isActive ? 'Active' : 'Ended'}</span></td>
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

    function resetForm() {
      document.getElementById('musicalForm').reset();
      document.getElementById('editId').value = '';
      document.getElementById('formTitle').textContent = 'Add New Musical';
      document.getElementById('submitBtn').textContent = 'Add Musical';
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
      document.getElementById('description').value = m.description || '';

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

    document.getElementById('musicalForm').addEventListener('submit', async (e) => {
      e.preventDefault();

      const editId = document.getElementById('editId').value;
      const data = {
        title: document.getElementById('title').value,
        type: document.getElementById('type').value,
        venue_name: document.getElementById('venue_name').value,
        venue_address: document.getElementById('venue_address').value || null,
        start_date: document.getElementById('start_date').value,
        end_date: document.getElementById('end_date').value || null,
        price_from: document.getElementById('price_from').value ? parseFloat(document.getElementById('price_from').value) : null,
        ticket_url: document.getElementById('ticket_url').value || null,
        description: document.getElementById('description').value || null,
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
    .card-title { font-size: 1.3rem; font-weight: 700; margin-bottom: 8px; }
    .card-venue { color: #f5af19; font-size: 0.95rem; margin-bottom: 10px; }
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
  </div>

  <div class="date-filter">
    <div class="date-filter-inner">
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
    let typeFilter = 'all';

    function isShowActive(show, fromDate, toDate) {
      const start = show.start_date;
      const end = show.end_date || '9999-12-31';
      return start <= toDate && end >= fromDate;
    }

    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function renderCard(m) {
      const endDate = m.end_date
        ? new Date(m.end_date).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'Open run';
      const price = m.price_from ? 'From £' + m.price_from.toFixed(2) : '';

      return '<div class="card">' +
        '<div class="card-badge">' + escapeHtml(m.type) + '</div>' +
        '<h3 class="card-title">' + escapeHtml(m.title) + '</h3>' +
        '<p class="card-venue">' + escapeHtml(m.venue_name) + '</p>' +
        (m.description ? '<p class="card-desc">' + escapeHtml(m.description) + '</p>' : '') +
        '<div class="card-meta">' +
        '<span class="card-date">Until ' + endDate + '</span>' +
        (price ? '<span class="card-price">' + price + '</span>' : '') +
        '</div>' +
        (m.ticket_url ? '<a href="' + escapeHtml(m.ticket_url) + '" target="_blank" rel="noopener" class="card-btn">Get Tickets</a>' : '') +
        '</div>';
    }

    function render() {
      const fromDate = document.getElementById('dateFrom').value || defaultDate;
      const toDate = document.getElementById('dateTo').value || defaultDate;

      const filtered = allMusicals.filter(m => isShowActive(m, fromDate, toDate));

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
        if (typeFilter === 'all') {
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

    // Date filter
    document.getElementById('applyDateFilter').addEventListener('click', render);
    document.getElementById('clearDateFilter').addEventListener('click', () => {
      document.getElementById('dateFrom').value = '';
      document.getElementById('dateTo').value = '';
      render();
    });

    // Initial render
    render();
  </script>
</body>
</html>`;
