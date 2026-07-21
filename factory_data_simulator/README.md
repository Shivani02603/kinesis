# Factory Data Simulator

A **standalone** stand-in for a factory's real sensor database / historian. It is a
separate service from Kinesis — Kinesis connects to it over HTTP and pulls new
readings (a real delta), exactly like it would with a real ERP or historian.

## Run it

```
cd factory_data_simulator
pip install -r requirements.txt
uvicorn app:app --port 9000
```

Open `http://localhost:9000` for a small control panel:
- **Generate new data** — advances the factory clock and appends new readings to
  every table, continuing each signal's own real pattern.
- **Degrade a signal** — switches a machine's signal to a slow upward drift, so
  after a few "generate" clicks it climbs out of its normal range. This is what
  lets you show Kinesis re-training and *catching* a machine going bad.
- **Reset to fixtures** — wipes back to the original seed data.

## How it seeds

On first start it reads the same fixture tables Kinesis uses
(`../data/steel_heat_treatment_small/sensor_readings.csv` and
`inspection_readings.csv`), treats them as "history so far", and computes each
signal's baseline mean/std from that history. New data continues from there — it
is grounded in the real pattern, never random.

Override the seed location with `SEED_DIR=/path/to/tables`.

## API (what Kinesis calls)

- `GET /tables` — tables served, each with its key column and signal columns.
- `GET /data/{table}?since=<timestamp>` — rows newer than `since` (the delta).
- `POST /advance {hours}` — generate more data.
- `POST /degrade {signal, on}` — toggle drift for a signal.
- `POST /reseed` — reset to fixtures.
- `GET /status` — sim clock + degrade state.

State lives in `sim.db` (SQLite), created next to `app.py`. Delete it to reset.
