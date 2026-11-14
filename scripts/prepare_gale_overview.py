"""Build an offline Gale Crater overview from two NASA JPL Mars Trek products."""

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
import math
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "src" / "galeOverview.json").read_text(encoding="utf-8"))
SIZE = 256


def tile(product, zoom, row, col, extension):
    address = (
        f"https://trek.nasa.gov/tiles/Mars/EQ/{product}/1.0.0"
        f"/default/default028mm/{zoom}/{row}/{col}.{extension}"
    )
    for attempt in range(3):
        try:
            with urlopen(address, timeout=15) as response:
                image = Image.open(BytesIO(response.read())).convert("RGBA")
                if image.size != (SIZE, SIZE):
                    raise ValueError(f"Invalid tile dimensions: {address}")
                return image
        except HTTPError as error:
            if error.code == 404 and extension == "png":
                return None
            if error.code < 500 or attempt == 2:
                raise
        except OSError:
            if attempt == 2:
                raise


def build(config, zoom, with_relief):
    bounds = config["bounds"]
    pixels_per_degree = SIZE * 2**zoom / 180
    left = (bounds["west"] + 180) * pixels_per_degree
    right = (bounds["east"] + 180) * pixels_per_degree
    top = (90 - bounds["north"]) * pixels_per_degree
    bottom = (90 - bounds["south"]) * pixels_per_degree
    first_col = math.floor(left / SIZE)
    first_row = math.floor(top / SIZE)
    last_col = math.ceil(right / SIZE) - 1
    last_row = math.ceil(bottom / SIZE) - 1
    cells = [(row, col) for row in range(first_row, last_row + 1) for col in range(first_col, last_col + 1)]

    def fetch(cell):
        row, col = cell
        optical = tile(CONFIG["optical"]["product"], zoom, row, col, "png")
        if with_relief:
            base = tile(CONFIG["relief"]["product"], zoom, row, col, "jpg")
            if optical is not None:
                base.alpha_composite(optical)
        else:
            if optical is None:
                raise ValueError(f"Missing landing-region CTX tile at {row}/{col}")
            base = optical
        return ((col - first_col) * SIZE, (row - first_row) * SIZE), base, optical is not None

    count = 0
    mosaic = Image.new("RGBA", ((last_col - first_col + 1) * SIZE, (last_row - first_row + 1) * SIZE))
    with ThreadPoolExecutor(max_workers=8) as workers:
        for offset, image, has_optical in workers.map(fetch, cells):
            mosaic.paste(image, offset)
            count += has_optical
    if not count:
        raise ValueError("No CTX tiles found in the Gale window")

    crop = (left - first_col * SIZE, top - first_row * SIZE, right - first_col * SIZE, bottom - first_row * SIZE)
    output_size = (round(right - left), round(bottom - top))
    output = mosaic.transform(output_size, Image.Transform.EXTENT, crop, Image.Resampling.BICUBIC)
    if output.getchannel("A").getextrema() != (255, 255):
        raise ValueError(f"Unexpected coverage gap in {config['image']}")
    destination = ROOT / "public" / "gale" / config["image"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    output.convert("RGB").save(destination, quality=88, method=6)
    print(f"Saved {destination.name} ({output.width} x {output.height}) from {count} CTX tiles")


def save_rover_track():
    terrain = json.loads((ROOT / "public" / "gale" / "terrain.json").read_text(encoding="utf-8"))
    start = terrain["positions"]["base"]
    stop = terrain["positions"]["science"]
    with urlopen(CONFIG["roverSource"], timeout=15) as response:
        features = json.load(response)["features"]

    def matches(point, waypoint):
        lon, lat, *_ = point
        return abs(lon - waypoint["longitude"]) < 0.000001 and abs(lat - waypoint["latitude"]) < 0.000001

    track = []
    collecting = False
    for feature in features:
        geometry = feature["geometry"]
        if geometry["type"] == "MultiLineString":
            segments = geometry["coordinates"]
        elif geometry["type"] == "LineString":
            segments = [geometry["coordinates"]]
        else:
            continue
        for segment in segments:
            points = []
            for point in segment:
                collecting = collecting or matches(point, start)
                if not collecting:
                    continue
                points.append(point[:2])
                if matches(point, stop):
                    if len(points) > 1:
                        track.append(points)
                    destination = ROOT / "src" / "curiosityTrack.json"
                    destination.write_text(json.dumps(track, separators=(",", ":")) + "\n", encoding="utf-8")
                    print(f"Saved Curiosity Sol {start['sol']}–{stop['sol']} track in {len(track)} archived segments")
                    return
            if len(points) > 1:
                track.append(points)
    raise ValueError("The archived segment ending at Yellowknife Bay was not found")

def save_rocknest_photo():
    address = ("https://assets.science.nasa.gov/content/dam/science/psd/photojournal"
               "/pia/pia16/pia16204/PIA16204.jpg")
    with urlopen(address, timeout=15) as response:
        image = Image.open(BytesIO(response.read())).convert("RGB")
    image.thumbnail((640, 360))
    image.save(ROOT / "public" / "gale" / "rocknest.webp", quality=85, method=6)


if __name__ == "__main__":
    build(CONFIG, zoom=8, with_relief=True)
    build(CONFIG["region"], zoom=12, with_relief=False)
    save_rover_track()
    save_rocknest_photo()
