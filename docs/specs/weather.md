# Feature: weather by the user's location

Research notes with sources: docs/specs/research-weather.md (Open-Meteo terms and limits, location sources, privacy, pitfalls).

Owner's words: "The weather should change according to that of the users location. we can use a weather api."

Each person sees THEIR OWN local weather and time of day in their view of the office (not shared).

## Location
- Sources in priority: manual city (Settings > Weather: search via Open-Meteo geocoding through the
  server proxy) > browser geolocation (only after the user clicks "Use my location"; timeout 10 s) >
  IP location from trusted proxy headers when GEO_HEADERS=cloudflare (the Worker sets cf.latitude/
  longitude/city/timezone as x-workchop-geo-* headers after DELETING any incoming copies; the Node
  server trusts them only when GEO_HEADERS is set — same model as CLIENT_IP_HEADER; decode city UTF-8)
  > none (fixed pleasant daytime, no weather effects). Show which source is used.
- Privacy: round coordinates to 0.1° before they leave the browser and before upstream calls; never
  store raw GPS server-side; store only rounded cell + city label in localStorage (members: optionally
  in profile). Settings toggle "Show my local weather" (default on) and units °C/°F (default by locale).

## Server proxy
- GET /api/weather?lat=&lon= (rounded) → {code, isDay, tempC, cloudCover, precipitation, rain,
  snowfall, windKph, sunrise?/sunset? (or compute with suncalc pinned 2.0.2 — degrees API), utcOffset,
  fetchedAt}. Upstream Open-Meteo forecast `current=` ≤10 variables (weight 1), timezone=auto,
  timeformat=unixtime. In-memory cache by cell, TTL 15 min + jitter, single-flight per cell, global
  concurrency 1-2 upstream requests (free tier concurrency limit), stale-while-error up to 3 h, 429 →
  back off until the UTC minute/hour/day boundary named in the reason, daily budget counter (~8000,
  reset 00:00 UTC). OPEN_METEO_API_KEY switches to customer-api.open-meteo.com (and the customer
  geocoding host) with X-Api-Key header. GET /api/weather/places?q= for city search (geocoding proxy).
- Attribution: visible "Weather data by Open-Meteo.com" link in the weather popover (CC BY 4.0) and
  "Location data based on GeoNames" for city search. README: free API is non-commercial only; set
  OPEN_METEO_API_KEY for commercial use.

## In the scene (client/src/world/Environment.tsx etc.)
- Time of day from the user's local clock + sun position (suncalc for their location): sky colour,
  directional light colour/intensity/angle, ambient level; night → darker scene, lamps and monitors
  glow more (coordinate: lamps may be added by the world feature — just lower global light).
- Weather effects: clear (sun, maybe light rays), partly cloudy/overcast (soft cloud shadows drifting
  over the floor via a moving shadow texture or drei <Cloud>, dimmer light), fog (scene fog), drizzle/
  rain (instanced rain streaks around/over the office with a subtle wet sheen; splashes optional),
  snow (falling snowflakes, slow drift), thunderstorm (rain + occasional lightning flash), wind affects
  particle drift and plant sway. Performance: instanced meshes, cap particle counts, reduce on mobile
  and when prefers-reduced-motion. Effects visible but not obstructing (mostly around the building
  edges / above head height).
- Weather chip in the top bar: icon (Hugeicons weather glyphs: sun, cloud, cloud-rain, snow, thunder,
  fog, moon), temperature, city; click → popover with details, source, change location, attribution.
- Optional: others can see your local weather/time on your people-panel row ("☀ 24° · 3:14 pm") only
  if you opt in (default off).

## Tests
Unit: WMO code → condition mapping (0-99, unknown → cloudy), rounding, cache/single-flight/backoff
logic with a fake fetch, geo header trust rules. Browser: stub /api/weather responses per condition
(route in Playwright) and screenshot clear day, night, rain, snow, thunder, fog in light and dark UI;
check FPS isn't destroyed (e.g. measure frame time over 3 s with rain on).
