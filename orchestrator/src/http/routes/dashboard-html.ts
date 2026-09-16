/**
 * The admin dashboard page itself (GET /v1/admin/dashboard, 2026-09-16).
 * Deliberately a single inline template string, no build step / no new
 * frontend toolchain — matches this repo's no-static-assets convention.
 * Token is prompted once and cached in localStorage (internal operator
 * tool, not a customer surface); every subsequent fetch() sends it as a
 * Bearer header.
 */
export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>QM Orchestrator — Admin</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0e1117; color: #e6e6e6; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8a8f98; font-size: 12px; margin-bottom: 20px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #262c36; border-radius: 8px; padding: 14px; }
  .card .n { font-size: 24px; font-weight: 600; }
  .card .l { font-size: 11px; color: #8a8f98; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 2px; }
  .card.bad .n { color: #f87171; }
  .card.ok .n { color: #4ade80; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 28px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #262c36; }
  th { color: #8a8f98; font-weight: 500; font-size: 11px; text-transform: uppercase; }
  section h2 { font-size: 14px; margin: 0 0 10px; }
  button { background: #2f81f7; color: #fff; border: none; border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
  button:disabled { background: #3a3f4a; cursor: default; }
  .note { color: #8a8f98; font-size: 11px; margin-top: -14px; margin-bottom: 20px; }
  #err { color: #f87171; font-size: 13px; margin-bottom: 12px; display: none; }
  #gate { position: fixed; inset: 0; background: #0e1117; display: flex; align-items: center; justify-content: center; }
  #gate input { background: #161b22; border: 1px solid #262c36; color: #e6e6e6; padding: 8px; border-radius: 6px; width: 320px; }
  .status-tag { padding: 2px 6px; border-radius: 4px; font-size: 11px; }
  .status-failed { background: #3b1d1d; color: #f87171; }
  .status-partial { background: #3b2e1d; color: #fbbf24; }
</style>
</head>
<body>
<div id="gate">
  <div>
    <div style="margin-bottom:8px;font-size:13px;">Admin token</div>
    <input id="tokenInput" type="password" placeholder="Bearer token" />
    <button id="tokenGo">Enter</button>
  </div>
</div>

<div id="app" style="display:none;">
  <h1>QM Orchestrator — Admin</h1>
  <div class="sub">Live stats from jobs / projects / job_costs / request_outbox.</div>
  <div id="err"></div>

  <div class="cards" id="cards"></div>

  <section>
    <h2>Cost per project (top 100)</h2>
    <table id="costTable"><thead><tr><th>Project</th><th>Cost (USD)</th></tr></thead><tbody></tbody></table>
  </section>

  <section>
    <h2>Failed / partial projects</h2>
    <table id="failedTable"><thead><tr><th>Project</th><th>Status</th><th>Tier</th><th>Failed jobs</th><th>Finished</th><th></th></tr></thead><tbody></tbody></table>
  </section>
</div>

<script>
(function () {
  var TOKEN_KEY = 'qm_admin_token';
  var token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) {}

  function showApp() {
    document.getElementById('gate').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    load();
  }

  if (token) {
    showApp();
  } else {
    document.getElementById('tokenGo').addEventListener('click', function () {
      var v = document.getElementById('tokenInput').value.trim();
      if (!v) return;
      try { localStorage.setItem(TOKEN_KEY, v); } catch (e) {}
      token = v;
      showApp();
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function card(n, l, cls) {
    return '<div class="card' + (cls ? ' ' + cls : '') + '"><div class="n">' + n + '</div><div class="l">' + esc(l) + '</div></div>';
  }

  function fmtDate(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleString(); } catch (e) { return String(d); }
  }

  function setErr(msg) {
    var el = document.getElementById('err');
    if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = 'block';
    el.textContent = msg;
  }

  function authFetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + token });
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) {
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        location.reload();
        throw new Error('unauthorized');
      }
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : 'request failed (' + res.status + ')');
        return body;
      });
    });
  }

  function render(data) {
    var assets = data.assets, projects = data.projects, cost = data.cost, failed = data.failedProjects;

    var cardsHtml = '';
    cardsHtml += card(assets.generated, 'Assets generated', 'ok');
    cardsHtml += card(assets.queued, 'Assets in queue');
    cardsHtml += card(assets.failed, 'Assets failed', assets.failed > 0 ? 'bad' : '');
    cardsHtml += card((projects.byStatus.completed || 0), 'Projects completed', 'ok');
    cardsHtml += card((projects.byStatus.planning || 0) + (projects.byStatus.running || 0) + projects.outboxQueued, 'Projects in queue');
    cardsHtml += card((projects.byStatus.failed || 0) + (projects.byStatus.partial || 0), 'Projects failed', ((projects.byStatus.failed || 0) + (projects.byStatus.partial || 0)) > 0 ? 'bad' : '');
    cardsHtml += card('$' + cost.totalUsd.toFixed(2), 'Total cost');
    document.getElementById('cards').innerHTML = cardsHtml;

    var costRows = cost.byProject.map(function (p) {
      return '<tr><td>' + esc(p.projectId) + '</td><td>$' + p.costUsd.toFixed(4) + '</td></tr>';
    }).join('');
    document.querySelector('#costTable tbody').innerHTML = costRows || '<tr><td colspan="2">No cost data yet.</td></tr>';

    var failedRows = failed.map(function (p) {
      return '<tr data-id="' + esc(p.id) + '">' +
        '<td>' + esc(p.id) + '</td>' +
        '<td><span class="status-tag status-' + esc(p.status) + '">' + esc(p.status) + '</span></td>' +
        '<td>' + esc(p.tier) + '</td>' +
        '<td>' + p.failedJobs + '</td>' +
        '<td>' + fmtDate(p.finishedAt) + '</td>' +
        '<td><button class="reworkBtn">Rework</button></td>' +
        '</tr>';
    }).join('');
    document.querySelector('#failedTable tbody').innerHTML = failedRows || '<tr><td colspan="6">No failed/partial projects.</td></tr>';

    Array.prototype.forEach.call(document.querySelectorAll('.reworkBtn'), function (btn) {
      btn.addEventListener('click', function () {
        var row = btn.closest('tr');
        var id = row.getAttribute('data-id');
        btn.disabled = true;
        btn.textContent = 'Submitting…';
        authFetch('/v1/admin/projects/' + encodeURIComponent(id) + '/rework', { method: 'POST' })
          .then(function (res) {
            btn.textContent = 'Rework running (' + res.repairId + ')';
            setErr(null);
          })
          .catch(function (e) {
            btn.disabled = false;
            btn.textContent = 'Rework';
            setErr('Rework failed for ' + id + ': ' + e.message);
          });
      });
    });
  }

  function load() {
    authFetch('/v1/admin/dashboard/stats')
      .then(function (data) { setErr(null); render(data); })
      .catch(function (e) { setErr(e.message); });
  }

  setInterval(function () { if (token) load(); }, 15000);
})();
</script>
</body>
</html>
`;
