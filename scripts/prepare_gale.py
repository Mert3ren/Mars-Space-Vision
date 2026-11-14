"""Build the static Gale demo from small windows of the original mission products."""

from datetime import date
from io import BytesIO
import json
import math
from pathlib import Path
import urllib.request

import certifi
import numpy as np
from PIL import Image, ImageOps
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import from_bounds


DESTINATION = Path(__file__).resolve().parents[1] / "public" / "gale"
WEST, SOUTH, EAST, NORTH = 8146500, -272550, 8147500, -271550
RADIUS_M = 3396190
GRID_SIZE = 100
IMAGE_SIZE = 1000
S3 = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/"
DEM_URL = S3 + "MSL_Gale_DEM_Mosaic_1m_v3.tif"
OPTICAL_URL = S3 + "MSL_Gale_HiRISE-LRGB_78quads_sharp_cog.tif"
THERMAL_URL = (
    "https://trek.nasa.gov/tiles/Mars/EQ/THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018"
    "/1.0.0/default/default028mm/9/269/902.png"
)
WAYPOINTS_URL = "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json"
SCIENCE_URL = "https://science.nasa.gov/photojournal/curiosity-traverse-map-sol-130/"
MASTCAM_URL = ("https://assets.science.nasa.gov/content/dam/science/psd/photojournal"
               "/pia/pia16/pia16706/PIA16706.jpg")


