"""Factory data simulator — HTTP surface.

Run standalone:  uvicorn app:app --port 9000   (from inside factory_data_simulator/)

This is deliberately a SEPARATE service from Kinesis: it plays the role of the
factory's own sensor database. Kinesis connects to it over these endpoints and
pulls deltas — it does not share a process or a database with Kinesis.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

import simulator


@asynccontextmanager
async def lifespan(app: FastAPI):
    simulator.init_db()
    if not simulator.seeded():
        simulator.seed_from_fixtures()
    yield


app = FastAPI(title="Factory Data Simulator", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


@app.get("/tables")
def tables():
    return simulator.list_tables()


@app.get("/data/{table}")
def data(table: str, since: str | None = None):
    """The delta pull: rows newer than `since`. Kinesis calls this with the last
    timestamp it already has for that table, so it only ever gets new rows."""
    return {"table": table, "since": since, "rows": simulator.get_rows(table, since)}


class AdvanceBody(BaseModel):
    hours: int = 24


@app.post("/advance")
def advance(body: AdvanceBody):
    generated = simulator.advance(max(1, body.hours))
    return {"advanced_hours": body.hours, "generated_rows": generated, "status": simulator.status()}


class DegradeBody(BaseModel):
    signal: str
    on: bool = True


@app.post("/degrade")
def degrade(body: DegradeBody):
    ok = simulator.set_degrade(body.signal, body.on)
    return {"signal": body.signal, "degrade": body.on, "applied": ok, "status": simulator.status()}


@app.post("/reseed")
def reseed():
    """Wipe and re-seed from the real fixtures — resets the whole simulation."""
    import os

    if simulator.SIM_DB.exists():
        os.remove(simulator.SIM_DB)
    simulator.init_db()
    simulator.seed_from_fixtures()
    return {"reseeded": True, "status": simulator.status()}


@app.get("/status")
def status():
    return simulator.status()


@app.get("/", response_class=HTMLResponse)
def control_panel():
    st = simulator.status()
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
    <html><head><title>Factory Data Simulator</title>
    <style>
      body {{ font-family: Inter, system-ui, sans-serif; max-width: 720px; margin: 2rem auto; color:#0b1c30; }}
      h1 {{ font-size: 1.3rem; }} table {{ border-collapse: collapse; width: 100%; margin-top:.5rem; }}
      td, th {{ text-align:left; padding:.5rem .6rem; border-bottom:1px solid #d3e4fe; font-size:.9rem; }}
      button {{ padding:.35rem .7rem; border:1px solid #0f52ba; background:#0f52ba; color:#fff; border-radius:6px; cursor:pointer; font-size:.85rem; }}
      button.sec {{ background:#fff; color:#0f52ba; }}
      .bar {{ display:flex; gap:.5rem; align-items:center; margin:1rem 0; }}
      input {{ width:70px; padding:.35rem; border:1px solid #d3e4fe; border-radius:6px; }}
    </style></head>
    <body>
      <h1>🏭 Factory Data Simulator</h1>
      <p>This stands in for the plant's real sensor database. Kinesis connects here and pulls new readings.</p>
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
        async function advance() {{
          const hours = Number(document.getElementById('hrs').value) || 24;
          await fetch('/advance', {{method:'POST', headers:{{'Content-Type':'application/json'}}, body: JSON.stringify({{hours}})}});
          location.reload();
        }}
        async function degrade(signal, on) {{
          await fetch('/degrade', {{method:'POST', headers:{{'Content-Type':'application/json'}}, body: JSON.stringify({{signal, on}})}});
          location.reload();
        }}
        async function reseed() {{
          if (!confirm('Reset the simulation back to the original fixtures?')) return;
          await fetch('/reseed', {{method:'POST'}}); location.reload();
        }}
      </script>
    </body></html>
    """
