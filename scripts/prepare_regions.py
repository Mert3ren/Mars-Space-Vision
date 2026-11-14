"""Package only the Gale and Boxwork raster windows used by the simulation."""

from datetime import date
from pathlib import Path
import json

import certifi
import numpy as np
from PIL import Image, ImageOps
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

from prepare_gale import DEM_URL, OPTICAL_URL, RADIUS_M, WAYPOINTS_URL, read_url

PUBLIC = Path(__file__).resolve().parents[1] / "public"
GALE = (8146500, -272550, 8147500, -271550)
BOXWORK = (8142675, -285300, 8143675, -284300)


def encode_grid(values, destination, cell_m):
    values = values.filled(np.nan)
    valid = np.isfinite(values)
    grid = np.full(values.shape, -32768, dtype="<i2")
    reference = round(float(np.median(values[valid])))
    relative = np.rint((values[valid] - reference) * 100)
    if np.max(np.abs(relative)) >= 32767:
        raise ValueError("Elevation outside encodable range")
    grid[valid] = relative.astype(np.int16)
    grid.tofile(destination / "helmet-elevation.bin")
    (destination / "helmet-grid.json").write_text(json.dumps({
        "width": values.shape[1], "height": values.shape[0], "cellM": cell_m, "reference": reference,
    }), encoding="utf-8")


def main():
    boxwork = PUBLIC / "boxwork"
    boxwork.mkdir(parents=True, exist_ok=True)
    with rasterio.Env(
        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_CURL_CA_BUNDLE=certifi.where(),
        GDAL_HTTP_TIMEOUT="45", GDAL_HTTP_MAX_RETRY="3", GDAL_HTTP_RETRY_DELAY="2",
    ):
        with rasterio.open(DEM_URL) as dem:
            for bounds, destination in [(GALE, PUBLIC / "gale"), (BOXWORK, boxwork)]:
                print(f"Reading {destination.name} elevation", flush=True)
                window = from_bounds(*bounds, dem.transform)
                elevation = dem.read(1, window=window, out_shape=(500, 500), masked=True, resampling=Resampling.bilinear)
                encode_grid(elevation, destination, 2)
                if destination == boxwork:
                    route = dem.read(1, window=window, out_shape=(200, 200), masked=True, resampling=Resampling.bilinear)
        with rasterio.open(OPTICAL_URL) as optical:
            for bounds, destination in [(GALE, PUBLIC / "gale"), (BOXWORK, boxwork)]:
                print(f"Reading {destination.name} imagery", flush=True)
                window = from_bounds(*bounds, optical.transform)
                rgb = optical.read((1, 2, 3), window=window, out_shape=(3, 2000, 2000), resampling=Resampling.average)
                image = ImageOps.autocontrast(Image.fromarray(rgb.transpose(1, 2, 0)), cutoff=0.5)
                image.save(destination / "helmet-optical.webp", quality=91, method=5)
                if destination == boxwork:
                    image.resize((1000, 1000), Image.Resampling.LANCZOS).save(boxwork / "optical.webp", quality=88)
    features = json.loads(read_url(WAYPOINTS_URL))["features"]
    positions = {}
    for key, sol, rmc in [("base", 4580, "117_420"), ("science", 4655, "118_2538")]:
        feature = next(f for f in features if f["properties"]["sol"] == sol and f["properties"]["RMC"] == rmc)
        longitude, latitude, *_ = feature["geometry"]["coordinates"]
        positions[key] = {"latitude": latitude, "longitude": longitude, "sol": sol}
    values = [round(float(v), 2) if np.isfinite(v) else None for v in route.filled(np.nan).flat]
    sources = json.loads((PUBLIC / "gale" / "terrain.json").read_text(encoding="utf-8"))["sources"][:2]
    sources[0]["resolution"] = "1 m product spacing · 5 m routing grid · 2 m helmet grid"
    sources[1]["resolution"] = "0.25 m source spacing · 0.5 m helmet imagery"
    west, south, east, north = BOXWORK
    payload = {
        "region": "boxwork", "bounds": dict(west=west, south=south, east=east, north=north),
        "radiusM": RADIUS_M, "width": 200, "height": 200, "cellM": 5, "positions": positions,
        "elevationM": values, "retrievedAt": date.today().isoformat(), "sources": sources,
    }
    (boxwork / "terrain.json").write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print("Regional data ready", flush=True)


if __name__ == "__main__":
    main()
