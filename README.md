# Test datasets

Organised by size, then by industry. These are source files you upload into a
company during discovery — the product never reads this folder directly at
runtime (uploaded files are copied into `backend/uploads/<project_id>/`). The one
exception is the factory data simulator, which seeds from `simulator_data/`.

```
data/
  small_data/<industry>/     full small dataset for quick discovery + training tests
  big_data/<industry>/       large datasets for stress-testing parse + training
  simulator_data/<industry>/ the time-series tables the factory data simulator feeds
                             (sensor/inspection readings — one row per timestamp)
```

Add a new industry by creating a folder under each (e.g. `small_data/textile/`).
The simulator auto-detects which files are time-series (a date/time first column
with numeric columns after it), so it works for any industry without code changes
— just point its `SEED_DIR` at that industry's `simulator_data` folder.
