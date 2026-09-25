"""Writes the small Parquet and Arrow fixtures used by tests/connect.test.ts."""
import datetime as dt
import pathlib

import pyarrow as pa
import pyarrow.feather as feather
import pyarrow.parquet as pq

here = pathlib.Path(__file__).parent
t0 = dt.datetime(2024, 1, 1, tzinfo=dt.timezone.utc)
table = pa.table(
    {
        "time": pa.array([t0 + dt.timedelta(seconds=i) for i in range(5)], pa.timestamp("ms", tz="UTC")),
        "DBTM": pa.array([2500.0, 2500.1, 2500.2, None, 2500.4], pa.float64()),
        "ROPA": pa.array([20.5, 21.0, 19.5, 22.0, 18.0], pa.float32()),
        "well": pa.array(["F-12"] * 5),
    }
)
pq.write_table(table, here / "rig.parquet", compression="snappy")
table_us = table.set_column(0, "time", table.column("time").cast(pa.timestamp("us", tz="UTC")))
feather.write_feather(table_us, here / "rig.arrow", compression="uncompressed")
