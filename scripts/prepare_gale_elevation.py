"""Package only the Gale windows of the USGS MOLA–HRSC elevation model."""

import json
from pathlib import Path

import certifi
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

ROOT = Path(__file__).resolve().parents[1]
PRODUCT = "Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif"
URL = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/HRSC_MOLA_Blend/" + PRODUCT
CONFIG = json.loads((ROOT / "src" / "galeOverview.json").read_text(encoding="utf-8"))


def sample(source, bounds, size):
    window = from_bounds(bounds["west"], bounds["south"], bounds["east"], bounds["north"], source.transform)
    data = source.read(1, window=window, out_shape=(size, size), masked=True, resampling=Resampling.bilinear)
    mask = np.ma.getmaskarray(data)
    if mask.any() or not np.isfinite(data.data).all():
        raise ValueError("Unexpected elevation coverage gap in the Gale window")
    return {
        "width": size, "height": size,
        "elevationM": [int(value) for value in data.data.flat],
    }


def main():
    with rasterio.Env(
        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
        CPL_CURL_CA_BUNDLE=certifi.where(),
        GDAL_HTTP_TIMEOUT="35",
        GDAL_HTTP_MAX_RETRY="2",
    ):
        with rasterio.open(URL) as source:
            if not source.crs.is_geographic or not (0.003 < source.transform.a < 0.004):
                raise ValueError("Expected geographic 200 m Mars raster")
            print("Reading the Gale Crater window", flush=True)
            crater = sample(source, CONFIG["bounds"], 220)
            print("Reading the landing region window", flush=True)
            region = sample(source, CONFIG["region"]["bounds"], 41)
    target = ROOT / "public" / "gale" / "elevation-overview.json"
    target.write_text(json.dumps({"crater": crater, "region": region}, separators=(",", ":")), encoding="utf-8")
    for name, grid in (("Crater", crater), ("Landing region", region)):
        print(f"{name}: {grid['width']} x {grid['height']} cells, {min(grid['elevationM'])} to {max(grid['elevationM'])} m")


if __name__ == "__main__":
    main()
