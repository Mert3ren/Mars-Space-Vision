# Mars Space Vision

An educational Marswalk planner for NASA Space Apps Challenge 2026. Plan a simulated round trip between Bradbury Landing and Yellowknife Bay in Gale Crater using real orbital and rover mission products.

## Run locally

Node.js 20.19+ or 22.12+ is required. The original Mars rasters are not needed to run the application.

```sh
npm ci
npm run dev
```

Open the local address printed by Vite. Run `npm test` to check the terrain and resource model, and `npm run build` to create the static `dist` directory. To run that directory offline, use `py -m http.server 8080 --bind 127.0.0.1 --directory dist` on Windows and open `http://127.0.0.1:8080/`. The built app uses relative URLs and can be hosted as a static website.

## Demo

1. Start in **Full crater**. Select the landing marker to see the **Landing region** (8 km × 8 km), then select **EVA study area** to open **Traverse** (1 km × 1 km). The default round trip is about **0.93 km**.
2. Switch from **Optical** to **Slope** and **Thermal**. Open **Data sources** to see the NASA JPL Mars Trek product used for the challenge.
3. Toggle **Curiosity** to compare the historical rover track with the planned EVA. Click the map to inspect coordinates and, within the EVA grid, elevation and slope.
   Switch to **3D** to orbit the actual terrain with the same imagery. The crater and landing region use USGS MOLA–HRSC elevation, while **Traverse** uses the existing 10 m EVA elevation samples and drapes the route over them. The viewer labels the vertical exaggeration and requires WebGL 2.
   In **3D → Traverse**, select a line's arrival label or a **Mission route** card to compare the direct walk and the two alternatives via simulated ground stations. Arrival times are minutes since departure at the example 2 km/h walking speed. In **2D**, **Map pins** shows the stations and archived Curiosity photo locations. [Mastcam Sol 52](https://science.nasa.gov/photojournal/rocknest-from-sol-52-location/) · [Navcam Sol 133](https://science.nasa.gov/resource/sol-0133-left-navigation-camera-cylindrical-perspective/)
4. Open **Return reserve** to compare mission time with the reserve limit and see how much oxygen and battery remain at base. On Route A, **Simulate 40 min delay** changes the modeled margin from **+27 min** to **−13 min**. Remove the delay or apply the suggested science-stop duration. **Model settings** controls starting levels and the minimum return percentage.
5. In **Mission route**, choose **Balanced**, **Shortest**, or **Gentler** and set the modeled slope cap. Compare time to the stop, round-trip distance, peak step slope, and the current return reserve before selecting a route.
6. Start an EVA on **Route B** and use **Simulate SPE** around minute 6. Compare reachable terrain cover candidates and the base route, adjust the drill target from 3 to 5 minutes, and preview or walk the selected route. At departure, the drill shows the no-candidate state when no natural cover point meets the target.

The SPE drill estimates obstructed sky from 16 horizon directions over a 150 m radius using the 10 m Gale elevation grid. The 3% display cutoff is a simulation assumption. Sky obstruction describes terrain geometry. Particle dose and protective performance require separate modeling. [Curiosity RAD terrain study](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2021JE006851)

## Scientific data

- Gale merged elevation model by Timothy Parker and Fred J. Calef III, USGS Astrogeology. Sampled at 10 m for slope and routing. [Product](https://astrogeology.usgs.gov/search/map/mars_msl_gale_merged_dem_1m)
- Gale HiRISE color mosaic, NASA/JPL-Caltech/University of Arizona/USGS. A cropped, contrast-adjusted optical basemap. [Product](https://astrogeology.usgs.gov/search/map/mars_msl_gale_merged_orthophoto_mosaic_25cm)
- Mars Odyssey THEMIS day IR, obtained through the challenge-listed NASA JPL **Mars Trek** service. Historical infrared context aligned with the route. Relative brightness is not a temperature reading. [NASA Mars Trek catalogue](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars)
- NASA/JPL-Caltech Curiosity Sol 3 and Sol 130 waypoints, and NASA/JPL-Caltech/MSSS Mastcam PIA16706. [Waypoints](https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json) · [Mastcam](https://science.nasa.gov/photojournal/spherules-in-yellowknife-bay/)

Data preparation is reproducible with Python 3.11. Run `py -m pip install rasterio numpy Pillow`, then `py scripts/prepare_gale.py` for the detail window and `py scripts/prepare_gale_overview.py` for the offline crater and landing-region mosaics and the archived Curiosity route segment. [Mars Trek map services](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars) · [Curiosity track](https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_traverse.json)

Run `py scripts/prepare_gale_elevation.py` to regenerate the packaged crater and landing-region 3D elevation grids from the [USGS MOLA–HRSC DEM](https://astrogeology.usgs.gov/search/map/mars_mgs_mola_mex_hrsc_blended_dem_global_200m).

The map uses [Leaflet](https://leafletjs.com/), the application uses [React](https://react.dev/) and [Vite](https://vite.dev/), and interface symbols use [Lucide](https://lucide.dev/). Original data and third-party assets retain their respective terms and credits. Codex assisted with project planning, implementation and verification. The app does not call an AI service. Routing thresholds, simulated consumable rates and the fictional base are training assumptions.

## Project summary for Space Apps

Mars Space Vision helps a future Mars explorer plan a science walk from Bradbury Landing to Yellowknife Bay and back. Gale elevation data shape the route, HiRISE supplies the optical basemap, and NASA JPL Mars Trek supplies the Mars Odyssey THEMIS infrared layer. A Curiosity science stop and a simulated return budget show how a fieldwork delay can change the plan.

See [SISTEM_MIMARISI.md](SISTEM_MIMARISI.md) for the implementation details and demo script.
