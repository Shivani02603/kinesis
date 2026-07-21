"""Factory data simulator — HTTP surface.

Run standalone:  uvicorn app:app --port 9000   (from inside factory_data_simulator/)

This is deliberately a SEPARATE service from Kinesis: it plays the role of the
factory's own sensor database. Kinesis connects to it over these endpoints and
pulls deltas — it does not share a process or a database with Kinesis.

Multi-tenant: one process stands in for every industry's factory. The industry
is part of the URL (`/steel/tables`, `/textile/tables`, ...), never fixed at
startup, so a company's "data source base URL" is simply
`http://<host>:9000/<industry>` — the same connector code that already appends
`/tables`, `/data/{table}`, `/status` to a base URL needs no changes.
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

import simulator

app = FastAPI(title="Factory Data Simulator")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


def _industry_or_404(industry: str) -> None:
    try:
        simulator.ensure_seeded(industry)
    except simulator.UnknownIndustry as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/industries")
def industries():
    return {"industries": simulator.list_industries()}


@app.get("/{industry}/tables")
def tables(industry: str):
    _industry_or_404(industry)
    return simulator.list_tables(industry)


@app.get("/{industry}/data/{table}")
def data(industry: str, table: str, since: str | None = None):
    """The delta pull: rows newer than `since`. Kinesis calls this with the last
    timestamp it already has for that table, so it only ever gets new rows."""
    _industry_or_404(industry)
    return {"table": table, "since": since, "rows": simulator.get_rows(industry, table, since)}


class AdvanceBody(BaseModel):
    hours: int = 24


@app.post("/{industry}/advance")
def advance(industry: str, body: AdvanceBody):
    _industry_or_404(industry)
    generated = simulator.advance(industry, max(1, body.hours))
    return {"advanced_hours": body.hours, "generated_rows": generated, "status": simulator.status(industry)}


class DegradeBody(BaseModel):
    signal: str
    on: bool = True


@app.post("/{industry}/degrade")
def degrade(industry: str, body: DegradeBody):
    _industry_or_404(industry)
    ok = simulator.set_degrade(industry, body.signal, body.on)
    return {"signal": body.signal, "degrade": body.on, "applied": ok, "status": simulator.status(industry)}


@app.post("/{industry}/reseed")
def reseed(industry: str):
    """Wipe and re-seed this industry from its real fixtures — resets its simulation only."""
    _industry_or_404(industry)
    simulator.reseed(industry)
    return {"reseeded": True, "status": simulator.status(industry)}


@app.get("/{industry}/status")
def status(industry: str):
    _industry_or_404(industry)
    return simulator.status(industry)


@app.get("/", response_class=HTMLResponse)
def home():
    inds = simulator.list_industries()
    links = "".join(f'<li><a href="/{i}">{i}</a></li>' for i in inds)
    return f"""
    <html><head><title>Factory Data Simulator</title>
    <style>
      body {{ font-family: Inter, system-ui, sans-serif; max-width: 720px; margin: 2rem auto; color:#0b1c30; }}
      a {{ color:#0f52ba; }}
    </style></head>
    <body>
      <h1>🏭 Factory Data Simulator</h1>
      <p>One instance, every industry. Pick one to open its control panel, or point a
      company's data-source URL at <code>http://&lt;host&gt;/&lt;industry&gt;</code> directly.</p>
      <ul>{links}</ul>
    </body></html>
    """


@app.get("/{industry}", response_class=HTMLResponse)
def control_panel(industry: str):
    _industry_or_404(industry)
    st = simulator.status(industry)
    signal_rows = "".join(
        f"<tr><td>{s['signal']}</td><td>{s['table']}</td>"
        f"<td><button onclick=\"degrade('{s['signal']}', {str(not s['degrade']).lower()})\">"
        f"{'Stop degrading' if s['degrade'] else 'Degrade this'}</button> "
        f"<b style='color:{'#ba1a1a' if s['degrade'] else '#8891a0'}'>"
        f"{'DEGRADING' if s['degrade'] else 'normal'}</b></td></tr>"
        for s in st["signals"]
    )
    table_rows = "".join(f"<li>{t['table']} — latest: <b>{t['latest']}</b></li>" for t in st["tables"])
    return f"""
    <html><head><title>Factory Data Simulator — {industry}</title>
    <style>
      body {{ font-family: Inter, system-ui, sans-serif; max-width: 720px; margin: 2rem auto; color:#0b1c30; }}
      h1 {{ font-size: 1.3rem; }} table {{ border-collapse: collapse; width: 100%; margin-top:.5rem; }}
      td, th {{ text-align:left; padding:.5rem .6rem; border-bottom:1px solid #d3e4fe; font-size:.9rem; }}
      button {{ padding:.35rem .7rem; border:1px solid #0f52ba; background:#0f52ba; color:#fff; border-radius:6px; cursor:pointer; font-size:.85rem; }}
      button.sec {{ background:#fff; color:#0f52ba; }}
      .bar {{ display:flex; gap:.5rem; align-items:center; margin:1rem 0; }}
      input {{ width:70px; padding:.35rem; border:1px solid #d3e4fe; border-radius:6px; }}
      a.back {{ color:#0f52ba; font-size:.85rem; }}
    </style></head>
    <body>
      <a class="back" href="/">&larr; all industries</a>
      <h1>🏭 Factory Data Simulator — {industry}</h1>
      <p>This stands in for {industry}'s real sensor database. Kinesis connects to
      <code>/{industry}/...</code> and pulls new readings.</p>
      <h3>Tables (latest generated point)</h3>
      <ul>{table_rows}</ul>
      <div class="bar">
        Advance the factory clock by <input id="hrs" type="number" value="48"/> hours
        <button onclick="advance()">Generate new data</button>
        <button class="sec" onclick="reseed()">Reset to fixtures</button>
      </div>
      <h3>Signals — flip one to "degrade" then generate, to show a machine drifting out of normal</h3>
      <table><tr><th>Signal</th><th>Table</th><th>Degrade</th></tr>{signal_rows}</table>
      <script>
        const industry = {industry!r};
        async function advance() {{
          const hours = Number(document.getElementById('hrs').value) || 24;
          await fetch(`/${{industry}}/advance`, {{method:'POST', headers:{{'Content-Type':'application/json'}}, body: JSON.stringify({{hours}})}});
          location.reload();
        }}
        async function degrade(signal, on) {{
          await fetch(`/${{industry}}/degrade`, {{method:'POST', headers:{{'Content-Type':'application/json'}}, body: JSON.stringify({{signal, on}})}});
          location.reload();
        }}
        async function reseed() {{
          if (!confirm('Reset this industry back to the original fixtures?')) return;
          await fetch(`/${{industry}}/reseed`, {{method:'POST'}}); location.reload();
        }}
      </script>
    </body></html>
    """