def read_url(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read()


def local_rasters(destination):
    with rasterio.Env(
        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
        CPL_CURL_CA_BUNDLE=certifi.where(),
        GDAL_HTTP_TIMEOUT="45",
        GDAL_HTTP_MAX_RETRY="2",
        GDAL_HTTP_RETRY_DELAY="1",
    ):
        with rasterio.open(DEM_URL) as source:
            print(f"Reading DEM window from {source.width} x {source.height} source", flush=True)
            window = from_bounds(WEST, SOUTH, EAST, NORTH, source.transform)
            elevation = source.read(
                1, window=window, out_shape=(GRID_SIZE, GRID_SIZE),
                masked=True, resampling=Resampling.nearest,
            )
        with rasterio.open(OPTICAL_URL) as source:
            print("Reading HiRISE optical window", flush=True)
            window = from_bounds(WEST, SOUTH, EAST, NORTH, source.transform)
            rgb = source.read(
                (1, 2, 3), window=window, out_shape=(3, IMAGE_SIZE, IMAGE_SIZE),
                resampling=Resampling.average,
            ).transpose(1, 2, 0)
            if np.count_nonzero(rgb.max(axis=2)) < 0.2 * IMAGE_SIZE ** 2:
                raise ValueError("The optical crop is mostly empty")
            # Display-only contrast. The original RGB bands are independent of routing.
            image = Image.fromarray(rgb)
            ImageOps.autocontrast(image, cutoff=0.7).save(
                destination / "optical.webp", quality=88, method=6
            )
    return elevation


def thermal_image(destination):
    print("Cropping Mars Trek THEMIS scene", flush=True)
    image = Image.open(BytesIO(read_url(THERMAL_URL))).convert("L")
    tile_degrees = 180 / 2 ** 9
    tile_west = -180 + 902 * tile_degrees
    tile_north = 90 - 269 * tile_degrees
    px_per_degree = 256 / tile_degrees

    def px(x):
        return (math.degrees(x / RADIUS_M) - tile_west) * px_per_degree

    def py(y):
        return (tile_north - math.degrees(y / RADIUS_M)) * px_per_degree

    crop = (px(WEST), py(NORTH), px(EAST), py(SOUTH))
    if not (0 <= crop[0] < crop[2] <= image.width and 0 <= crop[1] < crop[3] <= image.height):
        raise ValueError("THEMIS tile does not cover the mission window")
    if image.crop(tuple(round(value) for value in crop)).getextrema() == (0, 0):
        raise ValueError("THEMIS crop is empty")
    gray = image.transform((400, 400), Image.Transform.EXTENT, crop, Image.Resampling.BILINEAR)
    gray = ImageOps.autocontrast(gray, cutoff=1)
    color = ImageOps.colorize(gray, "#302047", "#ffc06b", "#ac4e50")
    color.save(destination / "thermal.webp", quality=90, method=6)


def main():
    DESTINATION.mkdir(parents=True, exist_ok=True)
    elevation = local_rasters(DESTINATION)
    thermal_image(DESTINATION)
    photo = Image.open(BytesIO(read_url(MASTCAM_URL))).convert("RGB")
    photo.thumbnail((740, 460))
    photo.save(DESTINATION / "sheepbed.webp", quality=85, method=6)
    print("Building terrain and mission manifest", flush=True)
    mask = np.ma.getmaskarray(elevation) | ~np.isfinite(elevation.data)
    values = [
        None if invalid else round(float(value), 2)
        for value, invalid in zip(elevation.data.flat, mask.flat)
    ]
    features = json.loads(read_url(WAYPOINTS_URL))["features"]
    positions = {}
    for key, sol, rmc in [("base", 3, "2_0"), ("science", 130, "5_1662")]:
        feature = next(
            feature for feature in features
            if feature["properties"]["sol"] == sol and feature["properties"]["RMC"] == rmc
        )
        longitude, latitude, *_ = feature["geometry"]["coordinates"]
        x = math.radians(longitude) * RADIUS_M
        y = math.radians(latitude) * RADIUS_M
        column = int((x - WEST) // 10)
        row = int((NORTH - y) // 10)
        assert 0 <= row < GRID_SIZE and 0 <= column < GRID_SIZE
        sample = values[row * GRID_SIZE + column]
        assert sample is not None and abs(sample - feature["properties"]["elev_geoid"]) < 5
        positions[key] = {"latitude": latitude, "longitude": longitude, "sol": sol}
    data = {
        "bounds": {"west": WEST, "south": SOUTH, "east": EAST, "north": NORTH},
        "radiusM": RADIUS_M,
        "width": GRID_SIZE,
        "height": GRID_SIZE,
        "cellM": 10,
        "elevationM": values,
        "positions": positions,
        "retrievedAt": date.today().isoformat(),
        "sources": [
            {
                "title": "Gale merged elevation model", "mission": "USGS / NASA / ESA",
                "product": "MSL_Gale_DEM_Mosaic_1m_v3",
                "resolution": "1 m product spacing · 10 m routing grid",
                "role": "Elevation profile, slope and route calculation",
                "limit": "Mixed-resolution input. Small obstacles and traction are unresolved.",
                "credit": "Timothy Parker and Fred J. Calef III / USGS Astrogeology",
                "url": "https://astrogeology.usgs.gov/search/map/mars_msl_gale_merged_dem_1m",
                "dataUrl": DEM_URL,
            },
            {
                "title": "Gale HiRISE orthophoto", "mission": "Mars Reconnaissance Orbiter",
                "product": "MSL_Gale_HiRISE-LRGB_78quads_sharp_cog",
                "resolution": "0.25 m source spacing · ~1 m web image",
                "role": "Optical map and surface context",
                "limit": "Windowed and contrast-stretched for display.",
                "credit": "NASA / JPL-Caltech / University of Arizona / USGS",
                "url": "https://astrogeology.usgs.gov/search/map/mars_msl_gale_merged_orthophoto_mosaic_25cm",
                "dataUrl": OPTICAL_URL,
            },
            {
                "title": "THEMIS daytime infrared", "mission": "Mars Odyssey · NASA JPL Mars Trek",
                "product": "THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018",
                "resolution": "~100 m source spacing · enlarged for display",
                "role": "Historical infrared context along the traverse",
                "limit": "Locally contrast-stretched and colorized relative image brightness, not temperature.",
                "credit": "NASA / JPL-Caltech / ASU / USGS · Mars Trek",
                "url": "https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars",
                "dataUrl": THERMAL_URL,
                "challengeResource": True,
            },
            {
                "title": "Curiosity waypoint record", "mission": "Mars Science Laboratory",
                "product": "MSL_waypoints · Sol 3 and Sol 130",
                "resolution": "Historical rover waypoints",
                "role": "Reference positions for the simulated base and science stop",
                "limit": "The planned traverse is a simulated EVA, separate from the rover record.",
                "credit": "NASA / JPL-Caltech",
                "url": SCIENCE_URL,
                "dataUrl": WAYPOINTS_URL,
            },
        ],
    }
    (DESTINATION / "terrain.json").write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"Packaged {len(values) - int(mask.sum()):,} valid cells in {DESTINATION}", flush=True)


if __name__ == "__main__":
    main()
