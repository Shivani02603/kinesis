"""Generate synthetic, industry-wise test datasets for Kinesis.

Every file here is synthetic test data (like the original steel fixture was) —
never a real factory's data. This script is the single source of it, so datasets
are reproducible and adding a new industry is just a new entry in INDUSTRIES.

For each industry it writes the same 10-file shape Kinesis understands, into:
    data/small_data/<industry>/   ~10 days of hourly sensor history (quick tests)
    data/big_data/<industry>/     ~90 days (stress-tests parse + training)
and copies the time-series tables the simulator continues into:
    data/simulator_data/<industry>/

Run:  python data/generate_datasets.py
"""

import csv
import random
from datetime import date, datetime, timedelta
from pathlib import Path

DATA = Path(__file__).parent
END = datetime(2026, 7, 20, 23, 0)  # data ends here; open orders are due after it

# (asset_id, name, description, vib_tag_prefix, units_per_hour)
INDUSTRIES = {
    "steel": {
        "machines": [
            ("AST-01", "Furnace FCE-3", "Continuous furnace performing austenitizing heat treatment", "FCE3", 60),
            ("AST-02", "Cooling Conveyor CC-1", "Controlled ambient cooling conveyor after heat treatment", "CC1", 120),
            ("AST-03", "Inspection Station IS-2", "Rockwell hardness and surface defect inspection", "IS2", 90),
            ("AST-04", "Packaging Line PKG-4", "Coating, strapping and palletizing line", "PKG4", 150),
        ],
        "quality": ("HARDNESS_REJECT_RATE", "Percent of batches rejected for out-of-spec Rockwell hardness", "%", 1.8, 0.3),
        "vib_baseline": (1.2, 0.15),
        "materials": ["STEEL_BILLET_CONSUMED", "QUENCH_OIL_CONSUMED", "PROTECTIVE_COATING_CONSUMED", "PACKAGING_STRAP_CONSUMED"],
        "products": ["HARDENED_ROD_SHIPPED", "TEMPERED_PLATE_SHIPPED", "ANNEALED_COIL_SHIPPED", "CASE_HARDENED_GEAR_SHIPPED"],
        "sop": (
            "Raw steel billets and coil stock are received and staged at the yard. Stock is charged into FCE-3, the "
            "continuous furnace, for austenitizing heat treatment. Treated stock proceeds to the cooling conveyor for "
            "controlled ambient cooling. Cooled stock is inspected for Rockwell hardness and surface defects before "
            "packaging. Conforming stock is logged and staged for the packaging line, where a protective coating and "
            "strapping are applied before palletizing. Rejected stock is routed to the temper-and-retest area. The "
            "line's active objective is maintaining hardness within the active work order specification."
        ),
    },
    "textile": {
        "machines": [
            ("AST-01", "Blowroom BR-1", "Opens and cleans raw cotton bales into a uniform lap", "BR1", 200),
            ("AST-02", "Carding Machine CD-3", "Individualises fibres and forms a carded sliver", "CD3", 80),
            ("AST-03", "Ring Frame RF-5", "Draws and twists roving into spun yarn", "RF5", 40),
            ("AST-04", "Autoconer AC-2", "Winds spun yarn onto cones and clears defects", "AC2", 120),
            ("AST-05", "Loom LM-7", "Weaves yarn into grey fabric", "LM7", 30),
        ],
        "quality": ("YARN_DEFECT_RATE", "Percent of yarn length flagged for thick/thin place defects", "%", 2.5, 0.5),
        "vib_baseline": (1.1, 0.13),
        "materials": ["COTTON_BALE_CONSUMED", "DYE_CONSUMED", "SIZING_CHEMICAL_CONSUMED", "PACKAGING_CONE_CONSUMED"],
        "products": ["COMBED_YARN_SHIPPED", "GREY_FABRIC_SHIPPED", "DYED_FABRIC_SHIPPED", "KNITTED_FABRIC_SHIPPED"],
        "sop": (
            "Raw cotton bales are received and opened in the blowroom into a cleaned lap. The lap is carded to form a "
            "sliver, which is drawn and twisted into yarn on the ring frame. Spun yarn is wound and cleared of defects "
            "on the autoconer. Cleared yarn is woven into grey fabric on the looms, inspected for defect rate, and "
            "staged for dyeing and packaging. The line's active objective is keeping the yarn defect rate within spec."
        ),
    },
    "pharma": {
        "machines": [
            ("AST-01", "Granulator GR-2", "Wet granulation of API and excipient blend", "GR2", 50),
            ("AST-02", "Fluid Bed Dryer FBD-1", "Dries granules to target moisture", "FBD1", 60),
            ("AST-03", "Tablet Press TP-4", "Compresses granules into tablets", "TP4", 300),
            ("AST-04", "Coating Machine CT-3", "Applies film coating to tablets", "CT3", 250),
            ("AST-05", "Blister Line BL-6", "Seals tablets into blister packs", "BL6", 400),
        ],
        "quality": ("TABLET_REJECT_RATE", "Percent of tablets rejected for weight or hardness deviation", "%", 1.2, 0.25),
        "vib_baseline": (0.9, 0.1),
        "materials": ["API_CONSUMED", "EXCIPIENT_CONSUMED", "COATING_SOLUTION_CONSUMED", "BLISTER_FOIL_CONSUMED"],
        "products": ["TABLET_BATCH_SHIPPED", "CAPSULE_BATCH_SHIPPED", "SYRUP_BATCH_SHIPPED", "OINTMENT_BATCH_SHIPPED"],
        "sop": (
            "Dispensed API and excipients are wet-granulated, then dried in the fluid bed dryer to target moisture. "
            "Dried granules are compressed into tablets on the press and film-coated. Coated tablets are inspected for "
            "weight and hardness deviation before being sealed into blister packs. Out-of-spec tablets are quarantined. "
            "The line's active objective is keeping the tablet reject rate within the batch specification."
        ),
    },
    "food": {
        "machines": [
            ("AST-01", "Dough Mixer DM-1", "Mixes flour, sugar, oil and water into dough", "DM1", 150),
            ("AST-02", "Sheeter SH-2", "Rolls and cuts dough into biscuit shapes", "SH2", 140),
            ("AST-03", "Baking Oven OV-5", "Bakes shaped dough at controlled temperature", "OV5", 120),
            ("AST-04", "Cooling Tunnel CT-2", "Cools baked biscuits before packing", "CT2", 130),
            ("AST-05", "Packaging Line PK-3", "Wraps and cartons finished biscuits", "PK3", 200),
        ],
        "quality": ("MOISTURE_OUT_OF_SPEC_RATE", "Percent of batches rejected for out-of-spec moisture", "%", 2.0, 0.4),
        "vib_baseline": (1.0, 0.13),
        "materials": ["FLOUR_CONSUMED", "SUGAR_CONSUMED", "EDIBLE_OIL_CONSUMED", "PACKAGING_FILM_CONSUMED"],
        "products": ["BISCUIT_CARTON_SHIPPED", "WAFER_CARTON_SHIPPED", "COOKIE_CARTON_SHIPPED", "CRACKER_CARTON_SHIPPED"],
        "sop": (
            "Flour, sugar and edible oil are mixed into dough, sheeted and cut to shape, then baked in the oven. Baked "
            "biscuits pass through the cooling tunnel before packaging. Batches are checked for out-of-spec moisture "
            "before wrapping and cartoning; out-of-spec batches are held. The line's active objective is keeping the "
            "moisture out-of-spec rate within the product specification."
        ),
    },
}

