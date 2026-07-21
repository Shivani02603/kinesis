# Factory Data Simulator

A **standalone** stand-in for a factory's real sensor database / historian. It is a
separate service from Kinesis — Kinesis connects to it over HTTP and pulls new
readings (a real delta), exactly like it would with a real ERP or historian.

**Multi-tenant**: one running process serves every industry at once — the industry
is part of the URL, not fixed at startup. One deploy covers every company's demo.

## Run it

```
cd factory_data_simulator
pip install -r requirements.txt
uvicorn app:app --port 9000
```

Open `http://localhost:9000` — it lists every industry it can stand in for (every
subfolder under `../data/simulator_data/`), each linking to its own control panel
at `http://localhost:9000/<industry>`:
- **Generate new data** — advances that industry's factory clock and appends new
  readings to every table, continuing each signal's own real pattern.
- **Degrade a signal** — switches a machine's signal to a slow upward drift, so
  after a few "generate" clicks it climbs out of its normal range. This is what
  lets you show Kinesis re-training and *catching* a machine going bad.
- **Reset to fixtures** — wipes that industry's simulation back to the original
  seed data (other industries are untouched).

## How it seeds

The first time an industry is touched (a request to `/steel/...`, say), it
auto-discovers every **time-series** table in that industry's folder under
`data/simulator_data/<industry>/` — any CSV whose first column is a date/time and
whose other columns are all numeric (sensor readings, inspection rates, material
consumption, sales). It treats those rows as "history so far" and computes each
signal's baseline mean/std, so new data continues the real pattern, never random.
Non-time-series files (machine lists, routings, orders) are ignored.

Nothing is steel-specific — drop any industry's folder under
`data/simulator_data/` and it's servable immediately, no restart, no code change.
Each industry gets its own SQLite file (`sim_<industry>.db`) so their generated
data never mixes.

## API (what Kinesis calls)

Every endpoint is namespaced by industry. A company's "data source base URL" in
Kinesis is simply `http://<host>:9000/<industry>` — the connector already treats
the base URL as an opaque prefix, so nothing on the Kinesis side changes.

- `GET /industries` — every industry this instance can serve.
- `GET /{industry}/tables` — tables served, each with its key column and signal columns.
- `GET /{industry}/data/{table}?since=<timestamp>` — rows newer than `since` (the delta).
- `POST /{industry}/advance {hours}` — generate more data for that industry.
- `POST /{industry}/degrade {signal, on}` — toggle drift for a signal.
- `POST /{industry}/reseed` — reset that industry to its fixtures.
- `GET /{industry}/status` — that industry's sim clock + degrade state.

State lives in `sim_<industry>.db` (SQLite per industry), created next to `app.py`.
Delete one to reset that industry only.