REGIONS = ["east", "west", "north", "south"]


def _walk(mean, std, n, drift=0.0):
    """A bounded random walk around a baseline — realistic sensor-style noise."""
    vals, last = [], mean
    for _ in range(n):
        last = max(0.0, last + 0.3 * (mean - last) + random.gauss(0, std * 0.5) + drift)
        vals.append(round(last, 2))
    return vals


def _write(path: Path, header, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def generate(industry: str, spec: dict, out: Path, sensor_days: int, daily_days: int, n_history: int, n_open: int):
    rng_machines = spec["machines"]

    # --- static structure files ---
    _write(out / "machine_list.csv", ["asset_id", "name", "description"],
           [(m[0], m[1], m[2]) for m in rng_machines])
    _write(out / "routing.csv", ["sequence", "machine", "units_per_hour"],
           [(i + 1, m[1], m[4]) for i, m in enumerate(rng_machines)])

    vib_tags = [(f"{m[3]}_VIB", f"{m[1]} condition-monitoring vibration", "mm/s") for m in rng_machines]
    q = spec["quality"]
    _write(out / "sensor_tags.csv", ["tag_id", "description", "unit"],
           vib_tags + [(q[0], q[1], q[2])])

    # --- hourly sensor readings (the main time-series) ---
    vb_mean, vb_std = spec["vib_baseline"]
    n_hours = sensor_days * 24
    start_ts = END - timedelta(hours=n_hours - 1)
    ts = [start_ts + timedelta(hours=i) for i in range(n_hours)]
    vib_cols = {f"{m[3]}_VIB": _walk(vb_mean + random.uniform(-0.15, 0.2), vb_std, n_hours) for m in rng_machines}
    _write(out / "sensor_readings.csv", ["timestamp"] + list(vib_cols.keys()),
           [[ts[i].strftime("%Y-%m-%d %H:%M")] + [vib_cols[c][i] for c in vib_cols] for i in range(n_hours)])

    # --- daily tables ---
    day0 = (END - timedelta(days=daily_days - 1)).date()
    days = [day0 + timedelta(days=i) for i in range(daily_days)]

    qv = _walk(q[3], q[4], daily_days)
    _write(out / "inspection_readings.csv", ["date", q[0]],
           [[d.isoformat(), qv[i]] for i, d in enumerate(days)])

    mats = spec["materials"]
    mat_series = {m: [max(0, int(random.gauss(400, 200))) for _ in days] for m in mats}
    _write(out / "material_consumption.csv", ["date"] + mats,
           [[d.isoformat()] + [mat_series[m][i] for m in mats] for i, d in enumerate(days)])

    prods = spec["products"]
    prod_series = {p: [max(0, int(random.gauss(90, 45))) for _ in days] for p in prods}
    _write(out / "sales_history.csv", ["date"] + prods,
           [[d.isoformat()] + [prod_series[p][i] for p in prods] for i, d in enumerate(days)])

    # --- orders ---
    hist = []
    for i in range(n_history):
        od = END.date() - timedelta(days=random.randint(3, daily_days))
        promised = random.randint(3, 7)
        rush = random.random() < 0.2
        actual = max(1, promised + random.choice([-1, 0, 0, 1, 2]) - (1 if rush else 0))
        hist.append([f"ORD-{1000 + i}", od.isoformat(), random.randint(100, 1000),
                     random.choice(REGIONS), "yes" if rush else "no", promised, actual])
    _write(out / "order_history.csv",
           ["order_id", "order_date", "quantity", "destination_region", "rush_order", "promised_lead_days", "actual_lead_time_days"],
           hist)

    open_rows = []
    for i in range(n_open):
        due = END.date() + timedelta(days=random.randint(4, 12))  # future, so scheduling can be on-time
        open_rows.append([f"ORD-{2000 + i}", random.randint(100, 800), due.isoformat()])
    _write(out / "open_orders.csv", ["order_id", "quantity", "due_date"], open_rows)

    (out / "sop.txt").write_text(spec["sop"], encoding="utf-8")


def main():
    random.seed(42)
    for industry, spec in INDUSTRIES.items():
        generate(industry, spec, DATA / "small_data" / industry, sensor_days=10, daily_days=30, n_history=46, n_open=6)
        generate(industry, spec, DATA / "big_data" / industry, sensor_days=90, daily_days=120, n_history=200, n_open=20)
        # the simulator continues the time-series tables — seed it from the small set
        sim = DATA / "simulator_data" / industry
        sim.mkdir(parents=True, exist_ok=True)
        for f in ["sensor_readings.csv", "inspection_readings.csv", "material_consumption.csv", "sales_history.csv"]:
            (sim / f).write_bytes((DATA / "small_data" / industry / f).read_bytes())
        print(f"generated {industry}: small + big + simulator_data")


if __name__ == "__main__":
    main()
